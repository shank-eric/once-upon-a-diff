/*
 * (The panel's, ui-kit's and the extension's sheets get the token checks in their own packages' test/theme-sheets.test.ts.)
 * The pages' sheets keep to the theme tokens (see the test-kit's theme-sheets), and keep to their own split: more than one sheet,
 * and a colour named only in a custom property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssIn, themeTokenRules } from '@once-upon-a-diff/test-kit/theme-sheets';

const read = (file: string) => readFileSync(file, 'utf8');
/** Every stylesheet under the web package's public/: the pages' base and each region's own. */
const WEB_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PAGE_SHEETS = cssIn(WEB_PUBLIC);

themeTokenRules({
  tokens: fileURLToPath(import.meta.resolve('@once-upon-a-diff/ui-kit/css/tokens.css')),
  sheets: PAGE_SHEETS,
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
