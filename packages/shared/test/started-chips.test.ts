import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChip, agentOnlyChips, startedChips } from '../src/util/started-chips.ts';
import type { BoardStartedLinks } from '../src/types.ts';

const links = (extra: Partial<BoardStartedLinks> = {}): BoardStartedLinks => ({
  worktrees: [],
  sessions: [],
  agent: null,
  merged: false,
  merged_at: null,
  active: false,
  ...extra,
});

test('a started card names its branch, then what is working it', () => {
  assert.deepEqual(
    startedChips({
      branch: 'kill-inbox',
      on: null,
      links: links({
        agent: {
          name: 'ou-kill-inbox',
          state: 'running',
          beat: { n: 3, of: 6, step: 'code', note: 'x' },
          outcome: null,
          ended_at: null,
        },
        worktrees: [{ path: '/d/widgets-worktrees/kill-inbox', name: 'kill-inbox' }],
        sessions: [{ id: 's', title: 'the builder' }],
      }),
    }),
    [
      'started on kill-inbox',
      'ou-kill-inbox 3/6 code',
      'worktree kill-inbox',
      'session the builder',
    ],
  );
});

test('a finished agent, a merge, and a card with nothing linked', () => {
  const done = links({
    agent: { name: 'ou-x', state: 'done', beat: null, outcome: 'ok', ended_at: null },
    merged: true,
  });
  assert.deepEqual(startedChips({ branch: 'x', on: null, links: done }), [
    'started on x',
    'merged',
    'ou-x done',
  ]);
  assert.deepEqual(startedChips({ branch: 'x', on: null, links: links() }), [
    'started on x',
    'no session yet',
  ]);
  assert.deepEqual(startedChips({ branch: 'x', on: 'Voice session' }), [
    'started on x',
    'session Voice session',
  ]);
  const waiting = links({
    agent: { name: 'ou-y', state: 'waiting', beat: null, outcome: null, ended_at: null },
  });
  assert.equal(startedChips({ branch: 'x', on: null, links: waiting })[1], 'ou-y waiting on you');
});

test('a failed or stopped agent is "tried by", and an open card an agent names has just the agent chip', () => {
  const agent = (state: NonNullable<BoardStartedLinks['agent']>['state']) => ({
    name: 'ou-x',
    state,
    beat: null,
    outcome: null,
    ended_at: null,
  });
  assert.equal(agentChip(agent('failed')), 'tried by ou-x (failed)');
  assert.equal(agentChip(agent('stopped')), 'tried by ou-x (stopped)');
  assert.deepEqual(agentOnlyChips({ links: links({ agent: agent('plan') }), tried: false }), [
    'ou-x plan ready',
  ]);
  assert.deepEqual(agentOnlyChips({ links: links(), tried: false }), []);
});
