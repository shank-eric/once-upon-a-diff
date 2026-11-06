import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callBridge } from '../src/content/bridge.ts';

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

test('a call already aborted sends nothing, and one without a signal carries no id', async () => {
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
  assert.ok(!('id' in sent[0]));
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
