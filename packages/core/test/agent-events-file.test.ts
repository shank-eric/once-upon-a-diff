/*
 * agents.jsonl is read whole on every board poll, so a process keeps the events it parsed and parses only what was appended
 * (core/src/records/agents/events-file.ts). An append is picked up, a rewrite or a replaced file starts over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { agentEventsIn } from '../src/records/agents/events-file.ts';

const line = (name: string) =>
  JSON.stringify({
    op: 'beat',
    id: `abcd1234:${name}`,
    sid8: 'abcd1234',
    name,
    at: '2026-11-05T10:00:00.000Z',
  }) + '\n';
const names = (file: string) => agentEventsIn(file).map((event) => event.name);

test('an append is picked up, and what was parsed before is not parsed again', () => {
  const file = path.join(tmp('events-file'), 'agents.jsonl');
  assert.deepEqual(names(file), [], 'no file, no events');
  writeFileSync(file, line('a') + line('b'));
  const first = agentEventsIn(file);
  assert.deepEqual(
    first.map((event) => event.name),
    ['a', 'b'],
  );
  appendFileSync(file, line('c'));
  const second = agentEventsIn(file);
  assert.deepEqual(
    second.map((event) => event.name),
    ['a', 'b', 'c'],
  );
  assert.equal(second[0], first[0], 'the same parsed event, not a new parse');
  assert.notEqual(second, first, 'a fresh array: a caller may change it');
  assert.deepEqual(names(file), ['a', 'b', 'c'], 'a read with nothing new');
});

test('a half-written last line is read for now and taken again when it is finished', () => {
  const file = path.join(tmp('events-file'), 'agents.jsonl');
  writeFileSync(file, line('a'));
  appendFileSync(file, line('b').trimEnd());
  assert.deepEqual(names(file), ['a', 'b'], 'a whole line with no newline yet still reads');
  appendFileSync(file, '\n' + line('c').slice(0, 20));
  assert.deepEqual(names(file), ['a', 'b'], 'half a line is not an event');
  appendFileSync(file, line('c').slice(20));
  assert.deepEqual(names(file), ['a', 'b', 'c']);
});

test('a file that got shorter, or was replaced, is read again from the top', () => {
  const dir = tmp('events-file');
  const file = path.join(dir, 'agents.jsonl');
  writeFileSync(file, line('a') + line('b') + line('c'));
  const before = agentEventsIn(file);
  assert.equal(before.length, 3);
  truncateSync(file, line('a').length);
  assert.deepEqual(names(file), ['a']);
  assert.notEqual(agentEventsIn(file)[0], before[0], 'parsed again');
  // replaced by a longer file with other contents: a different inode, so not an append to the old one
  const other = path.join(dir, 'other.jsonl');
  writeFileSync(other, line('x') + line('y') + line('z') + line('w'));
  renameSync(other, file);
  assert.deepEqual(names(file), ['x', 'y', 'z', 'w']);
  // and gone
  renameSync(file, other);
  assert.deepEqual(names(file), []);
});

test('a file with 200,000 events reads (the first read of a long-lived log must not overflow a call)', () => {
  const file = path.join(tmp('events-file'), 'agents.jsonl');
  const one = line('a');
  writeFileSync(file, one.repeat(200_000));
  assert.equal(agentEventsIn(file).length, 200_000);
  appendFileSync(file, line('b'));
  assert.equal(agentEventsIn(file).length, 200_001);
});

test('a file emptied and refilled past its old length starts over', () => {
  const file = path.join(tmp('events-file'), 'agents.jsonl');
  writeFileSync(file, line('a') + line('b') + line('c'));
  assert.deepEqual(names(file), ['a', 'b', 'c']);
  truncateSync(file, 0);
  appendFileSync(file, line('x') + line('y') + line('z') + line('w'));
  assert.deepEqual(names(file), ['x', 'y', 'z', 'w']);
});

test('a file that grew from a few bytes keeps its cache: the start it fingerprints is only what was parsed', () => {
  const file = path.join(tmp('events-file'), 'agents.jsonl');
  writeFileSync(file, line('a'));
  const first = agentEventsIn(file);
  appendFileSync(file, line('b').repeat(5));
  const second = agentEventsIn(file);
  assert.equal(second.length, 6);
  assert.equal(second[0], first[0]);
});
