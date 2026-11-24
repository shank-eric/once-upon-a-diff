/*
 * replaceLog (src/stores/fs/jsonl.ts): a log replaced by a rewrite of it, with the old one kept and nothing appended meanwhile lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { jsonLines, replaceLog } from '../src/stores/fs/jsonl.ts';
import { tailLog } from '../src/stores/fs/tail-log.ts';

const NOW = new Date('2026-11-17T15:00:00Z');
const dropB = (whole: string) =>
  whole
    .split('\n')
    .filter((one) => one && !one.includes('"b"'))
    .map((one) => one + '\n')
    .join('');

test("the log is rewritten, the old one kept beside it, and the file stays the owner's alone", () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n{"n":"c"}\n');
  const done = replaceLog(file, dropB, { now: NOW });
  assert.equal(readFileSync(file, 'utf8'), '{"n":"a"}\n{"n":"c"}\n');
  assert.equal(done?.kept, `${file}.20261117.bak`);
  assert.equal(readFileSync(done!.kept, 'utf8'), '{"n":"a"}\n{"n":"b"}\n{"n":"c"}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(file)).sort(), ['log.jsonl', 'log.jsonl.20261117.bak']);
});

test('bytes appended while it works are in the new file, and a half-written last line is carried over', () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n{"n":"c');
  replaceLog(file, dropB, {
    now: NOW,
    beforeSwap: () => appendFileSync(file, '"}\n{"n":"d"}\n'),
  });
  assert.deepEqual(jsonLines(readFileSync(file, 'utf8')), [{ n: 'a' }, { n: 'c' }, { n: 'd' }]);
});

test('an append that lands after the last size check, before the rename, is carried to the new file', () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n{"n":"c"}\n');
  const done = replaceLog(file, dropB, {
    now: NOW,
    beforeRename: () => appendFileSync(file, '{"n":"late"}\n'),
  });
  assert.deepEqual(jsonLines(readFileSync(file, 'utf8')), [{ n: 'a' }, { n: 'c' }, { n: 'late' }]);
  assert.equal(done?.before, readFileSync(done!.kept).length);
});

test('a second replacement the same day does not overwrite the first old log', () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n');
  const first = replaceLog(file, dropB, { now: NOW });
  appendFileSync(file, '{"n":"b"}\n');
  const second = replaceLog(file, dropB, { now: NOW });
  assert.equal(second?.kept, `${file}.20261117-2.bak`);
  assert.equal(readFileSync(first!.kept, 'utf8'), '{"n":"a"}\n{"n":"b"}\n');
  assert.equal(readFileSync(second!.kept, 'utf8'), '{"n":"a"}\n{"n":"b"}\n');
});

test('a rewrite that returns null, or a log that is not there, changes nothing', () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  assert.equal(
    replaceLog(file, () => ''),
    null,
  );
  writeFileSync(file, '{"n":"a"}\n');
  assert.equal(
    replaceLog(file, () => null),
    null,
  );
  assert.deepEqual(readdirSync(path.dirname(file)), ['log.jsonl']);
});

test('a tail reader starts over on the replaced file', () => {
  const file = path.join(tmp('replace-log'), 'log.jsonl');
  const read = tailLog((text) => jsonLines(text) as { n: string }[]);
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n{"n":"c"}\n');
  assert.equal(read(file).length, 3);
  replaceLog(file, dropB, { now: NOW });
  assert.deepEqual(read(file), [{ n: 'a' }, { n: 'c' }]);
  appendFileSync(file, '{"n":"e"}\n');
  assert.deepEqual(
    read(file).map((one) => one.n),
    ['a', 'c', 'e'],
  );
});

test('keepBackups: 1 leaves the latest old log beside the new one and no older .bak of this log', () => {
  const dir = tmp('replace-log');
  const file = path.join(dir, 'log.jsonl');
  const other = path.join(dir, 'other.jsonl.20261101.bak');
  writeFileSync(other, 'not this log\n');
  writeFileSync(file, '{"n":"a"}\n{"n":"b"}\n{"n":"c"}\n');
  replaceLog(file, dropB, { now: new Date('2026-11-16T15:00:00Z'), keepBackups: 1 });
  writeFileSync(file, readFileSync(file, 'utf8') + '{"n":"b"}\n{"n":"d"}\n');
  const done = replaceLog(file, dropB, { now: NOW, keepBackups: 1 });
  assert.deepEqual(readdirSync(dir).sort(), [
    'log.jsonl',
    'log.jsonl.20261117.bak',
    'other.jsonl.20261101.bak',
  ]);
  assert.equal(readFileSync(done!.kept, 'utf8'), '{"n":"a"}\n{"n":"c"}\n{"n":"b"}\n{"n":"d"}\n');
});
