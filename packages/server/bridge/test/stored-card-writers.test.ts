import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, runCli, tmp } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';

// ADR-29, branch A: an author's finish takes its commit and branch from git in its worktree, the start stores the worktree
// the run works in on the card, a finish teaches a card its branch, and `card link` / `card status` speak for the record.
const SID = 'abcd1234';

function world(branch = 'feat-x') {
  const home = tmp('home');
  const fixture = worktreeFixture();
  const tree = fixture.add(branch);
  const start = (...extra: string[]) =>
    runCli(home, [
      'agent',
      'start',
      'au-x',
      '--role',
      'author',
      '--task',
      'make it',
      '--branch',
      branch,
      '--repo',
      'acme/widgets',
      '--cwd',
      tree,
      '--sid',
      SID,
      ...extra,
    ]);
  const finish = (...extra: string[]) =>
    runCli(home, ['agent', 'finish', 'au-x', '--sid', SID, ...extra]);
  const run = () => new AgentRegistry(home).agents().find((one) => one.name === 'au-x')!;
  return { home, fixture, tree, start, finish, run };
}

test('a start in a worktree on its branch stores that worktree on the card it makes', async () => {
  const ctx = world();
  const started = await ctx.start();
  assert.equal(started.code, 0, started.stderr);
  const [card] = new BacklogStore(ctx.home).items();
  assert.equal(card.source, 'agent');
  assert.equal(card.worktree, ctx.tree);
  assert.equal(card.branch, 'feat-x');
  // a start from the main checkout (a dispatched author makes its worktree later) stores none
  const main = world('feat-y');
  const mainStart = await runCli(main.home, [
    'agent',
    'start',
    'au-x',
    '--role',
    'author',
    '--task',
    'make it',
    '--branch',
    'feat-y',
    '--repo',
    'acme/widgets',
    '--cwd',
    main.fixture.main,
    '--sid',
    SID,
  ]);
  assert.equal(mainStart.code, 0, mainStart.stderr);
  assert.equal(new BacklogStore(main.home).items()[0].worktree, null);
});

test('a finish with no --commit records the worktree HEAD and its branch', async () => {
  const ctx = world();
  assert.equal((await ctx.start()).code, 0);
  ctx.fixture.commit(ctx.tree, 'one');
  const head = git(ctx.tree, 'rev-parse', 'HEAD');
  const done = await ctx.finish();
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(ctx.run().result, { commit: head, branch: 'feat-x' });
});

test('a typed commit that is not in the worktree history is replaced by HEAD and warns; one behind HEAD stands, quietly', async () => {
  const wrong = world();
  assert.equal((await wrong.start()).code, 0);
  wrong.fixture.commit(wrong.tree, 'one');
  const head = git(wrong.tree, 'rev-parse', 'HEAD');
  const warned = await wrong.finish('--commit', 'deadbeef');
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /--commit deadbeef is not in/);
  assert.equal(wrong.run().result?.commit, head);

  const behind = world();
  assert.equal((await behind.start()).code, 0);
  behind.fixture.commit(behind.tree, 'one');
  const first = git(behind.tree, 'rev-parse', 'HEAD');
  behind.fixture.commit(behind.tree, 'two', 2);
  const quiet = await behind.finish('--commit', first);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /not in/);
  assert.equal(
    behind.run().result?.commit,
    first,
    'a later fixup does not make the typed commit wrong',
  );
});

test('a detached worktree, or a run whose checkout is on another branch, keeps what was typed and says nothing', async () => {
  const detached = world();
  assert.equal((await detached.start()).code, 0);
  detached.fixture.commit(detached.tree, 'one');
  git(detached.tree, 'checkout', '-q', '--detach');
  const typed = git(detached.tree, 'rev-parse', 'HEAD~1');
  const done = await detached.finish('--commit', typed);
  assert.equal(done.code, 0, done.stderr);
  assert.doesNotMatch(done.stderr, /not in/);
  assert.equal(detached.run().result?.commit, typed);

  // started from the main checkout (on main): git there says nothing about the branch, the typed commit stands
  const main = world('feat-z');
  const started = await runCli(main.home, [
    'agent',
    'start',
    'au-x',
    '--role',
    'author',
    '--task',
    'make it',
    '--branch',
    'feat-z',
    '--repo',
    'acme/widgets',
    '--cwd',
    main.fixture.main,
    '--sid',
    SID,
  ]);
  assert.equal(started.code, 0, started.stderr);
  main.fixture.commit(main.tree, 'one');
  const sha = git(main.tree, 'rev-parse', 'HEAD');
  const finished = await main.finish('--commit', sha);
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal(main.run().result?.commit, sha);
});

test('a finish teaches a card that has no branch the branch git found, before the finish row', async () => {
  const ctx = world();
  const add = await runCli(ctx.home, ['backlog', 'add', 'No branch yet', '--repo', 'acme/widgets']);
  const card = add.stdout.split(' ')[0];
  assert.equal(
    (await runCli(ctx.home, ['backlog', 'claim', card, '--agent', 'au-x', '--sid', SID])).code,
    0,
  );
  const started = await runCli(ctx.home, [
    'agent',
    'start',
    'au-x',
    '--role',
    'author',
    '--card',
    card,
    '--task',
    'make it',
    '--cwd',
    ctx.tree,
    '--sid',
    SID,
  ]);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(new BacklogStore(ctx.home).items()[0].branch, null);
  ctx.fixture.commit(ctx.tree, 'one');
  assert.equal((await ctx.finish()).code, 0);
  assert.equal(new BacklogStore(ctx.home).items()[0].branch, 'feat-x');
  assert.equal(ctx.run().result?.branch, 'feat-x');
});

test('card link writes a story onto a stored card; card status shows the record; a bad id or a PR number is refused', async () => {
  const ctx = world();
  assert.equal((await ctx.start()).code, 0);
  const [card] = new BacklogStore(ctx.home).items();
  const linked = await runCli(ctx.home, ['card', 'link', card.id, '--story', 'acme-widgets-3']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.match(linked.stdout, /story acme-widgets-3/);
  assert.equal(new BacklogStore(ctx.home).items()[0].story, 'acme-widgets-3');
  const status = await runCli(ctx.home, ['card', 'status', card.id]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /record: source agent, worktree .*feat-x, story acme-widgets-3/);
  const json = JSON.parse((await runCli(ctx.home, ['card', 'status', card.id, '--json'])).stdout);
  assert.equal(json.source, 'agent');
  assert.equal(json.story, 'acme-widgets-3');
  assert.notEqual(
    (await runCli(ctx.home, ['card', 'link', 'ic_nosuchcard12', '--story', 'x'])).code,
    0,
  );
  assert.match(
    (await runCli(ctx.home, ['card', 'link', card.id, '--pr', 'abc'])).stderr,
    /PR number/,
  );
});

// review findings (11/18)

test('a finish with no start tip and no --commit records no commit when the branch has nothing over main; --no-commit records none even with one', async () => {
  const ctx = world('feat-q');
  // the branch does not exist yet when the run starts from the main checkout: no start tip
  const started = await runCli(ctx.home, [
    'agent',
    'start',
    'au-q',
    '--role',
    'author',
    '--task',
    'make it',
    '--branch',
    'feat-q2',
    '--repo',
    'acme/widgets',
    '--cwd',
    ctx.fixture.main,
    '--sid',
    SID,
  ]);
  assert.equal(started.code, 0, started.stderr);
  const [card] = new BacklogStore(ctx.home).items();
  const late = ctx.fixture.add('feat-q2');
  assert.equal((await runCli(ctx.home, ['card', 'link', card.id, '--worktree', late])).code, 0);
  const done = await runCli(ctx.home, ['agent', 'finish', 'au-q', '--sid', SID]);
  assert.equal(done.code, 0, done.stderr);
  const run = new AgentRegistry(ctx.home).agents().find((one) => one.name === 'au-q')!;
  assert.equal(run.result?.commit, undefined, 'the base commit is not what the author made');

  // --no-commit: the worktree is not read, whatever it holds
  const other = world('feat-r');
  assert.equal((await other.start()).code, 0);
  other.fixture.commit(other.tree, 'one');
  const skipped = await runCli(other.home, ['handback', 'au-x', '--sid', SID, '--no-commit']);
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.equal(other.run().result?.commit, undefined);
});

test('a typed --branch main on a finish is never stamped onto a card', async () => {
  const ctx = world();
  const add = await runCli(ctx.home, ['backlog', 'add', 'No branch yet', '--repo', 'acme/widgets']);
  const card = add.stdout.split(' ')[0];
  assert.equal(
    (await runCli(ctx.home, ['backlog', 'claim', card, '--agent', 'au-x', '--sid', SID])).code,
    0,
  );
  const started = await runCli(ctx.home, [
    'agent',
    'start',
    'au-x',
    '--role',
    'author',
    '--card',
    card,
    '--task',
    'make it',
    '--cwd',
    ctx.fixture.main,
    '--sid',
    SID,
  ]);
  assert.equal(started.code, 0, started.stderr);
  const done = await ctx.finish(
    '--branch',
    'main',
    '--commit',
    git(ctx.fixture.main, 'rev-parse', 'HEAD'),
  );
  assert.equal(done.code, 0, done.stderr);
  assert.equal(new BacklogStore(ctx.home).items()[0].branch, null);
});

test('card link refuses a --branch that is not the PR head, and a --branch that moves a card that has one', async () => {
  const ctx = world();
  assert.equal((await ctx.start()).code, 0);
  const [card] = new BacklogStore(ctx.home).items();
  const moved = await runCli(ctx.home, ['card', 'link', card.id, '--branch', 'feat-other']);
  assert.notEqual(moved.code, 0);
  assert.match(moved.stderr, /backlog branch/);
  assert.equal(new BacklogStore(ctx.home).items()[0].branch, 'feat-x');
  // the same branch again is fine
  assert.equal((await runCli(ctx.home, ['card', 'link', card.id, '--branch', 'feat-x'])).code, 0);
});

test('card link --pr N --branch B refuses a B that is not the PR head, and links the PR head when the card has none', async () => {
  const ctx = world();
  const fakeGh = tmp('fake-gh');
  writeFileSync(path.join(fakeGh, 'gh'), '#!/bin/sh\necho \'{"head":{"ref":"feat-pr"}}\'\n', {
    mode: 0o755,
  });
  const env = { PATH: `${fakeGh}:${process.env.PATH}` };
  const add = await runCli(ctx.home, ['backlog', 'add', 'A PR card', '--repo', 'acme/widgets']);
  const card = add.stdout.split(' ')[0];
  const wrong = await runCli(
    ctx.home,
    ['card', 'link', card, '--pr', '9', '--branch', 'feat-other'],
    env,
  );
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /feat-pr/);
  const stored = () => new BacklogStore(ctx.home).items().find((one) => one.id === card)!;
  assert.equal(stored().branch, null);
  assert.equal(stored().pr, null);
  const right = await runCli(ctx.home, ['card', 'link', card, '--pr', '9'], env);
  assert.equal(right.code, 0, right.stderr);
  assert.equal(stored().branch, 'feat-pr');
  assert.equal(stored().pr, 9);

  // a card already on the PR's head branch: a typed other branch is not written
  const onBranch = await runCli(ctx.home, [
    'backlog',
    'add',
    'On a branch',
    '--repo',
    'acme/widgets',
    '--branch',
    'feat-pr',
  ]);
  const onCard = onBranch.stdout.split(' ')[0];
  const other = await runCli(
    ctx.home,
    ['card', 'link', onCard, '--pr', '9', '--branch', 'feat-y'],
    env,
  );
  assert.notEqual(other.code, 0);
  assert.equal(
    new BacklogStore(ctx.home).items().find((one) => one.id === onCard)!.branch,
    'feat-pr',
  );
});
