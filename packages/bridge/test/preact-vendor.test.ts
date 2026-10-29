import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startBridge, tmp } from './helpers.ts';

const vendor = (name: string) =>
  readFileSync(new URL(`../public/vendor/${name}`, import.meta.url), 'utf8');
const bridgePackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the vendored Preact is the file its checksum names, built from the versions package.json pins', () => {
  const file = vendor('preact.mjs');
  assert.equal(
    vendor('preact.mjs.sha256').trim(),
    `${createHash('sha256').update(file).digest('hex')}  preact.mjs`,
    'rebuild it with yarn vendor, never edit it by hand',
  );
  const { preact, htm } = bridgePackage.devDependencies;
  assert.match(preact, /^\d+\.\d+\.\d+$/, 'an exact version');
  assert.match(htm, /^\d+\.\d+\.\d+$/, 'an exact version');
  assert.ok(file.startsWith(`// Preact ${preact} (MIT`), 'the header names the pinned Preact');
  assert.ok(file.split('\n')[0].includes(`htm ${htm} (Apache-2.0`), 'and the pinned htm');
  assert.match(vendor('preact-LICENSE'), /MIT License/i);
  assert.match(vendor('htm-LICENSE'), /Apache License/i);
});

test('the vendored Preact needs no unsafe-eval, and exports what the components import', async () => {
  const file = vendor('preact.mjs');
  assert.ok(
    !/\beval\s*\(|new Function|\bFunction\s*\(/.test(file),
    'the pages’ policy has no unsafe-eval',
  );
  const urls = file.match(/https?:\/\/[^"'`\s]+/g) ?? [];
  assert.ok(
    urls.every((url) => url.startsWith('http://www.w3.org/')),
    `only XML namespace names, no URL it could load: ${urls.join(' ')}`,
  );
  assert.ok(!/\bfetch\(|XMLHttpRequest|\bimport\(/.test(file), 'it loads nothing from the network');
  const names = Object.keys(await import('../public/vendor/preact.mjs')).sort();
  assert.deepEqual(names, [
    'Component',
    'Fragment',
    'h',
    'html',
    'render',
    'useCallback',
    'useEffect',
    'useLayoutEffect',
    'useMemo',
    'useRef',
    'useState',
  ]);
});

test('the bridge serves Preact and the voice panel as JavaScript, with no key', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const path of [
      '/assets/preact.mjs',
      '/assets/local/voice-panel.ts',
      '/assets/local/stored.ts',
    ]) {
      const response = await fetch(`${bridge.base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') as string, /javascript/);
    }
    const panel = await (await fetch(`${bridge.base}/assets/local/voice-panel.ts`)).text();
    assert.ok(!/: BoardVoice|import type|VoicePanelProps =/.test(panel), 'its types are stripped');
    assert.match(panel, /from '\/assets\/preact\.mjs'/);
  } finally {
    await bridge.close();
  }
});
