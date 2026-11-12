/*
 * (The extension's three content sheets get the same checks in the extension's own test/theme-sheets.test.ts.)
 * The theme tokens stay the one alias layer: no sheet but ui-kit's tokens.css names a Primer variable (--fgColor-*, --bgColor-*,
 * --borderColor-*; GitHub's theme or the fallbacks supply them there), and every --ou-<token> a sheet reads is one tokens.css defines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resolved = (spec: string) => fileURLToPath(import.meta.resolve(spec));
const read = (file: string) => readFileSync(file, 'utf8');
const cssIn = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(dir, name));
/** Every stylesheet under the web package's public/: the pages' base and each region's own. */
const WEB_PUBLIC = path.dirname(resolved('@once-upon-a-diff/web/public/board.ts'));
const PAGE_SHEETS = cssIn(WEB_PUBLIC);
/** Every stylesheet under the panel's src/: the base and page sheets in css/ and each region's own. */
const PANEL_SHEETS = cssIn(
  path.dirname(path.dirname(resolved('@once-upon-a-diff/panel/shell/overlay'))),
);
const TOKENS = resolved('@once-upon-a-diff/ui-kit/css/tokens.css');
const SHEETS = [resolved('@once-upon-a-diff/ui-kit/css/ui.css'), ...PANEL_SHEETS, ...PAGE_SHEETS];
const TOKEN_NAMES = new Set(
  [...read(TOKENS).matchAll(/^\s*(--ou-[\w-]+):/gm)].map((match) => match[1]),
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

test('the pages have their sheets split by owner: more than one, and no leftover local.css holding the board', () => {
  for (const name of ['page.css', 'board/board.css', 'local/diff/diff.css']) {
    assert.ok(PAGE_SHEETS.includes(path.join(WEB_PUBLIC, name)), name);
  }
  assert.doesNotMatch(read(path.join(WEB_PUBLIC, 'local/local.css')), /\.ou-board-/);
});

test('a page sheet names a colour only in a custom property (a palette, a named shadow), never in a rule: the rest are tokens', () => {
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
  for (const sheet of PAGE_SHEETS) {
    const uncommented = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const declaration of uncommented.split(/[;{}]/)) {
      if (COLOUR.test(declaration)) {
        assert.match(declaration.trim(), /^--[\w-]+\s*:/, `${sheet}: ${declaration.trim()}`);
      }
    }
  }
});
