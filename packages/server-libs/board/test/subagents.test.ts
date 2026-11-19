import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubagentFile } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import type { BoardData, BoardSubagent } from '@once-upon-a-diff/contracts/types';
import {
  DONE_CAP,
  attachSubagents,
  capped,
  shownSessions,
  unregisteredRows,
} from '../src/stages/subagents.ts';

const NOW = Date.parse('2026-11-18T15:00:00Z');

const file = (id: string, over: Partial<SubagentFile> = {}): SubagentFile => ({
  id: `agent-${id}`,
  description: `look at ${id}`,
  name: null,
  agentType: 'general-purpose',
  state: 'done',
  startedMs: NOW - 60000,
  endedMs: NOW - 30000,
  ...over,
});

test('unregisteredRows drops a subagent that is a registered run of the session, by any of its names, and sorts running first then newest', () => {
  const files = [
    file('plain', { endedMs: NOW - 5000 }),
    file('by-name', { name: 'fix-login' }),
    file('by-prefix', { name: 'Odd_Name', description: 'Odd_Name: the task' }),
    file('by-first-word', { description: 'standing-helper kickoff of the thing' }),
    file('by-task', { description: 'Build the dispatching session cards from the plan' }),
    file('running-old', { state: 'running', endedMs: null, startedMs: NOW - 900000 }),
    file('newer', { endedMs: NOW - 1000 }),
  ];
  const rows = unregisteredRows(files, 'abcd1234', [
    { name: 'fix-login', task: 'fix it' },
    { name: 'Odd_Name', task: null },
    { name: 'standing-helper', task: 'wait' },
    { name: 'author-one', task: 'Build the dispatching session cards from the plan notes file' },
  ]);
  assert.deepEqual(
    rows.map((row) => row.key),
    ['abcd1234:agent-running-old', 'abcd1234:agent-newer', 'abcd1234:agent-plain'],
  );
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].ended_at, null);
  assert.equal(rows[1].description, 'look at newer');
});

test('the task-prefix match only counts for a run alive alongside the subagent: an old finished run does not hide a later one, a run started with it does', () => {
  const task = 'Check the dispatching session cards against the plan';
  const sub = file('later', { description: task, startedMs: NOW - 60000, endedMs: NOW - 30000 });
  const old = {
    name: 'old-run',
    task,
    started: new Date(NOW - 7200000),
    ended: new Date(NOW - 3600000),
  };
  assert.equal(unregisteredRows([sub], 'abcd1234', [old]).length, 1);
  const alongside = { name: 'new-run', task, started: new Date(NOW - 61000), ended: null };
  assert.equal(unregisteredRows([sub], 'abcd1234', [old, alongside]).length, 0);
});

test('a same-named run under another session does not hide a subagent, and a bare description falls back to the type', () => {
  const rows = unregisteredRows(
    [file('a', { name: 'fix-login' }), file('b', { description: null })],
    'abcd1234',
    [],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.key.endsWith('agent-b'))?.description, 'general-purpose');
});

test('capped keeps every running row and the newest finished ones, and counts the rest', () => {
  const entry = (num: number, state: BoardSubagent['state']): BoardSubagent => ({
    key: `s:${num}`,
    name: null,
    description: `d${num}`,
    agent_type: null,
    state,
    started_at: new Date(NOW - num * 1000).toISOString(),
    ended_at: null,
  });
  assert.equal(capped([]), null);
  const many = [
    entry(0, 'running'),
    ...Array.from({ length: DONE_CAP + 3 }, (_, num) => entry(num + 1, 'done')),
  ];
  const out = capped(many);
  assert.equal(out?.older, 3);
  assert.equal(out?.rows.length, 1 + DONE_CAP);
  assert.equal(out?.rows[0].state, 'running');
});

/** A board with a session card, a work card with two sessions and the strips, each naming a session. */
function world(): BoardData {
  const session = (id: string) => ({ id }) as BoardData['lanes'][0]['cards'][0]['sessions'][0];
  const card = (id: string, sessions: string[]) =>
    ({ id, kind: 'session', sessions: sessions.map(session) }) as BoardData['lanes'][0]['cards'][0];
  return {
    voice: { session: 'voice-1' },
    editors: [{ session: 'editor-1' }],
    listeners: [
      { repo: 'a/b', active: { session: 'listen-1' }, candidates: [] },
      { repo: 'c/d', active: null, candidates: [] },
    ],
    blank: [{ key: 'k', name: 'n', sessions: [{ id: 'blank-1' }] }],
    lanes: [
      { key: 'l', name: 'l', cards: [card('c1', ['own-1']), card('c2', ['work-1', 'work-2'])] },
    ],
  } as unknown as BoardData;
}

const row = (key: string, state: BoardSubagent['state'] = 'done', when = NOW): BoardSubagent => ({
  key,
  name: null,
  description: key,
  agent_type: null,
  state,
  started_at: new Date(when).toISOString(),
  ended_at: null,
});

test('shownSessions lists the sessions of every card and strip once', () => {
  assert.deepEqual(shownSessions(world()).sort(), [
    'blank-1',
    'editor-1',
    'listen-1',
    'own-1',
    'voice-1',
    'work-1',
    'work-2',
  ]);
});

test('attachSubagents puts rows on a session card, merges a work card`s sessions, and on the voice, editor, listener and blank entries; none where there are none', () => {
  const data = world();
  attachSubagents(
    data,
    new Map([
      ['own-1', [row('own')]],
      ['work-1', [row('w1')]],
      ['work-2', [row('w2', 'running')]],
      ['voice-1', [row('v')]],
      ['editor-1', [row('e')]],
      ['listen-1', [row('l')]],
      ['blank-1', [row('b')]],
    ]),
  );
  const [first, second] = data.lanes[0].cards;
  assert.deepEqual(
    first.subagents?.rows.map((one) => one.key),
    ['own'],
  );
  assert.deepEqual(
    second.subagents?.rows.map((one) => one.key),
    ['w2', 'w1'],
  );
  assert.deepEqual(
    data.voice?.subagents?.rows.map((one) => one.key),
    ['v'],
  );
  assert.deepEqual(
    data.editors[0].subagents?.rows.map((one) => one.key),
    ['e'],
  );
  assert.deepEqual(
    data.listeners[0].active?.subagents?.rows.map((one) => one.key),
    ['l'],
  );
  assert.deepEqual(
    data.blank[0].sessions[0].subagents?.rows.map((one) => one.key),
    ['b'],
  );
  const bare = world();
  attachSubagents(bare, new Map());
  assert.equal('subagents' in bare.lanes[0].cards[0], false);
});
