import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.ts';
import { file } from './local-env.ts';

const { baseRows, rowsFor, rowKeyFor, claimsFor } = await import('../public/local/diff/rows.ts');

type Input = Parameters<typeof rowsFor>[0];
const input = (over: Partial<Input> = {}): Input => ({
  file: file('a.ts', [' one', '-two', '+TWO', '+three', ' four']) as never,
  split: false,
  notes: [],
  editors: [],
  claims: claimsFor([]),
  step: null,
  opened: undefined,
  ...over,
});
const kinds = (rows: { kind: string; key: string }[]) =>
  rows.map((row) => `${row.kind}:${row.key}`);
const note = (id: string, side: 'L' | 'R', line: number) =>
  ({ id, at: 'x', path: 'a.ts', side, line, body: id }) as never;

test('a unified file is a hunk row and a row for each line, with its old and new numbers', () => {
  const { rows } = baseRows(input().file, false);
  assert.deepEqual(kinds(rows), [
    'hunk:h0',
    'line:l0:0',
    'line:l0:1',
    'line:l0:2',
    'line:l0:3',
    'line:l0:4',
  ]);
  assert.deepEqual(
    rows.slice(1).map((row) => row.kind === 'line' && [row.sign, row.oldNum, row.newNum]),
    [
      [' ', 1, 1],
      ['-', 2, null],
      ['+', null, 2],
      ['+', null, 3],
      [' ', 3, 4],
    ],
  );
});

test('a split file pairs a removed line with the added one beside it', () => {
  const { rows } = baseRows(input().file, true);
  assert.deepEqual(kinds(rows), ['hunk:h0', 'pair:p0:0', 'pair:p0:1', 'pair:p0:2', 'pair:p0:3']);
});

test('a file with nothing to draw says why, in one row', () => {
  const messages = [
    [file('b.bin', [], { binary: true }), 'Binary file'],
    [
      file('w.ts', [' x'], { whitespace_only: true }),
      'Only whitespace changes, hidden. Turn off Hide whitespace to see them.',
    ],
    [file('e.ts', [], { hunks: [] }), 'No changed lines'],
    [file('r.ts', [], { hunks: [], kind: 'renamed' }), 'Renamed without changes'],
  ] as const;
  for (const [one, text] of messages) {
    const { rows } = baseRows(one as never, false);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].kind === 'message' && rows[0].text, text);
  }
});

test('a line number is on the row that draws it, in unified and in split', () => {
  const one = input().file;
  assert.equal(rowKeyFor(one, false, 'R', 2), 'l0:2');
  assert.equal(rowKeyFor(one, false, 'L', 2), 'l0:1');
  assert.equal(rowKeyFor(one, false, 'L', 3), 'l0:4', 'a context line has both numbers');
  assert.equal(rowKeyFor(one, false, 'R', 4), 'l0:4');
  assert.equal(rowKeyFor(one, false, 'R', 99), null);
  assert.equal(rowKeyFor(one, true, 'L', 2), 'p0:1');
  assert.equal(rowKeyFor(one, true, 'R', 2), 'p0:1', 'the pair holds both');
});

test('notes go under their line, the last of a line first, and an open form before them', () => {
  const rows = rowsFor(
    input({
      notes: [note('n1', 'R', 2), note('n2', 'R', 2)],
      editors: [{ key: 'a.ts|l0:2', rel: 'a.ts', row: 'l0:2', side: 'R', line: 2, focus: 0 }],
    }),
  );
  assert.deepEqual(kinds(rows), [
    'hunk:h0',
    'line:l0:0',
    'line:l0:1',
    'line:l0:2',
    'editor:e:a.ts|l0:2',
    'note:nn2',
    'note:nn1',
    'line:l0:3',
    'line:l0:4',
  ]);
});

test("a note on a line this diff doesn't draw goes under the file's first row, and says so", () => {
  const rows = rowsFor(input({ notes: [note('n1', 'R', 99), note('n2', 'R', 0)] }));
  assert.deepEqual(kinds(rows).slice(0, 4), ['hunk:h0', 'note:nn2', 'note:nn1', 'line:l0:0']);
  const away = rows
    .filter((row) => row.kind === 'note')
    .map((row) => row.kind === 'note' && row.away);
  assert.deepEqual(away, [false, true]);
});

const claims = (steps: unknown[]) => claimsFor(steps as never);
const chapters = [
  { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 1, end: 2 }] }] },
  { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 3, end: 4 }] }] },
];

test('a step folds the lines other chapters tell behind one row, and Show opens it', () => {
  const one = file('a.ts', [' a', ' b', ' c', ' d']) as never;
  const folded = rowsFor(
    input({ file: one, claims: claims(chapters), step: { n: 1, all: false } }),
  );
  assert.deepEqual(kinds(folded), [
    'hunk:h0',
    'line:l0:0',
    'line:l0:1',
    'fold:f:l0:2',
    'line:l0:2',
    'line:l0:3',
  ]);
  const hidden = folded.map((row) => row.hidden);
  assert.deepEqual(hidden, [false, false, false, false, true, true]);
  const fold = folded[3];
  assert.ok(fold.kind === 'fold' && fold.lines === 2 && fold.steps.join() === '2');
  const open = rowsFor(
    input({
      file: one,
      claims: claims(chapters),
      step: { n: 1, all: false },
      opened: { 'l0:2': true },
    }),
  );
  assert.deepEqual(kinds(open), ['hunk:h0', 'line:l0:0', 'line:l0:1', 'line:l0:2', 'line:l0:3']);
  assert.ok(open.every((row) => !row.hidden));
  assert.equal(open[3].run, 'l0:2', 'a row knows its fold, so a jump to it can open it');
});

test('a step that is all files, or none, folds nothing', () => {
  const one = file('a.ts', [' a', ' b', ' c', ' d']) as never;
  for (const step of [null, { n: 1, all: true }, { n: 0, all: false }]) {
    const rows = rowsFor(input({ file: one, claims: claims(chapters), step }));
    assert.ok(rows.every((row) => !row.hidden && row.kind !== 'fold'));
  }
});

test('a note, and an open form, keep their line shown', () => {
  const one = file('a.ts', [' a', ' b', ' c', ' d']) as never;
  const rows = rowsFor(
    input({
      file: one,
      claims: claims(chapters),
      step: { n: 1, all: false },
      notes: [note('n1', 'R', 3)],
    }),
  );
  const line = rows.find((row) => row.key === 'l0:2');
  assert.equal(line?.hidden, false);
  assert.ok(
    rows.some((row) => row.kind === 'fold'),
    'the rest still folds',
  );
});

test('rows keep their keys when a note is added, so the nodes stay', () => {
  const before = rowsFor(input());
  const after = rowsFor(input({ notes: [note('n1', 'R', 2)] }));
  const keys = new Set(before.map((row) => row.key));
  assert.ok([...keys].every((key) => after.some((row) => row.key === key)));
});

test('a fold the reader opened stays open when a form or a note splits it', () => {
  const twenty = file(
    'a.ts',
    Array.from({ length: 20 }, (_, i) => ` line ${i + 1}`),
  ) as never;
  const two = claims([
    { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 1, end: 2 }] }] },
    { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 3, end: 20 }] }] },
  ]);
  const base = { file: twenty, claims: two, step: { n: 1, all: false } };
  const closed = rowsFor(input(base));
  const fold = closed.find((row) => row.kind === 'fold');
  assert.ok(fold && fold.kind === 'fold' && fold.lines === 18);
  // Show opens the fold: it holds the keys of its rows
  const opened = Object.fromEntries(
    (fold as { rows: string[] }).rows.map((key) => [key, true as const]),
  );
  const editor = {
    key: 'a.ts|l0:9',
    rel: 'a.ts',
    row: 'l0:9',
    side: 'R' as const,
    line: 10,
    focus: 0,
  };
  for (const extra of [{ editors: [editor] }, { notes: [note('n1', 'R', 10)] }]) {
    const rows = rowsFor(input({ ...base, ...extra, opened }));
    assert.ok(!rows.some((row) => row.kind === 'fold'), 'no new fold row');
    const lines = rows.filter((row) => row.kind === 'line');
    assert.equal(lines.length, 20);
    assert.ok(
      lines.every((row) => !row.hidden),
      'lines 3 to 20 all shown, both sides of the form',
    );
  }
  // while closed, the form's own line shows and the rest folds in two runs
  const split = rowsFor(input({ ...base, editors: [editor] }));
  assert.equal(split.filter((row) => row.kind === 'fold').length, 2);
});

test('a file keeps its rows while only its Viewed marks change', () => {
  const one = file('a.ts', [' a', '+b']) as { viewed: boolean };
  const marked = { ...one, viewed: true };
  assert.ok(baseRows(one as never, false) === baseRows(marked as never, false));
  assert.ok(
    baseRows(one as never, false) !== baseRows(one as never, true),
    'the split flag is a different table',
  );
});

test('taking away the note that kept a line shown between a closed fold and an opened one leaves the opened lines shown', () => {
  const lines = file(
    'a.ts',
    Array.from({ length: 12 }, (_, i) => ` line ${i + 1}`),
  ) as never;
  const three = claims([
    { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 1, end: 2 }] }] },
    { files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 3, end: 12 }] }] },
  ]);
  const base = { file: lines, claims: three, step: { n: 1, all: false } };
  // a note on line 6 keeps it shown: lines 3-5 fold behind one row, lines 7-12 behind another, and the reader opens the second
  const withNote = rowsFor(input({ ...base, notes: [note('n1', 'R', 6)] }));
  const folds = withNote.filter((row) => row.kind === 'fold');
  assert.equal(folds.length, 2);
  const second = folds[1] as { rows: string[] };
  const opened = Object.fromEntries(second.rows.map((key) => [key, true as const]));
  const stillThere = rowsFor(input({ ...base, notes: [note('n1', 'R', 6)], opened }));
  assert.equal(stillThere.filter((row) => row.kind === 'fold').length, 1, 'the first stays closed');
  // the note is deleted: the two runs are one, and it was opened in part
  const gone = rowsFor(input({ ...base, opened }));
  assert.ok(!gone.some((row) => row.kind === 'fold'));
  const hidden = gone.filter((row) => row.kind === 'line' && row.hidden);
  assert.equal(hidden.length, 0, 'the lines that were opened are not folded away again');
});
