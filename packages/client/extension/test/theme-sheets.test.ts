/*
 * The extension's content sheets keep to the theme tokens (the bridge's theme-sheets test holds the pages' and panel's): no sheet
 * but ui-kit's tokens.css names a Primer variable (--fgColor-*, --bgColor-*, --borderColor-*), and every --ou-<token> a sheet
 * reads is one tokens.css defines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (file: string) => readFileSync(file, 'utf8');
const TOKENS = fileURLToPath(import.meta.resolve('@once-upon-a-diff/ui-kit/css/tokens.css'));
const SHEETS = ['story-tag', 'listen-notice', 'toast'].map((name) =>
  fileURLToPath(new URL(`../src/content/components/${name}.css`, import.meta.url)),
);
const TOKEN_NAMES = new Set(
  [...read(TOKENS).matchAll(/^\s*(--ou-[\w-]+):/gm)].map((match) => match[1]),
);
const TOKEN_USE = /var\((--ou-(?:bg|fg|border|accent|ok|warn|danger|font)[\w-]*)/g;

test('no content sheet names a Primer variable, or the old per-sheet aliases', () => {
  for (const sheet of SHEETS) {
    const text = read(sheet);
    assert.doesNotMatch(text, /--(fgColor|bgColor|borderColor)-/, sheet);
    assert.doesNotMatch(text, /--c-[a-z]|--ou-local-del-fg/, sheet);
  }
});

test('every theme token a content sheet reads is defined in tokens.css', () => {
  assert.ok(TOKEN_NAMES.has('--ou-danger'));
  for (const sheet of SHEETS) {
    for (const [, name] of read(sheet).matchAll(TOKEN_USE)) {
      assert.ok(TOKEN_NAMES.has(name), `${sheet} reads ${name}`);
    }
  }
});

test('a color or font stack a content sheet writes out is not a copy of a token', () => {
  for (const sheet of SHEETS) {
    assert.doesNotMatch(
      read(sheet),
      /BlinkMacSystemFont|ui-monospace/,
      `${sheet} has its own font stack`,
    );
  }
});
