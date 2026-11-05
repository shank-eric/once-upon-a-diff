/*
 * The theme tokens stay the one alias layer: no sheet but ui-kit's tokens.css names a Primer variable (--fgColor-*, --bgColor-*,
 * --borderColor-*; GitHub's theme or the fallbacks supply them there), and every --ou-<token> a sheet reads is one tokens.css defines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PACKAGES = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, PACKAGES), 'utf8');
const SHEETS = [
  'ui-kit/src/css/ui.css',
  'panel/src/css/panel.css',
  'panel/src/css/page.css',
  'web/public/local/local.css',
  'extension/src/content/components/story-tag.css',
  'extension/src/content/components/listen-notice.css',
  'extension/src/content/components/toast.css',
];
const TOKEN_NAMES = new Set(
  [...read('ui-kit/src/css/tokens.css').matchAll(/^\s*(--ou-[\w-]+):/gm)].map((match) => match[1]),
);
const TOKEN_USE = /var\((--ou-(?:bg|fg|border|accent|ok|warn|danger|font)[\w-]*)/g;

test('no sheet but tokens.css names a Primer variable, or the old per-sheet aliases', () => {
  for (const sheet of SHEETS) {
    const text = read(sheet);
    assert.doesNotMatch(text, /--(fgColor|bgColor|borderColor)-/, sheet);
    assert.doesNotMatch(text, /--c-[a-z]|--ou-local-del-fg/, sheet);
  }
});

test('every theme token a sheet reads is defined in tokens.css', () => {
  assert.ok(TOKEN_NAMES.has('--ou-danger'));
  for (const sheet of SHEETS) {
    for (const [, name] of read(sheet).matchAll(TOKEN_USE)) {
      assert.ok(TOKEN_NAMES.has(name), `${sheet} reads ${name}`);
    }
  }
});

test('a color or font stack a sheet writes out is not a copy of a token', () => {
  for (const sheet of SHEETS) {
    assert.doesNotMatch(
      read(sheet),
      /BlinkMacSystemFont|ui-monospace/,
      `${sheet} has its own font stack`,
    );
  }
});
