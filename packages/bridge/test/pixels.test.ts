import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { tmp, writeJson } from './helpers.ts';
import {
  baselineDir,
  baselineNames,
  compare,
  cssFilesUnder,
  primerNames,
  PRIMER_PALETTE,
  primerRule,
} from './browser/pixels.ts';

const png = (width: number, height: number, rgb: [number, number, number]) => {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    image.data.set([...rgb, 255], i * 4);
  }
  return image;
};
const COLOR = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

test('compare: the same image has no differing pixels', () => {
  const image = PNG.sync.write(png(4, 4, COLOR('#ffffff')));
  const result = compare(image, image);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.sizeMismatch, null);
});

test('compare: one changed pixel is counted, and a different size is refused', () => {
  const base = png(4, 4, COLOR('#ffffff'));
  const changed = png(4, 4, COLOR('#ffffff'));
  changed.data.set([0, 0, 0, 255], 5 * 4);
  const result = compare(PNG.sync.write(base), PNG.sync.write(changed));
  assert.equal(result.diffPixels, 1);
  assert.ok(result.diffPng);
  assert.match(
    compare(PNG.sync.write(base), PNG.sync.write(png(5, 4, COLOR('#ffffff')))).sizeMismatch ?? '',
    /4x4.*5x4/,
  );
});

test('compare: a nearly-right color still counts (the danger red, a border grey), a shade nobody sees does not', () => {
  const pair = (from: string, other: string) =>
    compare(PNG.sync.write(png(2, 2, COLOR(from))), PNG.sync.write(png(2, 2, COLOR(other))))
      .diffPixels;
  assert.equal(pair('#cf222e', '#d1242f'), 4);
  assert.equal(pair('#d0d7de', '#d1d9e0'), 4);
  assert.equal(pair('#1f2328', '#1f2329'), 0);
});

test('primerNames: the names var() reads that no stylesheet defines', () => {
  const dir = tmp('pixels-css');
  const file = path.join(dir, 'a.css');
  writeFileSync(
    file,
    '#p { --c-bg: var(--bgColor-default, #fff); color: var(--c-bg); border: 1px solid var(--borderColor-default, var(--ou-x, red)); }',
  );
  writeJson(path.join(dir, 'ignored.json'), {});
  assert.deepEqual(cssFilesUnder(dir), [file]);
  assert.deepEqual(primerNames([file]), ['--bgColor-default', '--borderColor-default']);
});

test('the pixel baselines for this platform are all there (a path or rename bug would otherwise skip the step quietly)', (ctx) => {
  if (process.platform !== 'darwin') {
    ctx.skip('baselines are made on darwin');
    return;
  }
  for (const name of baselineNames()) {
    assert.ok(existsSync(path.join(baselineDir('darwin'), name)), `missing ${name}`);
  }
});

test('the Primer palette has every variable the story UI CSS reads from GitHub, and pins both schemes', () => {
  const packages = path.resolve(import.meta.dirname, '../..');
  const names = primerNames(
    cssFilesUnder(
      path.join(packages, 'panel/src'),
      path.join(packages, 'ui-kit/src/css'),
      path.join(packages, 'extension/src/content/components'),
    ),
  );
  assert.deepEqual(
    names.filter((name) => !PRIMER_PALETTE[name]),
    [],
    'a Primer name the CSS reads is missing from PRIMER_PALETTE in test/browser/pixels.ts',
  );
  assert.match(primerRule('dark'), /--bgColor-default: #0d1117 !important/);
  assert.match(primerRule('light'), /--bgColor-default: #ffffff !important/);
});
