/*
 * The extension ships every panel stylesheet: a sheet nobody links never loads and its region draws unstyled, so each
 * one in the panel's REGION_SHEETS (and the base and page sheets) has a LINKED_CSS entry in wxt.config.ts, which
 * web_accessible_resources follows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGION_SHEETS } from '@once-upon-a-diff/panel/shell/sheets';

test('the extension ships every panel sheet (a LINKED_CSS entry each)', () => {
  const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
  for (const sheet of ['page.css', 'panel.css', ...REGION_SHEETS]) {
    assert.match(config, new RegExp(`'panel/${sheet.replace('.', '\\.')}'`), sheet);
  }
});
