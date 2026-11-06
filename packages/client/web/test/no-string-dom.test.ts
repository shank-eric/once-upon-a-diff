/*
 * The local page is one Preact tree (app.ts), so its files write into the DOM by hand only where it says it does: a new write
 * anywhere else under public/local fails, and a file's count can only fall. The pattern and its probes are the test kit's
 * (dom-writes.ts, probed in panel/test/no-string-dom.test.ts). Two more rules the pattern doesn't cover: no file draws markup
 * from a string (the string-HTML helpers, innerHTML), and `dangerouslySetInnerHTML` is used once, in the table's code cell, for
 * highlight.js's own (escaped) output. The board's three files that live here (auth, stored, not-connected) are not the page's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, files, writesIn } from '@once-upon-a-diff/test-kit/dom-writes';

const LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/local');
const BOARD = new Set(['auth.ts', 'stored.ts', 'not-connected.ts']);

/** file (under local/): [how many hand writes, why]. A count can only fall. */
const WRITES: Record<string, [number, string]> = {
  'app.ts': [
    1,
    'the window focus listener that looks again for the PR (removed when the page goes)',
  ],
  'diff/rows.ts': [2, 'plain data fields named hidden on row objects, not nodes'],
  'local.ts': [1, 'document.title, set once the story has loaded'],
  'page.ts': [1, 'the visibilitychange listener that sends the usage counts as the tab is hidden'],
  'ship/pull-request.ts': [1, 'the compare page’s address set on the tab the click opened'],
};

const sources = () =>
  files(LOCAL)
    .map((file) => [path.relative(LOCAL, file), readFileSync(file, 'utf8')] as const)
    .filter(([rel]) => !BOARD.has(rel));

test('the local page writes into the DOM by hand only where it says it does', () => {
  const found: Record<string, number> = {};
  for (const [rel, source] of sources()) {
    const count = writesIn(source);
    if (count) {
      found[rel] = count;
    }
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(WRITES).map(([file, [count]]) => [file, count])),
  );
});

test('no file draws markup from a string, and dangerouslySetInnerHTML is the code cell’s alone', () => {
  let cells = 0;
  for (const [rel, source] of sources()) {
    const text = code(source);
    assert.ok(
      !/terms\/html\.ts|\.(innerHTML|outerHTML)\b/.test(text),
      `${rel} draws from a string`,
    );
    const uses = (text.match(/dangerouslySetInnerHTML/g) || []).length;
    if (uses) {
      assert.equal(rel, 'diff/table.ts', 'only the table takes HTML');
      cells += uses;
    }
  }
  assert.equal(cells, 1);
});

test('the code cell takes HTML only from highlight.js’s output, never from a line’s own text', () => {
  const table = code(readFileSync(path.join(LOCAL, 'diff/table.ts'), 'utf8'));
  // the one use is fed by `highlighted`, which rowView reads from highlights.ts (lineOf); a line's text goes in as a child
  assert.match(table, /highlighted != null[\s\S]*?__html: content/);
  assert.match(table, /lineOf\(highlights/);
  assert.ok(!/__html:\s*(row|cell|line|text)\b/.test(table));
});

test('the boxes are drawn by ActionDialog, from the store: no box builds markup strings or its own dialog element', () => {
  for (const file of ['push.ts', 'push-ahead.ts', 'pull-request.ts', 'dialogs.ts']) {
    const source = code(readFileSync(path.join(LOCAL, 'ship', file), 'utf8'));
    assert.ok(
      !/createElement\(['"]dialog|openActionDialog/.test(source),
      `${file} makes its own dialog`,
    );
  }
  for (const file of ['push.ts', 'push-ahead.ts', 'pull-request.ts']) {
    assert.match(readFileSync(path.join(LOCAL, 'ship', file), 'utf8'), /ActionSpec</, file);
  }
  assert.match(readFileSync(path.join(LOCAL, 'ship', 'dialogs.ts'), 'utf8'), /ActionDialog/);
});
