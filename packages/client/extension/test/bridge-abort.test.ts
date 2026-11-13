import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { callBridge, CALL_LIMIT_MS, REVIEW_LIMIT_MS } from '../src/content/bridge.ts';

/** A chrome.runtime whose 'bridge' calls stay out until the test answers them; `sent` has every message. */
function installChrome() {
  const sent: Array<Record<string, unknown>> = [];
  const answers: Array<(reply: unknown) => void> = [];
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: 'ext',
        sendMessage: (message: Record<string, unknown>) => {
          sent.push(message);
          if (message.type === 'bridge-abort') {
            return Promise.resolve();
          }
          return new Promise((resolve) => answers.push(resolve));
        },
      },
    },
  });
  return { sent, answers };
}

test('an aborted call answers "aborted" at once and tells the service worker to abort its fetch', async () => {
  const { sent, answers } = installChrome();
  const controller = new AbortController();
  const call = callBridge('GET', '/api/health', undefined, controller.signal);
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0].id, 'string', 'a call with a signal carries an id');
  controller.abort();
  assert.deepEqual(await call, { ok: false, status: 0, error: 'aborted' });
  assert.deepEqual(sent[1], { type: 'bridge-abort', id: sent[0].id });
  answers[0]({ ok: true, status: 200, body: {} }); // a late answer from the worker is ignored
});

test('a call already aborted sends nothing, and one without a signal still carries an id (the limit closes it)', async () => {
  const { sent, answers } = installChrome();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await callBridge('GET', '/api/health', undefined, controller.signal), {
    ok: false,
    status: 0,
    error: 'aborted',
  });
  assert.equal(sent.length, 0);
  const plain = callBridge('GET', '/api/health');
  assert.equal(typeof sent[0].id, 'string');
  answers[0]({ ok: true, status: 200, body: { up: 1 } });
  assert.equal((await plain).ok, true);
});

test('a call that is answered before any abort is not aborted afterwards', async () => {
  const { sent, answers } = installChrome();
  const controller = new AbortController();
  const call = callBridge('GET', '/api/health', undefined, controller.signal);
  answers[0]({ ok: true, status: 200, body: { up: 1 } });
  assert.equal((await call).ok, true);
  controller.abort();
  assert.equal(sent.length, 1, 'no abort message for a call that finished');
});

test('a call with no signal that the service worker never answers gives up after the limit and closes its fetch', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sent } = installChrome();
    const call = callBridge('POST', '/api/story/x/fixes', { action: 'send' });
    mock.timers.tick(CALL_LIMIT_MS - 1);
    assert.equal(sent.length, 1, 'not before the limit');
    mock.timers.tick(1);
    assert.deepEqual(await call, { ok: false, status: 0, error: 'timed out' });
    assert.deepEqual(sent[1], { type: 'bridge-abort', id: sent[0].id });
  } finally {
    mock.timers.reset();
  }
});

test('a call with no signal that is answered in time leaves no timer behind', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sent, answers } = installChrome();
    const call = callBridge('GET', '/api/health');
    answers[0]({ ok: true, status: 200, body: {} });
    assert.equal((await call).ok, true);
    mock.timers.tick(CALL_LIMIT_MS * 2);
    assert.equal(sent.length, 1, 'no abort message after the answer');
  } finally {
    mock.timers.reset();
  }
});

test('adding a draft to the review gets a longer limit than the rest, as the bridge may make three slow GitHub calls', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sent } = installChrome();
    const call = callBridge('POST', '/api/story/x/drafts', {
      action: 'review',
      chapter: 1,
      index: 0,
    });
    mock.timers.tick(CALL_LIMIT_MS * 2);
    assert.equal(sent.length, 1, 'still waiting past the usual limit');
    mock.timers.tick(REVIEW_LIMIT_MS - CALL_LIMIT_MS * 2);
    assert.deepEqual(await call, { ok: false, status: 0, error: 'timed out' });
  } finally {
    mock.timers.reset();
  }
});
