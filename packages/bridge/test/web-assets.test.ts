import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startBridge, tmp } from './helpers.ts';

test('the bridge serves highlight.js and the highlighter, with no CDN in the page', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const path of ['/assets/highlight.mjs', '/assets/syntax.ts']) {
      const response = await bridge.call('GET', path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') as string, /javascript/);
    }
    const local = readFileSync(new URL('../../web/public/local.ts', import.meta.url), 'utf8');
    assert.ok(
      !/https?:\/\//.test(local.replace(/\/\/.*$/gm, '')),
      'local.js loads nothing from the network',
    );
  } finally {
    await bridge.close();
  }
});

test('the bridge serves Preact and the voice panel as JavaScript, with no key', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const path of [
      '/assets/preact.mjs',
      '/assets/board/voice/voice-panel.ts',
      '/assets/local/stored.ts',
    ]) {
      const response = await fetch(`${bridge.base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') as string, /javascript/);
    }
    const panel = await (await fetch(`${bridge.base}/assets/board/voice/voice-panel.ts`)).text();
    assert.ok(!/: BoardVoice|import type|VoicePanelProps =/.test(panel), 'its types are stripped');
    assert.match(panel, /from '\/assets\/preact\.mjs'/);
  } finally {
    await bridge.close();
  }
});
