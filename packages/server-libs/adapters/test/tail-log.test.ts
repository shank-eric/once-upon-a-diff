/*
 * tailLog (src/stores/fs/tail-log.ts): a log read once and then only as far as it has grown. The agents, backlog and inbox
 * readers are built on it; their own tests (state/test) read through it too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { jsonLines } from '../src/stores/fs/jsonl.ts';
import { tailLog } from '../src/stores/fs/tail-log.ts';

type Item = { n: string };
const line = (name: string) => JSON.stringify({ n: name }) + '\n';
/** A reader that records each text it was asked to parse. */
function reader() {
  const parsed: string[] = [];
  const read = tailLog<Item>((text) => {
    parsed.push(text);
    return jsonLines(text) as Item[];
  });
  return { parsed, names: (file: string) => read(file).map((item) => item.n), read };
}

test('an append is parsed alone, and what was parsed before is not parsed again', () => {
  const file = path.join(tmp('tail-log'), 'log.jsonl');
  const { read, parsed, names } = reader();
  assert.deepEqual(names(file), [], 'no file, no items');
  writeFileSync(file, line('a') + line('b'));
  const first = read(file);
  appendFileSync(file, line('c'));
  const second = read(file);
  assert.deepEqual(
    second.map((item) => item.n),
    ['a', 'b', 'c'],
  );
  assert.equal(second[0], first[0], 'the same parsed item, not a new parse');
  assert.notEqual(second, first, 'a fresh array: a caller may change it');
  assert.deepEqual(
    parsed,
    [line('a') + line('b'), line('c')],
    'the second read parsed only the new bytes',
  );
  assert.deepEqual(names(file), ['a', 'b', 'c']);
  assert.equal(parsed.length, 2, 'a read with nothing new parses nothing');
});

test('a half-written last line is read for now and taken again when it is finished', () => {
  const file = path.join(tmp('tail-log'), 'log.jsonl');
  const { names } = reader();
  writeFileSync(file, line('a'));
  appendFileSync(file, line('b').trimEnd());
  assert.deepEqual(names(file), ['a', 'b'], 'a whole line with no newline yet still reads');
  appendFileSync(file, '\n' + line('c').slice(0, 5));
  assert.deepEqual(names(file), ['a', 'b'], 'half a line is not an item');
  appendFileSync(file, line('c').slice(5));
  assert.deepEqual(names(file), ['a', 'b', 'c']);
});

test('a file that got shorter, was replaced, or was emptied and refilled is read again from the top', () => {
  const dir = tmp('tail-log');
  const file = path.join(dir, 'log.jsonl');
  const { read, names } = reader();
  writeFileSync(file, line('a') + line('b') + line('c'));
  const before = read(file);
  truncateSync(file, line('a').length);
  assert.deepEqual(names(file), ['a']);
  assert.notEqual(read(file)[0], before[0], 'parsed again');
  const other = path.join(dir, 'other.jsonl');
  writeFileSync(other, line('x') + line('y') + line('z') + line('w'));
  renameSync(other, file);
  assert.deepEqual(names(file), ['x', 'y', 'z', 'w'], 'a different inode, so not an append');
  truncateSync(file, 0);
  appendFileSync(file, line('p') + line('q') + line('r') + line('s') + line('t'));
  assert.deepEqual(
    names(file),
    ['p', 'q', 'r', 's', 't'],
    'emptied and refilled past its old length',
  );
  renameSync(file, other);
  assert.deepEqual(names(file), [], 'gone');
});

test('two readers keep their own caches, and a file that grew from a few bytes keeps its cache', () => {
  const file = path.join(tmp('tail-log'), 'log.jsonl');
  const one = reader();
  const two = reader();
  writeFileSync(file, line('a'));
  const first = one.read(file);
  two.read(file);
  appendFileSync(file, line('b').repeat(5));
  const second = one.read(file);
  assert.equal(second.length, 6);
  assert.equal(second[0], first[0]);
  assert.equal(one.parsed.length, 2);
  assert.equal(two.parsed.length, 1, 'the other reader has not read since');
});

test('a file with 200,000 lines reads (the first read of a long-lived log must not overflow a call)', () => {
  const file = path.join(tmp('tail-log'), 'log.jsonl');
  const { names } = reader();
  writeFileSync(file, line('a').repeat(200_000));
  assert.equal(names(file).length, 200_000);
  appendFileSync(file, line('b'));
  assert.equal(names(file).length, 200_001);
});
