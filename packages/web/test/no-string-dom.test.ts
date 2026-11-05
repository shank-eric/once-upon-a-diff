/*
 * The local page's confirm boxes draw with Preact (ActionDialog), so the files that hold them write into the DOM by hand only where
 * it says it does: a new write anywhere else in them fails, and a file's count can only fall. The rest of the page is still string
 * HTML (its own card), so only the box files are pinned here; the pattern and its probes are the test kit's (dom-writes.ts, probed
 * in panel/test/no-string-dom.test.ts). A box file also names none of the string-HTML helpers for its boxes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, writesIn } from '@once-upon-a-diff/test-kit/dom-writes';

const SHIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/local/ship');

/** file (under local/ship): [how many hand writes, why]. A count can only fall. */
const BOXES: Record<string, [number, string]> = {
  'action-dialog.ts': [
    3,
    'the one host element the box is drawn into: made, put on the page, and taken off when it closes',
  ],
  'push.ts': [
    2,
    'the header button (string HTML until the page is converted) and its listener for the approval changing',
  ],
  'push-ahead.ts': [0, 'nothing'],
  'pull-request.ts': [
    2,
    'the header button (string HTML until the page is converted) and the compare page’s address set on the tab it opened',
  ],
};

test('the box files write into the DOM by hand only where they say they do', () => {
  const found: Record<string, number> = {};
  for (const file of Object.keys(BOXES)) {
    found[file] = writesIn(readFileSync(path.join(SHIP, file), 'utf8'));
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(BOXES).map(([file, [count]]) => [file, count])),
  );
});

test('the boxes are drawn by ActionDialog: no box builds markup strings or its own dialog element', () => {
  for (const file of Object.keys(BOXES)) {
    const source = code(readFileSync(path.join(SHIP, file), 'utf8'));
    assert.ok(!/boxElement|commitListHtml|formHtml|doneHtml|standingHtml/.test(source), file);
    assert.ok(!/createElement\(['"]dialog/.test(source), `${file} makes its own dialog`);
    assert.ok(!/\.(innerHTML|outerHTML)\b|dangerouslySetInnerHTML/.test(source), file);
  }
  for (const file of ['push.ts', 'push-ahead.ts', 'pull-request.ts']) {
    assert.match(readFileSync(path.join(SHIP, file), 'utf8'), /openActionDialog</, file);
  }
});
