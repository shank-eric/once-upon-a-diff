import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmp, startBridge, TOKEN } from './helpers.ts';

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const noToken = { Authorization: '' };
const proofFor = (port: string, nonce: string) =>
  createHmac('sha256', TOKEN).update(`once-upon-handshake:${port}:${nonce}`).digest('hex');

test('the handshake proves the token for this nonce and port, with no token sent', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    const port = new URL(bridge.base).port;
    const answer = await bridge.call<{ proof: string }>(
      'POST',
      '/auth/handshake',
      { nonce: NONCE },
      noToken,
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.proof, proofFor(port, NONCE));
    assert.ok(!answer.text.includes(TOKEN));
    const other = await bridge.call<{ proof: string }>(
      'POST',
      '/auth/handshake',
      { nonce: 'f'.repeat(32) },
      noToken,
    );
    assert.notEqual(other.body.proof, answer.body.proof, 'a proof is for its nonce');
    assert.notEqual(answer.body.proof, proofFor(String(Number(port) + 1), NONCE), 'and its port');
  } finally {
    await bridge.close();
  }
});

test('the handshake refuses a bad nonce, a body that is not JSON and a foreign Origin', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const nonce of ['', 'zz', 'a'.repeat(15), 'a'.repeat(65), 7]) {
      const answer = await bridge.call('POST', '/auth/handshake', { nonce }, noToken);
      assert.equal(answer.status, 400, JSON.stringify(nonce));
    }
    const plain = await bridge.call(
      'POST',
      '/auth/handshake',
      { nonce: NONCE },
      {
        ...noToken,
        'Content-Type': 'text/plain',
      },
    );
    assert.equal(plain.status, 415);
    const foreign = await bridge.call<{ error: string }>(
      'POST',
      '/auth/handshake',
      { nonce: NONCE },
      {
        ...noToken,
        Origin: 'https://evil.example',
      },
    );
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, 'origin not allowed');
    const mine = await bridge.call<{ error: string }>(
      'POST',
      '/auth/handshake',
      { nonce: NONCE },
      {
        ...noToken,
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      },
    );
    assert.equal(mine.status, 403);
    assert.match(
      mine.body.error,
      /origin not allowed: add abcdefghijklmnopabcdefghijklmnop to extension_ids/,
    );
  } finally {
    await bridge.close();
  }
});
