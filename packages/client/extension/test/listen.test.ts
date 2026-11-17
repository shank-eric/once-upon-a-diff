import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListenOption, listenError } from '../src/content/listen.ts';
import { createClient, type CallRequest } from '@once-upon-a-diff/bridge-client/client';
import type { BridgeAnswer } from '../src/content/bridge.ts';

/** A bridge client over a transport that records what it was asked and answers from `answer`. */
function fake(answer: BridgeAnswer) {
  const calls: CallRequest[] = [];
  const { call } = createClient(async (request) => {
    calls.push(request);
    return answer;
  });
  return { call, calls };
}

test('the repo’s sessions are asked by repo, and the story’s by the story’s id', async () => {
  const sessions = [{ id: 's1', title: 'tab', status: 'idle', since: null }];
  const body = {
    repo: 'acme/widgets',
    sessions,
    line: '/once-upon-listen acme/widgets --keep',
    storyLine: '/once-upon-listen --story acme-widgets-7 --keep',
    typing: true,
  };
  const { call, calls } = fake({ ok: true, status: 200, body });
  const listen = createListenOption(call, 'acme-widgets-7');
  const offer = { sessions, line: body.line, storyLine: body.storyLine, typing: true };
  assert.deepEqual(await listen.sessions({ scope: 'repo', repo: 'acme/widgets' }), offer);
  assert.deepEqual(await listen.sessions({ scope: 'story' }), offer);
  assert.deepEqual(
    calls.map((one) => [one.method, one.path]),
    [
      ['GET', '/api/board/listen-sessions?repo=acme%2Fwidgets'],
      ['GET', '/api/board/listen-sessions?story=acme-widgets-7'],
    ],
  );
});

test('starting sends the session and the repo or the story, never any text to type', async () => {
  const { call, calls } = fake({ ok: true, status: 200, body: { ok: true, typed: 'x' } });
  const listen = createListenOption(call, 'acme-widgets-7');
  await listen.start('s1', { scope: 'repo', repo: 'acme/widgets' });
  await listen.start('s2', { scope: 'story' });
  assert.deepEqual(
    calls.map((one) => [one.method, one.path, one.body]),
    [
      ['POST', '/api/board/type', { kind: 'listen', session: 's1', repo: 'acme/widgets' }],
      ['POST', '/api/board/type', { kind: 'listen', session: 's2', story: 'acme-widgets-7' }],
    ],
  );
});

test('a refusal rejects with the bridge’s own words, and the known failures get plain ones', async () => {
  const busy = createListenOption(
    fake({ ok: false, status: 409, error: 'session busy' }).call,
    'acme-widgets-7',
  );
  await assert.rejects(busy.start('s1', { scope: 'story' }), /^Error: session busy$/);
  await assert.rejects(busy.sessions({ scope: 'story' }), /^Error: session busy$/);
  const reasons: [Partial<BridgeAnswer>, RegExp][] = [
    [{ status: 0, error: 'unreachable' }, /bridge is not running/],
    [{ status: 0, error: 'extension reloaded' }, /reload this page/],
    [{ status: 0, error: 'not-configured' }, /no working bridge token/],
    [{ status: 401, error: 'missing or wrong token' }, /no working bridge token/],
    [{ status: 404, error: 'not found' }, /older than this panel.*restart it/],
    [{ status: 500, error: undefined }, /HTTP 500/],
    // what decides is the code (or, from an older bridge with none, the status), never the words
    [
      { status: 404, error: 'zzz', body: { error: 'zzz', code: 'no_route' } },
      /older than this panel/,
    ],
    [{ status: 404, error: 'zzz' }, /older than this panel/],
    [
      { status: 404, error: 'not found', body: { error: 'not found', code: 'not_found' } },
      /^not found$/,
    ],
  ];
  for (const [answer, text] of reasons) {
    assert.match(
      listenError({ ok: false, ...answer } as Extract<BridgeAnswer, { ok: false }>),
      text,
    );
  }
});

test('a page with no story (the notice on a PR list) asks and starts by repo, and has no story to listen for', async () => {
  const { call, calls } = fake({
    ok: true,
    status: 200,
    body: {
      sessions: [{ id: 's1', title: 'tab', status: 'idle', since: null }],
      line: '/once-upon-listen acme/widgets --keep',
      typing: true,
    },
  });
  const listen = createListenOption(call);
  assert.equal((await listen.sessions({ scope: 'repo', repo: 'acme/widgets' })).sessions.length, 1);
  await listen.start('s1', { scope: 'repo', repo: 'acme/widgets' });
  assert.deepEqual(
    calls.map((one) => [one.method, one.path, one.body]),
    [
      ['GET', '/api/board/listen-sessions?repo=acme%2Fwidgets', undefined],
      ['POST', '/api/board/type', { kind: 'listen', session: 's1', repo: 'acme/widgets' }],
    ],
  );
  await assert.rejects(listen.sessions({ scope: 'story' }), /no story to listen for/);
  await assert.rejects(listen.start('s1', { scope: 'story' }), /no story to listen for/);
  assert.equal(calls.length, 2, 'nothing was sent for the story');
});

test('queueing sends the repo or the story and never any text, and a page with no story can only queue a repo', async () => {
  const { call, calls } = fake({
    ok: true,
    status: 200,
    body: { ok: true, key: 'repo-acme-widgets', expires: 1 },
  });
  const listen = createListenOption(call, 'acme-widgets-7');
  await listen.queue!({ scope: 'repo', repo: 'acme/widgets' });
  await listen.queue!({ scope: 'story' });
  assert.deepEqual(
    calls.map((one) => [one.method, one.path, one.body]),
    [
      ['POST', '/api/board/listen-queue', { repo: 'acme/widgets' }],
      ['POST', '/api/board/listen-queue', { story: 'acme-widgets-7' }],
    ],
  );
  await assert.rejects(
    createListenOption(call).queue!({ scope: 'story' }),
    /no story to listen for/,
  );
  const refused = createListenOption(
    fake({ ok: false, status: 409, error: 'a session is already listening for that' }).call,
  );
  await assert.rejects(
    refused.queue!({ scope: 'repo', repo: 'acme/widgets' }),
    /^Error: a session is already listening for that$/,
  );
});
