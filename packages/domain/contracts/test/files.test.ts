/*
 * The formats of the files the CLI and the bridge share (src/files/schemas.ts), against hand-written files in the old forms
 * the code has written over time: kinds `builder` and `reviewer`, no `v`, nulls everywhere, fields later cards add. Every line
 * of an accepted file must parse and keep its unknown fields; every line of a rejected file must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readAgentEvent,
  readBacklogEvent,
  readBuild,
  readFixRequest,
  readInboxEntry,
} from '../src/files/schemas.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url), 'utf8');
const lines = (name: string): string[] => fixture(name).split('\n').filter(Boolean);
const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const LOGS: [string, string, (value: unknown) => unknown][] = [
  ['agents.jsonl', 'agents-rejected.jsonl', readAgentEvent],
  ['backlog.jsonl', 'backlog-rejected.jsonl', readBacklogEvent],
  ['inbox.jsonl', 'inbox-legacy.jsonl', readInboxEntry],
];

for (const [accepted, rejected, read] of LOGS) {
  test(`${accepted}: every line of the old-form file parses`, () => {
    const refused = lines(accepted).filter((line) => read(parse(line)) === null);
    assert.deepEqual(refused, []);
  });
  test(`${rejected}: no line of it is taken`, () => {
    const taken = lines(rejected).filter((line) => read(parse(line)) !== null);
    assert.deepEqual(taken, []);
  });
}

test('a field the schema does not list survives a read', () => {
  const event = lines('agents.jsonl')
    .map(parse)
    .find((one) => (one as { a_field_later_cards_add?: unknown }).a_field_later_cards_add);
  assert.deepEqual((readAgentEvent(event) as Record<string, unknown>).a_field_later_cards_add, {
    x: 1,
  });
});

test('a field of the wrong type reads as absent, and null stays null', () => {
  const event = readAgentEvent({
    op: 'start',
    id: 'a:b',
    sid8: 'a',
    name: 'b',
    at: '2026-11-01T00:00:00Z',
    pr: 'twelve',
    notes: null,
    kind: 'wizard',
  });
  assert.equal(event?.pr, undefined);
  assert.equal(event?.notes, null);
  assert.equal(event?.kind, undefined);
});

test('the old kinds builder and reviewer are read as stored', () => {
  const kinds = lines('agents.jsonl')
    .map((line) => readAgentEvent(parse(line))?.kind)
    .filter(Boolean);
  assert.ok(kinds.includes('builder') && kinds.includes('reviewer') && kinds.includes('editor'));
});

test('builds.json and fixes.json: each record of the old-form files parses, and the refused ones do not', () => {
  const records = (name: string) =>
    Object.entries(JSON.parse(fixture(name)) as Record<string, unknown>);
  assert.deepEqual(
    records('builds.json').filter(([, one]) => readBuild(one) === null),
    [],
  );
  assert.deepEqual(
    records('fixes.json').filter(([, one]) => readFixRequest(one) === null),
    [],
  );
  assert.deepEqual(
    records('builds-rejected.json').filter(([, one]) => readBuild(one) !== null),
    [],
  );
});

test('a build keeps started_at and the fields it does not list', () => {
  const all = JSON.parse(fixture('builds.json')) as Record<string, unknown>;
  assert.equal(readBuild(all['acme/widgets#8'])?.started_at, '2026-10-22T19:11:00Z');
  assert.deepEqual(
    (readBuild(all['acme/widgets#9']) as Record<string, unknown>).a_field_later_cards_add,
    [1, 2],
  );
});

test('a note on a whole file (line null) is a note, and a note the schema refuses drops only itself', () => {
  const all = JSON.parse(fixture('fixes.json')) as Record<string, unknown>;
  const notes = readFixRequest(all.f_3)?.notes.map((note) => [note.id, note.line]);
  assert.deepEqual(notes, [
    ['n_3', 3],
    ['n_4', null],
  ]);
});
