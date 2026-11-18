import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { SubagentLiveness, livenessKey } from '../src/claude-sessions/subagent-liveness.ts';
import { runNameOf } from '../src/subagent-meta.ts';

const SESSION = '5075b661-acf4-4be8-ba22-c1483d841cd2';
const SID = SESSION.slice(0, 8);
const NOW = Date.parse('2026-11-18T15:00:00Z');
const START = NOW - 3 * 3600 * 1000;

/** A subagent transcript with its meta under `<projects>/-x/<session>/subagents/`, last written `agoMs` before NOW. */
function transcript(
  projects: string,
  id: string,
  description: string | null,
  agoMs: number,
  session = SESSION,
): string {
  const folder = path.join(projects, '-x', session, 'subagents');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `agent-${id}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n');
  if (description !== null) {
    writeFileSync(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ description }));
  }
  const when = new Date(NOW - agoMs);
  utimesSync(file, when, when);
  return file;
}

const run = (name: string, startedMs = START) => ({ sid: SID, name, startedMs });
const key = (name: string) => livenessKey({ sid: SID, name });

test('a run whose newest transcript was written long ago has an old last write; a fresh one is alive; none found gives no entry', async () => {
  const projects = tmp('liveness-projects');
  transcript(projects, 'a', 'fix-login: the task', 2 * 3600 * 1000);
  transcript(projects, 'b', 'live-one: the task', 60 * 1000);
  const seen = await new SubagentLiveness().lastWrite(
    projects,
    [run('fix-login'), run('live-one'), run('never-wrote')],
    NOW,
  );
  assert.equal(seen.get(key('fix-login')), NOW - 2 * 3600 * 1000);
  assert.equal(seen.get(key('live-one')), NOW - 60 * 1000);
  assert.equal(seen.has(key('never-wrote')), false);
});

test('the newest of a run name`s transcripts wins; another run`s transcript in the same folder is ignored', async () => {
  const projects = tmp('liveness-newest');
  transcript(projects, 'a', 'fix-login: first', 2 * 3600 * 1000);
  transcript(projects, 'b', 'fix-login: resumed', 600 * 1000);
  transcript(projects, 'c', 'other-run: busy', 5 * 1000);
  const seen = await new SubagentLiveness().lastWrite(projects, [run('fix-login')], NOW);
  assert.equal(seen.get(key('fix-login')), NOW - 600 * 1000);
});

test('a transcript last written before the run started is an earlier run of the name, not this one', async () => {
  const projects = tmp('liveness-restart');
  transcript(projects, 'a', 'fix-login: first round', 5 * 3600 * 1000);
  const seen = await new SubagentLiveness().lastWrite(projects, [run('fix-login')], NOW);
  assert.equal(seen.has(key('fix-login')), false);
});

test('a session folder is found by the first 8 of its id, and another session`s folder is never used', async () => {
  const projects = tmp('liveness-sessions');
  transcript(projects, 'a', 'fix-login: task', 60 * 1000, '99999999-aaaa-bbbb-cccc-dddddddddddd');
  assert.equal((await new SubagentLiveness().lastWrite(projects, [run('fix-login')], NOW)).size, 0);
  transcript(projects, 'b', 'fix-login: task', 120 * 1000);
  const seen = await new SubagentLiveness().lastWrite(projects, [run('fix-login')], NOW);
  assert.equal(seen.get(key('fix-login')), NOW - 120 * 1000);
});

test('a meta with no house-form description, no meta, or a name the rule cannot read gives no entry', async () => {
  const projects = tmp('liveness-metas');
  transcript(projects, 'a', 'Fix the login bug', 60 * 1000);
  transcript(projects, 'b', null, 60 * 1000);
  transcript(projects, 'c', 'Fix_Login: task', 60 * 1000);
  const seen = await new SubagentLiveness().lastWrite(
    projects,
    [run('fix-login'), run('Fix_Login')],
    NOW,
  );
  assert.equal(seen.size, 0);
});

test('an unreadable or missing projects folder gives an empty map and never throws', async () => {
  const liveness = new SubagentLiveness();
  assert.equal(
    (await liveness.lastWrite(path.join(tmp('liveness-none'), 'nope'), [run('x')], NOW)).size,
    0,
  );
  const projects = tmp('liveness-locked');
  transcript(projects, 'a', 'fix-login: task', 60 * 1000);
  const folder = path.join(projects, '-x', SESSION, 'subagents');
  chmodSync(folder, 0o000);
  try {
    assert.equal(
      (await new SubagentLiveness().lastWrite(projects, [run('fix-login')], NOW)).size,
      0,
    );
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('a transcript with a zero mtime says nothing', async () => {
  const projects = tmp('liveness-zero');
  const file = transcript(projects, 'a', 'fix-login: task', 60 * 1000);
  utimesSync(file, new Date(0), new Date(0));
  assert.equal(
    (await new SubagentLiveness().lastWrite(projects, [run('fix-login', 0)], NOW)).size,
    0,
  );
});

test('a transcript that is written again moves the answer without a new listing; one that appears waits for the next listing', async () => {
  const projects = tmp('liveness-moves');
  const file = transcript(projects, 'a', 'fix-login: task', 3600 * 1000);
  const liveness = new SubagentLiveness();
  assert.equal(
    (await liveness.lastWrite(projects, [run('fix-login')], NOW)).get(key('fix-login')),
    NOW - 3600 * 1000,
  );
  const again = new Date(NOW - 1000);
  utimesSync(file, again, again);
  assert.equal(
    (await liveness.lastWrite(projects, [run('fix-login')], NOW + 1)).get(key('fix-login')),
    NOW - 1000,
  );
  transcript(projects, 'b', 'fix-login: another', 500);
  assert.equal(
    (await liveness.lastWrite(projects, [run('fix-login')], NOW + 2)).get(key('fix-login')),
    NOW - 1000,
  );
  assert.equal(
    (await liveness.lastWrite(projects, [run('fix-login')], NOW + 20000)).get(key('fix-login')),
    NOW - 500,
  );
});

test('runNameOf: the tool`s name, else the description`s name: prefix, else nothing', () => {
  assert.equal(runNameOf({ name: 'a-b', description: 'c-d: x' }), 'a-b');
  assert.equal(runNameOf({ name: null, description: 'c-d: x' }), 'c-d');
  assert.equal(runNameOf({ name: null, description: 'no colon' }), null);
  assert.equal(runNameOf(null), null);
});
