import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, startBridge, TOKEN } from './helpers.ts';
import { pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';

/** A bridge that keeps what it logs. */
async function loggedBridge() {
  const lines: string[] = [];
  const bridge = await startBridge({ home: tmp('home'), log: (line) => lines.push(line) });
  return { bridge, lines };
}

test('a malformed /local path is a 400 and logs no stack', async () => {
  const { bridge, lines } = await loggedBridge();
  try {
    const page = await bridge.call('GET', '/local/%E0%A4%A/', undefined, { Authorization: '' });
    assert.equal(page.status, 400);
    assert.deepEqual(lines, []);
  } finally {
    await bridge.close();
  }
});

test('a malformed story id is a 400 with the token and with a page key, and logs no stack', async () => {
  const { bridge, lines } = await loggedBridge();
  try {
    const withToken = await bridge.call('GET', '/api/stories/%zz/story');
    assert.equal(withToken.status, 400);
    const withKey = await bridge.call('GET', '/api/stories/%zz/story', undefined, {
      Authorization: `Bearer ${pageKey(TOKEN, 'x')}`,
    });
    assert.equal(withKey.status, 400);
    assert.deepEqual(lines, []);
  } finally {
    await bridge.close();
  }
});
