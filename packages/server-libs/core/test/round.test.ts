import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { git, worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { dispatchRun, finishRun, startRun, roundNote } from '../src/features/runs/service.ts';
import { roundBaseOf } from '../src/features/runs/round.ts';

/*
 * Round 2 of a card: new commits on a branch that was already pushed (origin/<branch> is behind it, and the card's earlier work
 * is on origin). The critic, the story and the review of that round cover origin/<branch>..HEAD, so a dispatch and a start say
 * the base, which is derived from the local origin ref and never stored.
 */

const SID = 'abcdef01';
const SESSION = `${SID}-1111-4222-8333-444444444444`;

/** A card on feat-x with a first commit; `author` finishes its work at it, `push` puts origin there and `second` adds the round's commit. */
function world() {
  const home = tmp('round-home');
  const fixture = worktreeFixture();
  const dir = fixture.add('feat-x');
  fixture.commit(dir, 'round one');
  const first = git(dir, 'rev-parse', 'HEAD');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A card', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat-x', repo: 'acme/widgets' });
  const dispatch = (over2: Partial<Parameters<typeof dispatchRun>[1]> = {}) =>
    dispatchRun(home, {
      card: item.id,
      role: 'author',
      cwd: fixture.main,
      session: SESSION,
      check: 'tests pass',
      task: 'build it',
      ...over2,
    });
  const agents = () => new AgentRegistry(home).agents();
  return {
    home,
    fixture,
    dir,
    first,
    card: item.id,
    store,
    dispatch,
    agents,
    /** the author's run, finished with its commit */
    async author() {
      await dispatch({ name: 'feat-x' });
      finishRun(home, 'feat-x', { sid: SID, result: { commit: first, branch: 'feat-x' } });
    },
    /** the user pushed: the tracking ref is at `sha` (a push updates it; no test runs a real push) */
    push(sha = first) {
      git(fixture.main, 'update-ref', 'refs/remotes/origin/feat-x', sha);
    },
    /** a commit on top, from round 2's fixer */
    second() {
      fixture.commit(dir, 'round two', 2);
      return git(dir, 'rev-parse', 'HEAD');
    },
    runs: () => agents().filter((run) => run.card === item.id),
  };
}

test('roundBaseOf: round 2 is origin/<branch> when the earlier round was pushed and the branch is ahead', async () => {
  const ctx = world();
  await ctx.author();
  ctx.push();
  ctx.second();
  const round = roundBaseOf({ branch: 'feat-x', pr: null }, ctx.runs(), ctx.fixture.main);
  assert.equal(round?.sha, ctx.first);
  assert.equal(round?.branch, 'feat-x');
  assert.ok(round?.at instanceof Date);
  assert.match(roundNote(round!), /round 2: .*origin\/feat-x = \w{7} \(.*\); .*\.\.HEAD only/);
});

test('roundBaseOf: no origin ref, a branch at origin, or origin not behind the branch is no round', async () => {
  const ctx = world();
  await ctx.author();
  const ask = () => roundBaseOf({ branch: 'feat-x', pr: null }, ctx.runs(), ctx.fixture.main);
  assert.equal(ask(), null, 'never pushed');
  ctx.push();
  assert.equal(ask(), null, 'nothing ahead of origin');
  const tip = ctx.second();
  // an amend after the push: origin's commit is no longer behind the branch
  git(ctx.dir, 'reset', '-q', '--hard', ctx.first);
  ctx.fixture.commit(ctx.dir, 'amended', 3);
  git(ctx.fixture.main, 'update-ref', 'refs/remotes/origin/feat-x', tip);
  assert.equal(ask(), null, 'a rewritten branch is not a round');
});

test('roundBaseOf: a push in the middle of round 1 (the author’s commit is not on origin) is not a round 2', async () => {
  const ctx = world();
  // a commit the author made and the user pushed, then the author's final commit on top, recorded as its work
  const earlier = git(ctx.fixture.main, 'rev-parse', 'main');
  ctx.push(earlier);
  await ctx.dispatch({ name: 'feat-x' });
  finishRun(ctx.home, 'feat-x', { sid: SID, result: { commit: ctx.first, branch: 'feat-x' } });
  assert.equal(roundBaseOf({ branch: 'feat-x', pr: null }, ctx.runs(), ctx.fixture.main), null);
});

test('roundBaseOf: a card with a PR and no work run (a PR made it) is a round 2 when the branch is ahead', () => {
  const ctx = world();
  ctx.push();
  ctx.second();
  assert.equal(roundBaseOf({ branch: 'feat-x', pr: null }, [], ctx.fixture.main), null);
  assert.equal(roundBaseOf({ branch: 'feat-x', pr: 7 }, [], ctx.fixture.main)?.sha, ctx.first);
});

test('roundBaseOf: a PR card with a follow-up author running is round 2', async () => {
  const ctx = world();
  ctx.push();
  ctx.second();
  // the PR made the card; round 2's author joined it, so the card has a work run and none of its commits is on origin
  await ctx.dispatch({ name: 'feat-x-more' });
  assert.equal(ctx.runs().length, 1);
  const ask = (pr: number | null) =>
    roundBaseOf({ branch: 'feat-x', pr }, ctx.runs(), ctx.fixture.main);
  assert.equal(ask(7)?.sha, ctx.first);
  assert.equal(ask(null), null, 'no PR and no pushed run: round 1');
});

test('roundBaseOf: a PR card whose recorded sha never reached origin (round 1 rewritten before the push) is round 2', async () => {
  const ctx = world();
  await ctx.author();
  ctx.push();
  ctx.second();
  const rewritten = ctx.runs().map((run) => ({ ...run, result: { commit: 'a'.repeat(40) } }));
  const ask = (pr: number | null) =>
    roundBaseOf({ branch: 'feat-x', pr }, rewritten, ctx.fixture.main);
  assert.equal(ask(7)?.sha, ctx.first);
  assert.equal(ask(null), null);
});

test('a critic and a storyteller dispatched in round 2 take origin/<branch> as the base, and --base wins', async () => {
  const ctx = world();
  await ctx.author();
  ctx.push();
  ctx.second();
  const critic = await ctx.dispatch({ role: 'critic', check: undefined, task: undefined });
  assert.equal(critic.round?.sha, ctx.first);
  assert.ok(
    critic.prompt.includes(`git diff ${ctx.first}...HEAD`),
    'the critic diffs from the sha',
  );
  finishRun(ctx.home, 'review-feat-x', { sid: SID, findings: 0 });
  const story = await ctx.dispatch({ role: 'storyteller', check: undefined, task: undefined });
  assert.equal(story.round?.sha, ctx.first);
  assert.ok(story.prompt.includes(ctx.first), 'the story is told over the sha');
  const typed = await ctx.dispatch({
    role: 'critic',
    name: 'review-again',
    base: 'main',
    check: undefined,
    task: undefined,
  });
  assert.equal(typed.round, null, 'a typed --base is the editor’s word');
  assert.match(typed.prompt, /git diff main\.\.\.HEAD/);
});

test('a first round, an author and a fixer keep the default base and print no round', async () => {
  const ctx = world();
  await ctx.author();
  const critic = await ctx.dispatch({ role: 'critic', check: undefined, task: undefined });
  assert.equal(critic.round, null);
  assert.match(critic.prompt, /git diff main\.\.\.HEAD/);
  ctx.push();
  ctx.second();
  finishRun(ctx.home, 'review-feat-x', { sid: SID, findings: 0 });
  const fixer = await ctx.dispatch({ role: 'fixer', check: 'tests pass' });
  assert.equal(fixer.round, null, 'only the critic and the storyteller read the round');
});

test('a critic started with --kind reviewer and no --card joins the branch’s one open card', async () => {
  const ctx = world();
  await ctx.author();
  ctx.push();
  ctx.second();
  const started = await startRun(ctx.home, {
    name: 'review-by-hand',
    sid: SID,
    kind: 'reviewer',
    task: 'review it',
    branch: 'feat-x',
    cwd: ctx.fixture.main,
  });
  assert.equal(started.joined?.card, ctx.card);
  assert.equal(started.card, ctx.card);
  assert.equal(started.round?.sha, ctx.first, 'the start says the round’s base too');
  await assert.rejects(
    startRun(ctx.home, {
      name: 'review-lost',
      sid: SID,
      kind: 'reviewer',
      task: 'review it',
      cwd: ctx.fixture.main,
    }),
    /a critic works on a card: pass --card ID/,
  );
});

test('an author started with --branch on the card joins it as new work and is told the round', async () => {
  const ctx = world();
  await ctx.author();
  ctx.push();
  ctx.second();
  const started = await startRun(ctx.home, {
    name: 'ou-more',
    sid: SID,
    kind: 'author',
    task: 'more',
    branch: 'feat-x',
    cwd: ctx.fixture.main,
  });
  assert.equal(started.card, ctx.card);
  assert.equal(started.round?.sha, ctx.first);
  assert.equal(ctx.store.items().filter((one) => one.branch === 'feat-x').length, 1, 'one card');
});
