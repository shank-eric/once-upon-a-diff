import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  andBits,
  countBits,
  fromBase64,
  getBit,
  lineCount,
  nonBlankLines,
  toBase64,
  uncoveredLines,
} from '../src/services/usage/lines.ts';
import {
  MAX_VERSIONS,
  asCoverage,
  emptyCoverage,
  mergeSeen,
  type Seen,
} from '../src/services/usage/merge.ts';
import { createSnapshots } from '../src/services/usage/snapshots.ts';
import type { CoverageFunction } from '../src/adapters/usage/boot.ts';

// the text and the ranges V8 reported for it (precise coverage, run in Node 24)
const TEXT = [
  'export function used() { return 1; }', // 0..36
  'export function unused() {', // line 2 starts at 37
  '  return 2;',
  '}',
  '',
  'export function branchy(x) {',
  '  if (x) {',
  '    return 1;',
  '  }',
  '  return 2;',
  '}',
  '',
].join('\n');
const offsetOf = (needle: string) => TEXT.indexOf(needle);
const func = (start: number, end: number, count: number, more: [number, number, number][] = []) =>
  ({
    functionName: '',
    isBlockCoverage: more.length > 0,
    ranges: [
      { startOffset: start, endOffset: end, count },
      ...more.map(([from, until, hits]) => ({ startOffset: from, endOffset: until, count: hits })),
    ],
  }) satisfies CoverageFunction;

const FUNCTIONS: CoverageFunction[] = [
  func(0, TEXT.length, 1), // the module
  func(offsetOf('export function used'), offsetOf('\nexport function unused'), 1),
  func(offsetOf('export function unused'), offsetOf('\n\nexport function branchy'), 0),
  func(offsetOf('export function branchy'), TEXT.length - 1, 1),
];

test('a function that never ran leaves its lines uncovered, and blank lines are never uncovered', () => {
  const bits = uncoveredLines(TEXT, FUNCTIONS);
  const lines = TEXT.split('\n');
  const flagged = lines.map((_, i) => getBit(bits, i));
  assert.deepEqual(flagged.slice(0, 4), [false, true, true, true]);
  assert.equal(flagged[4], false, 'a blank line');
  assert.ok(
    flagged.slice(5).every((active) => !active),
    'the called function is covered',
  );
});

test('block ranges (lines mode) uncover just the branch that did not run', () => {
  const start = offsetOf('    return 1;');
  const blocks = [
    ...FUNCTIONS.slice(0, 3),
    func(offsetOf('export function branchy'), TEXT.length - 1, 1, [
      [start, start + '    return 1;'.length, 0],
    ]),
  ];
  const bits = uncoveredLines(TEXT, blocks);
  const flagged = TEXT.split('\n').map((_, i) => getBit(bits, i));
  assert.equal(flagged[7], true, 'the return 1 line');
  assert.equal(flagged[6], false, 'the if line ran');
  assert.equal(flagged[9], false, 'return 2 ran');
});

test('line counting and the bitset helpers', () => {
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(nonBlankLines('a\n\n  \nb\n'), 2);
  const left = uncoveredLines(TEXT, FUNCTIONS);
  assert.equal(countBits(left), 3);
  assert.deepEqual([...fromBase64(toBase64(left))], [...left]);
  const none = new Uint8Array(left.length);
  assert.equal(countBits(andBits(left, none)), 0, 'covered anywhere means covered');
  assert.equal(countBits(andBits(left, left)), 3);
});

const seen = (sha: string, bits: Uint8Array, mode: Seen['mode'] = 'function'): Seen => ({
  path: 'packages/bridge/src/x.ts',
  sha,
  mode,
  lines: 11,
  uncovered: bits,
});

test('merging: a line stays uncovered only until some run covers it; an identical take changes nothing', () => {
  const file = emptyCoverage('2026-11-04T10:00:00.000Z');
  const bits = uncoveredLines(TEXT, FUNCTIONS);
  assert.equal(
    mergeSeen(file, [seen('aaaaaaaa', bits)], '2026-11-04T10:00:00.000Z', '2026-11-04'),
    true,
  );
  assert.equal(
    mergeSeen(file, [seen('aaaaaaaa', bits)], '2026-11-04T10:05:00.000Z', '2026-11-04'),
    false,
  );
  const covered = new Uint8Array(bits.length);
  assert.equal(
    mergeSeen(file, [seen('aaaaaaaa', covered)], '2026-11-04T10:10:00.000Z', '2026-11-04'),
    true,
  );
  const [entry] = file.files['packages/bridge/src/x.ts'];
  assert.equal(countBits(fromBase64(entry.uncovered)), 0);
  assert.equal(entry.takes, 3);
  assert.equal(entry.dayUncovered['2026-11-04'], 0);
  // a file a run did not load is simply absent from the take: nothing is merged for it
  assert.equal(mergeSeen(file, [], '2026-11-04T10:15:00.000Z', '2026-11-04'), false);
});

test('merging: a changed file is a new version, and only the newest three are kept', () => {
  const file = emptyCoverage('2026-11-01T00:00:00.000Z');
  const bits = uncoveredLines(TEXT, FUNCTIONS);
  for (const [i, sha] of ['11111111', '22222222', '33333333', '44444444'].entries()) {
    mergeSeen(file, [seen(sha, bits)], `2026-11-0${i + 1}T00:00:00.000Z`, `2026-11-0${i + 1}`);
  }
  const versions = file.files['packages/bridge/src/x.ts'];
  assert.equal(versions.length, MAX_VERSIONS);
  assert.deepEqual(
    versions.map((version) => version.sha),
    ['44444444', '33333333', '22222222'],
  );
  // a lines-mode take into a function-mode entry stays function: the coarser of the two
  mergeSeen(file, [seen('44444444', bits, 'lines')], '2026-11-05T00:00:00.000Z', '2026-11-05');
  assert.equal(versions[0].mode, 'function');
});

test('a damaged or older stored file reads as empty instead of crashing a flush', () => {
  for (const bad of [null, 5, 'x', { files: null }, []]) {
    assert.deepEqual(asCoverage(bad, 'now').files, {});
  }
  assert.equal(asCoverage({ files: { a: [] }, starts: 'many' }, 'now').starts, 0);
});

test('C3: a script is mapped with the text it first ran, never a file a deploy changed under the process', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'usage-snap-'));
  const file = path.join(root, 'a.ts');
  const started = Date.now();
  writeFileSync(file, 'export const a = 1;\n');
  const old = new Date(started - 60000);
  utimesSync(file, old, old);
  const snapshots = createSnapshots(root, started);
  const first = snapshots.of('a.ts');
  assert.ok(first && first.text === 'export const a = 1;\n');
  // the deploy switches the checkout: the file on disk is now another version
  writeFileSync(file, 'export const a = 2;\nexport const b = 3;\n');
  const after = snapshots.of('a.ts');
  assert.equal(after?.sha, first.sha, 'the first copy is kept');
  assert.equal(after?.text, 'export const a = 1;\n');
  // a script this process only reaches after the switch is skipped: its text is not what it ran
  writeFileSync(path.join(root, 'late.ts'), 'export const late = 1;\n');
  assert.equal(snapshots.of('late.ts'), null);
  assert.equal(snapshots.of('missing.ts'), null);
});
