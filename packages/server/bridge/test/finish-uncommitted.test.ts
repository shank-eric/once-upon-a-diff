import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { git, runCli, tmp } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { placeAgents } from '@once-upon-a-diff/board/stages/agents';
import type { BuildContext } from '@once-upon-a-diff/board/stages/types';

// D6: an author that finishes with changes left in its worktree and no commit is recorded once, at the finish ("left
// uncommitted changes"), and lands in Ready for your review. A finish with a commit, or a clean worktree, records nothing.
const SID = 'abcd1234';

function world() {
  const home = tmp('home');
  const fixture = worktreeFixture();
  const tree = fixture.add('feat-x');
  const start = () =>
    runCli(home, [
      'agent',
      'start',
      'au-x',
      '--kind',
      'author',
      '--task',
      'make it',
      '--branch',
      'feat-x',
      '--repo',
      'acme/widgets',
      '--cwd',
      fixture.main,
      '--sid',
      SID,
    ]);
  const finish = () => runCli(home, ['agent', 'finish', 'au-x', '--sid', SID]);
  const run = () => new AgentRegistry(home).agents().find((one) => one.name === 'au-x')!;
  const column = () => {
    const now = Date.now();
    const ctx = {
      home,
      now: new Date(now),
      nowMs: now,
      settings: { finishedWaitMinutes: 30, doneHours: 4 },
    };
    const cards = placeAgents(ctx as unknown as BuildContext, [], {
      agents: [run()],
      pin: null,
      items: [],
      trees: [],
    });
    return cards.map((one) => ({ column: one.column, why: one.agents[0].summary?.why }));
  };
  return { home, fixture, tree, start, finish, run, column };
}

test('agent finish of an author with uncommitted changes records it once, and the card lands in Ready', async () => {
  const ctx = world();
  assert.equal((await ctx.start()).code, 0);
  writeFileSync(path.join(ctx.tree, 'notes.txt'), 'not committed\n');
  const done = await ctx.finish();
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /left uncommitted changes/);
  assert.equal(ctx.run().state, 'done');
  assert.equal(ctx.run().uncommitted, true);
  const finishes = readFileSync(path.join(ctx.home, 'agents.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"op":"finish"'));
  assert.equal(finishes.length, 1);
  assert.equal(JSON.parse(finishes[0]).uncommitted, true);
  assert.deepEqual(ctx.column(), [{ column: 'ready', why: 'left uncommitted changes' }]);
  // the fact is the finish's: the worktree changing later (a commit) changes nothing recorded
  git(ctx.tree, 'add', '.');
  git(ctx.tree, 'commit', '-q', '-m', 'later');
  assert.equal(ctx.run().uncommitted, true);
});

test('a finish with a clean worktree, or with a commit, records nothing uncommitted', async () => {
  const clean = world();
  await clean.start();
  assert.equal((await clean.finish()).code, 0);
  assert.equal(clean.run().uncommitted, undefined);
  assert.deepEqual(clean.column(), [{ column: 'waiting', why: 'made nothing to point at' }]);

  const committed = world();
  await committed.start();
  committed.fixture.commit(committed.tree, 'one');
  writeFileSync(path.join(committed.tree, 'extra.txt'), 'x\n');
  assert.equal((await committed.finish()).code, 0);
  assert.equal(committed.run().uncommitted, undefined);
  assert.equal(committed.run().result?.commit, git(committed.tree, 'rev-parse', 'HEAD'));
});
