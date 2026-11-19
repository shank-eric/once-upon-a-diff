import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { SubagentLiveness } from '../src/claude-sessions/subagent-liveness.ts';

const SESSION = '5075b661-acf4-4be8-ba22-c1483d841cd2';
const SID = SESSION.slice(0, 8);
const NOW = Date.parse('2026-11-18T15:00:00Z');
const QUIET = 30 * 60 * 1000;
const KEEP = 60 * 60 * 1000;
const LIMITS = { quietMs: QUIET, keepMs: KEEP };

/** A subagent transcript last written `agoMs` before NOW, with a meta (`null`: none) beside it. */
function subagent(
  projects: string,
  id: string,
  meta: Record<string, unknown> | null,
  agoMs: number,
): string {
  const folder = path.join(projects, '-x', SESSION, 'subagents');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `agent-${id}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n');
  if (meta) {
    writeFileSync(path.join(folder, `agent-${id}.meta.json`), JSON.stringify(meta));
  }
  const when = new Date(NOW - agoMs);
  utimesSync(file, when, when);
  return file;
}

const rowsOf = (projects: string, live = new SubagentLiveness()) =>
  live.subagentsOf(projects, SID, NOW, LIMITS);

test('a subagent still writing is running; one marked finished is done at its last write; a quiet one with no mark is done too', async () => {
  const projects = tmp('subagents-states');
  subagent(projects, 'run', { description: 'look at X', agentType: 'Explore' }, 20 * 1000);
  subagent(projects, 'fin', { description: 'fetch Y', finished: true }, 5 * 60 * 1000);
  subagent(projects, 'killed', { description: 'dead one' }, 40 * 60 * 1000);
  const rows = await rowsOf(projects);
  const pick = (id: string) => rows.find((row) => row.id === `agent-${id}`);
  assert.equal(pick('run')?.state, 'running');
  assert.equal(pick('run')?.endedMs, null);
  assert.equal(pick('run')?.agentType, 'Explore');
  assert.equal(pick('fin')?.state, 'done');
  assert.equal(pick('fin')?.endedMs, NOW - 5 * 60 * 1000);
  assert.equal(pick('killed')?.state, 'done');
  // a finished mark wins over a fresh write
  subagent(projects, 'late', { description: 'just done', finished: true }, 1000);
  assert.equal(
    (await rowsOf(projects, new SubagentLiveness())).find((row) => row.id === 'agent-late')?.state,
    'done',
  );
});

test('the name is the tool`s name, else the description`s prefix whatever its letters; no meta gives a row with nothing to say', async () => {
  const projects = tmp('subagents-names');
  subagent(projects, 'a', { name: 'Fix_Login', description: 'something' }, 1000);
  subagent(projects, 'b', { description: 'Plan_Check: the task' }, 2000);
  subagent(projects, 'c', { description: 'Fetch the page' }, 3000);
  subagent(projects, 'd', null, 4000);
  const rows = await rowsOf(projects);
  const name = (id: string) => rows.find((row) => row.id === `agent-${id}`)?.name;
  assert.equal(name('a'), 'Fix_Login');
  assert.equal(name('b'), 'Plan_Check');
  assert.equal(name('c'), null);
  const none = rows.find((row) => row.id === 'agent-d');
  assert.equal(none?.description, null);
  assert.equal(none?.state, 'running');
});

test('no session folder, or another session`s, is no rows', async () => {
  const projects = tmp('subagents-none');
  assert.deepEqual(await rowsOf(projects), []);
  const other = path.join(projects, '-x', '99999999-aaaa-bbbb-cccc-dddddddddddd', 'subagents');
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, 'agent-z.jsonl'), '{}\n');
  assert.deepEqual(await rowsOf(projects, new SubagentLiveness()), []);
});

test('a transcript last written before keepMs is not read at all', async () => {
  const projects = tmp('subagents-keep');
  subagent(projects, 'old', { description: 'ancient', finished: true }, 2 * KEEP);
  subagent(projects, 'new', { description: 'recent', finished: true }, 60 * 1000);
  const rows = await rowsOf(projects);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['agent-new'],
  );
});

test('a finished meta is read once; an unfinished one is read again when its transcript is written', async () => {
  const projects = tmp('subagents-cache');
  const file = subagent(projects, 'a', { description: 'first look', finished: true }, 60 * 1000);
  const live = new SubagentLiveness();
  assert.equal((await rowsOf(projects, live))[0].description, 'first look');
  // the meta is gone from disk: the finished one was cached, so the row stays
  rmSync(file.replace('.jsonl', '.meta.json'));
  assert.equal((await rowsOf(projects, live))[0].description, 'first look');
  // an unfinished one changes with its transcript's write
  const run = subagent(projects, 'b', { description: 'before' }, 10 * 1000);
  const again = new SubagentLiveness();
  assert.equal(
    (await rowsOf(projects, again)).find((row) => row.id === 'agent-b')?.description,
    'before',
  );
  writeFileSync(run.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'after' }));
  const when = new Date(NOW - 5 * 1000);
  utimesSync(run, when, when);
  // the listing is cached for 10 seconds: ask again after it
  const later = await again.subagentsOf(projects, SID, NOW + 11000, LIMITS);
  assert.equal(later.find((row) => row.id === 'agent-b')?.description, 'after');
});

test('a meta rewritten with `finished` after the transcript`s last write is read again: the row turns done', async () => {
  const projects = tmp('subagents-meta-late');
  const run = subagent(projects, 'a', { description: 'fetch Z' }, 10 * 1000);
  const live = new SubagentLiveness();
  assert.equal(
    (await rowsOf(projects, live)).find((row) => row.id === 'agent-a')?.state,
    'running',
  );
  const metaFile = run.replace('.jsonl', '.meta.json');
  writeFileSync(metaFile, JSON.stringify({ description: 'fetch Z', finished: true }));
  const later = new Date(NOW + 5000);
  utimesSync(metaFile, later, later);
  const rows = await live.subagentsOf(projects, SID, NOW + 11000, LIMITS);
  assert.equal(rows.find((row) => row.id === 'agent-a')?.state, 'done');
});
