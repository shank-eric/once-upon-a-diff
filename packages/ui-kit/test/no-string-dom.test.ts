/*
 * Where ui writes into the DOM by hand. These files moved here from the panel with their pins: a new write anywhere else in ui
 * fails, and a file's count can only fall. Each write counts, not each line. The pattern and its probes are the panel's
 * (the test kit's dom-writes.ts, probed in panel/test/no-string-dom.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, writesIn } from '@once-upon-a-diff/test-kit/dom-writes';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** file (under src): [how many hand writes, why]. A count can only fall. */
const ALLOWED: Record<string, [number, string]> = {
  'dom.ts': [
    12,
    'the helpers the extension and the local page use (key isolation, waiting for styles, a shadow root of our own)',
  ],
  'components/menu.ts': [
    9,
    'the popover menu: it makes a root of its own at the end of the body, places the menu under its button, and listens for keys, clicks and scrolls elsewhere',
  ],
  'parse-markup.ts': [2, 'reads markup into a detached template'],
  'listen.ts': [
    17,
    'wireStartListening, which the extension’s listen notice still uses (the panel has its own, with state)',
  ],
};

test('ui writes into the DOM by hand only where it says it does', () => {
  const found: Record<string, number> = {};
  for (const file of files(SRC)) {
    const count = writesIn(readFileSync(file, 'utf8'));
    if (count) {
      found[path.relative(SRC, file)] = count;
    }
  }
  const pinned = Object.fromEntries(
    Object.entries(ALLOWED)
      .filter(([, [count]]) => count > 0)
      .map(([file, [count]]) => [file, count]),
  );
  assert.deepEqual(found, pinned);
});
