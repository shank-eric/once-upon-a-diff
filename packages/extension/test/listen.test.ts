import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListenOption, listenError } from '../src/content/listen.ts';
import { createClient, type CallRequest } from '@once-upon-a-diff/api-client/client';
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
  const { call, calls } = fake({ ok: true, status: 200, body: { sessions } });
  const listen = createListenOption(call, 'acme-widgets-7');
  assert.deepEqual(await listen.sessions({ scope: 'repo', repo: 'acme/widgets' }), sessions);
  assert.deepEqual(await listen.sessions({ scope: 'story' }), sessions);
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
    body: { sessions: [{ id: 's1', title: 'tab', status: 'idle', since: null }], ok: true },
  });
  const listen = createListenOption(call);
  assert.equal((await listen.sessions({ scope: 'repo', repo: 'acme/widgets' })).length, 1);
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
