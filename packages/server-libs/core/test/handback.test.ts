import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { git, worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { dispatchRun, handbackRun, startRun } from '../src/features/runs/service.ts';

/*
 * handbackRun records what a run made from the run's branch ref, never the HEAD of the folder it was registered in (the main
 * checkout), and finishes with what `agent finish` does.
 */

const SID = 'abcdef01';
const SESSION = `${SID}-1111-4222-8333-444444444444`;

function world() {
  const home = tmp('handback-home');
  const fixture = worktreeFixture();
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A card', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat-x', repo: 'acme/widgets' });
  const dispatch = (over: Partial<Parameters<typeof dispatchRun>[1]> = {}) =>
    dispatchRun(home, {
      card: item.id,
      role: 'author',
      cwd: fixture.main,
      session: SESSION,
      check: 'ok',
      task: 'do it',
      ...over,
    });
  const run = (name: string) => new AgentRegistry(home).agents().find((one) => one.name === name)!;
  return { home, fixture, store, card: item.id, dispatch, run };
}

test('done records the branch tip, the branch and the card: the tip of refs/heads, not main’s HEAD', async () => {
  const ctx = world();
  await ctx.dispatch();
  const tree = ctx.fixture.add('feat-x');
  ctx.fixture.commit(tree, 'one');
  const mainHead = git(ctx.fixture.main, 'rev-parse', 'HEAD');
  const tip = git(tree, 'rev-parse', 'HEAD');
  const done = handbackRun(ctx.home, 'feat-x', { outcome: 'built' });
  assert.deepEqual(done.warnings, []);
  assert.notEqual(tip, mainHead);
  assert.equal(ctx.run('feat-x').state, 'done');
  assert.deepEqual(ctx.run('feat-x').result, { commit: tip, branch: 'feat-x', card: ctx.card });
});

test('after an amend it reads the final tip; two commits finish with a warning', async () => {
  const ctx = world();
  await ctx.dispatch();
  const tree = ctx.fixture.add('feat-x');
  ctx.fixture.commit(tree, 'one');
  ctx.fixture.commit(tree, 'two', 2);
  const done = handbackRun(ctx.home, 'feat-x', {});
  assert.match(done.warnings.join('\n'), /2 commits above main: the rule is one commit/);
  assert.equal(ctx.run('feat-x').result?.commit, git(tree, 'rev-parse', 'HEAD'));
});

test('a branch with no commit of its own finishes with the card alone, and says so', async () => {
  const ctx = world();
  await ctx.dispatch();
  ctx.fixture.add('feat-x');
  const done = handbackRun(ctx.home, 'feat-x', { outcome: 'capped; notes hold the rest' });
  assert.match(done.warnings.join('\n'), /no commit of its own/);
  assert.deepEqual(ctx.run('feat-x').result, { card: ctx.card });
});

test('--no-commit records only the card, even with a commit on the branch', async () => {
  const ctx = world();
  await ctx.dispatch();
  const tree = ctx.fixture.add('feat-x');
  ctx.fixture.commit(tree, 'one');
  handbackRun(ctx.home, 'feat-x', { noCommit: true });
  assert.deepEqual(ctx.run('feat-x').result, { card: ctx.card });
});

test('--no-commit of an author with a dirty worktree records no "left uncommitted changes"', async () => {
  const ctx = world();
  await ctx.dispatch();
  const tree = ctx.fixture.add('feat-x');
  writeFileSync(path.join(tree, 'notes.txt'), 'not committed\n');
  const done = handbackRun(ctx.home, 'feat-x', { noCommit: true });
  assert.doesNotMatch(done.warnings.join('\n'), /uncommitted/);
  assert.equal(ctx.run('feat-x').uncommitted, undefined);
  // without --no-commit the same worktree is recorded
  const other = world();
  await other.dispatch();
  writeFileSync(path.join(other.fixture.add('feat-x'), 'notes.txt'), 'not committed\n');
  handbackRun(other.home, 'feat-x', {});
  assert.equal(other.run('feat-x').uncommitted, true);
});

test('--plan leaves the run in plan with the outcome "plan written"; the planner’s finish then records the card only', async () => {
  const ctx = world();
  await ctx.dispatch({ plan: true, check: undefined });
  const moved = handbackRun(ctx.home, 'feat-x', { plan: true });
  assert.equal(moved.ended, false);
  assert.equal(ctx.run('feat-x').state, 'plan');
  assert.equal(ctx.run('feat-x').outcome, 'plan written');
  const tree = ctx.fixture.add('feat-x');
  ctx.fixture.commit(tree, 'a planner that committed notes');
  handbackRun(ctx.home, 'feat-x', { outcome: 'plan checked' });
  assert.deepEqual(ctx.run('feat-x').result, { card: ctx.card });
});

test('waiting and review need an outcome; waiting moves the run, review parks it', async () => {
  const ctx = world();
  await ctx.dispatch();
  assert.throws(() => handbackRun(ctx.home, 'feat-x', { state: 'waiting' }), /needs --outcome/);
  handbackRun(ctx.home, 'feat-x', { state: 'waiting', outcome: 'which one?' });
  assert.equal(ctx.run('feat-x').state, 'waiting');
  assert.equal(ctx.run('feat-x').outcome, 'which one?');
  handbackRun(ctx.home, 'feat-x', { state: 'review', outcome: 'story-1' });
  assert.equal(ctx.run('feat-x').review, true);
});

test('a carded critic finishes with --findings; without it the registry refuses', async () => {
  const ctx = world();
  await ctx.dispatch({ role: 'critic', check: undefined, task: undefined });
  assert.throws(() => handbackRun(ctx.home, 'review-feat-x', {}), /findings count/);
  handbackRun(ctx.home, 'review-feat-x', { findings: '0', outcome: 'none' });
  assert.equal(ctx.run('review-feat-x').findings, 0);
  assert.equal(ctx.run('review-feat-x').state, 'done');
});

test('it finds the run under the editor’s session when the caller is another session, and --sid picks one of two', async () => {
  const ctx = world();
  await ctx.dispatch();
  const done = handbackRun(ctx.home, 'feat-x', { prefer: '99999999', outcome: 'x' });
  assert.equal(done.run.sid, SID);
  assert.equal(ctx.run('feat-x').state, 'done');
  // two sessions with an open run of one name: the caller must say which
  const other = tmp('handback-two');
  for (const sid of ['aaaaaaaa', 'bbbbbbbb']) {
    await startRun(other, { name: 'dup', sid, task: 't', role: 'helper', cwd: ctx.fixture.main });
  }
  assert.throws(() => handbackRun(other, 'dup', {}), /more than one session/);
  handbackRun(other, 'dup', { sid: 'bbbbbbbb' });
  const runs = new AgentRegistry(other).agents();
  assert.equal(runs.find((one) => one.sid === 'bbbbbbbb')?.state, 'done');
  assert.equal(runs.find((one) => one.sid === 'aaaaaaaa')?.state, 'running');
});

test('a finished run says it already finished', async () => {
  const ctx = world();
  await ctx.dispatch();
  handbackRun(ctx.home, 'feat-x', {});
  assert.throws(() => handbackRun(ctx.home, 'feat-x', {}), /already finished/);
});
