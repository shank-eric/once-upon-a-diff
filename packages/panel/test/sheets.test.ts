/*
 * The panel's stylesheets are split by region (css/panel.css is the base, each region folder has its own). A sheet nobody links never
 * loads and the region draws unstyled, so every .css under src/ is the page's, the base or in REGION_SHEETS, every one of those exists,
 * and the extension ships each (wxt.config.ts's LINKED_CSS, which web_accessible_resources follows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { REGION_SHEETS } from '../src/shell/sheets.ts';

const SRC = new URL('../src/', import.meta.url);
const found = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.css'))
  .sort();

test('every stylesheet under the panel is the page sheet, the base or a listed region sheet, and the list has no missing file', () => {
  assert.deepEqual(
    found.filter((name) => !name.startsWith('css/')),
    [...REGION_SHEETS].sort(),
  );
  assert.deepEqual(
    found.filter((name) => name.startsWith('css/')),
    ['css/page.css', 'css/panel.css'],
  );
});

test('a region sheet sits in its region: <region>/<region>.css', () => {
  for (const sheet of REGION_SHEETS) {
    const [region, file] = sheet.split('/');
    assert.equal(file, `${region}.css`);
  }
});

test('the extension ships every panel sheet (a LINKED_CSS entry each)', () => {
  const config = readFileSync(new URL('../../extension/wxt.config.ts', import.meta.url), 'utf8');
  for (const sheet of ['page.css', 'panel.css', ...REGION_SHEETS]) {
    assert.match(config, new RegExp(`'panel/${sheet.replace('.', '\\.')}'`), sheet);
  }
});

test("no sheet restyles the early box's paragraphs: the box sits in .ou-md, whose `.ou-md p` rule (same specificity) sets their margin, and a region sheet linked after the base would win", () => {
  for (const name of found) {
    assert.doesNotMatch(readFileSync(new URL(name, SRC), 'utf8'), /\.ou-early-box p\b/, name);
  }
});
