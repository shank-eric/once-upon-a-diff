import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { claimAt, git, runCli, tmp, writeJson } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { foldAgentEvents } from '@once-upon-a-diff/state/records/agents/events';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { cardBranchProblems, cardRunProblems } from '@once-upon-a-diff/state/queues/backlog/phase';
import { parseWorktrees, startedLinks } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import { strictAgentEvent } from '@once-upon-a-diff/contracts/files/strict';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

// A card always carries its branch (bl_mw57dztcc38e9d): `backlog branch` moves a card and its open runs together, and
// `agent start --pr N` takes the PR's head branch from gh, so the board joins one piece of work to one card and its story.
const REPO = 'acme/widgets';
const SID = 'aaaaaaaa';

const cardOf = (store: BacklogStore, id: string) => store.items().find((one) => one.id === id);

/** How many worktrees the board's link rules find for a card, from the real `git worktree list`. */
function worktreesOf(store: BacklogStore, id: string, repoPath: string): number {
  const item = cardOf(store, id);
  const text = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  const links = startedLinks(item!, {
    worktrees: new Map([[REPO.toLowerCase(), parseWorktrees(text)]]),
    sessions: [],
    agents: [],
    merged: () => null,
  });
  return links?.worktrees.length ?? 0;
}

const cardsOf = async (home: string): Promise<BoardCard[]> =>
  (
    await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: registrySource,
      now: () => new Date(),
    }).snapshot()
  ).lanes.flatMap((lane) => lane.cards);

function localStory(home: string, id: string, repoPath: string, branch: string) {
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    base: 'origin/main',
    head: 'HEAD',
    branch,
    title: `Local ${id}`,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story of ${id}`, chapters: [] });
}

function prStory(home: string, id: string, number: number, branch: string) {
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'github',
    repo: REPO,
    number,
    pr_title: `PR ${number}`,
    head_ref: branch,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
}

/** A fake gh that answers `gh api repos/acme/widgets/pulls/91` with a head branch (or fails when `head` is null). */
function fakeGh(head: string | null) {
  const extra = path.join(tmp('card-branch-gh'), 'extra.json');
  writeJson(
    extra,
    head ? { 'repos/acme/widgets/pulls/91': { head: { ref: head, sha: 'a'.repeat(40) } } } : {},
  );
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-gh.ts');
  chmodSync(fake, 0o755);
  return { ONCE_UPON_GH: fake, ONCE_UPON_FAKE_GH_EXTRA: extra };
}

test('1. backlog branch: a renamed claimed card keeps its worktree, story and agent, and its run follows (no typed-branch line)', async () => {
  const home = tmp('card-branch-home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('card-branch-sessions') });
  const { main, add } = worktreeFixture();
  const tree = add('feat/old');
  seenCheckout(home, REPO, main);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Widgets, but better', repo: REPO });
  const claim = await runCli(home, [
    'backlog',
    'claim',
    item.id,
    '--agent',
    'old-build',
    '--sid',
    SID,
    '--branch',
    'feat/old',
    '--worktree',
    tree,
  ]);
  assert.equal(claim.code, 0, claim.stderr);
  const start = await runCli(home, [
    'agent',
    'start',
    'old-build',
    '--sid',
    SID,
    '--card',
    item.id,
    '--role',
    'author',
    '--task',
    'build it',
  ]);
  assert.equal(start.code, 0, start.stderr);
  localStory(home, 'local-widgets-feat-old', main, 'feat/old');

  const mine = async () =>
    (await cardsOf(home)).filter(
      (card) =>
        card.backlog?.id === item.id || card.from_backlog?.some((one) => one.id === item.id),
    );
  const before = await mine();
  assert.equal(before.length, 1);
  assert.equal(before[0].story?.id, 'local-widgets-feat-old');
  assert.equal(worktreesOf(store, item.id, main), 1);

  // the author renames its branch in git, and its story follows it
  git(tree, 'branch', '-m', 'feat/old', 'feat/new');
  localStory(home, 'local-widgets-feat-old', main, 'feat/new');
  const stranded = await mine();
  assert.equal(stranded[0]?.story ?? null, null, 'without the command the card loses its story');
  assert.equal(worktreesOf(store, item.id, main), 0, 'and its worktree');

  const moved = await runCli(home, ['backlog', 'branch', item.id, 'feat/new']);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, new RegExp(`${item.id} branch feat/old -> feat/new \\(runs: 1\\)`));
  assert.equal(cardOf(store, item.id)?.branch, 'feat/new');
  const agents = new AgentRegistry(home).agents();
  assert.equal(agents[0].branch, 'feat/new');
  assert.equal(agents[0].state, 'running', 'a branch event does not end the run');

  const after = await mine();
  assert.equal(after.length, 1);
  assert.equal(after[0].story?.id, 'local-widgets-feat-old');
  assert.equal(worktreesOf(store, item.id, main), 1);
  assert.equal(after[0].agents.length, 1);
  assert.equal(after[0].agents[0].name, 'old-build');
  assert.equal(after[0].branch, 'feat/new');
  const problems = cardRunProblems(store.items(), agents, Date.now());
  assert.deepEqual(
    problems.filter((line) => /typed branch/.test(line)),
    [],
  );

  // again is a no-op that says so, and the card keeps when it started
  const startedAt = cardOf(store, item.id)?.started_at;
  const again = await runCli(home, ['backlog', 'branch', item.id, 'feat/new']);
  assert.match(again.stdout, new RegExp(`${item.id} already on feat/new`));
  assert.equal(cardOf(store, item.id)?.started_at, startedAt);
});

test('backlog branch: refuses a dropped or done card, a bad name and a missing one; an open card gets its branch', async () => {
  const home = tmp('card-branch-refuse');
  const store = new BacklogStore(home);
  const open = store.add({ title: 'Not started', repo: REPO });
  const dropped = store.add({ title: 'Dropped', repo: REPO });
  store.drop(dropped.id);
  const noName = await runCli(home, ['backlog', 'branch', open.id]);
  assert.notEqual(noName.code, 0);
  assert.match(noName.stderr, /new branch/);
  const bad = await runCli(home, ['backlog', 'branch', open.id, 'not a branch']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /branch/);
  const gone = await runCli(home, ['backlog', 'branch', dropped.id, 'feat/x']);
  assert.notEqual(gone.code, 0);
  assert.match(gone.stderr, /dropped/);
  const landed = store.add({ title: 'Landed', repo: REPO });
  store.start(landed.id, { branch: 'feat/l' });
  store.done(landed.id, { sha: 'abc1234' });
  const over = await runCli(home, ['backlog', 'branch', landed.id, 'feat/m']);
  assert.notEqual(over.code, 0);
  assert.match(over.stderr, /is done/);
  // an open card gets a branch (that is a start), as `backlog start --branch` does
  const set = await runCli(home, ['backlog', 'branch', open.id, 'feat/x']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, new RegExp(`${open.id} branch none -> feat/x \\(runs: 0\\)`));
});

test('D3: a start on a card already started and not landed keeps who started it and when', () => {
  const store = new BacklogStore(tmp('card-branch-fold'));
  const item = store.add({ title: 'Rebranch', repo: REPO });
  store.start(item.id, { branch: 'feat/a', by: 'first' });
  const first = cardOf(store, item.id);
  const again = store.start(item.id, { branch: 'feat/b', by: 'second' });
  assert.equal(again.branch, 'feat/b');
  assert.equal(again.started_at, first?.started_at);
  assert.equal(again.started_by, 'first');
  // a landed card started again is new work: its start is new
  store.done(item.id, { sha: 'abc1234' });
  const restarted = store.start(item.id, { branch: 'feat/c', by: 'third' });
  assert.equal(restarted.started_by, 'third');
  assert.equal(restarted.landed_at, null);
});

test('events: a branch event sets the open run’s branch and nothing else; a stale run’s or a finished run’s is ignored', () => {
  const home = tmp('card-branch-events');
  const registry = new AgentRegistry(home, { ledger: null, progress: null });
  registry.start({ name: 'a', sid: SID, kind: 'author', task: 't', repo: REPO, branch: 'feat/a' });
  const open = registry.agents()[0];
  assert.equal(open.state, 'running');
  registry.setBranch('a', 'feat/b', { sid: SID });
  let run = registry.agents()[0];
  assert.equal(run.branch, 'feat/b');
  assert.equal(run.state, 'running');
  assert.equal(run.ended, null);
  assert.equal(run.notes ?? null, null);
  assert.equal(run.result, null);
  // the same branch writes nothing
  const lines = readFileSync(path.join(home, 'agents.jsonl'), 'utf8').split('\n').length;
  registry.setBranch('a', 'feat/b', { sid: SID });
  assert.equal(readFileSync(path.join(home, 'agents.jsonl'), 'utf8').split('\n').length, lines);
  // an event naming another run is not this run's
  const events = registry.events();
  const stale = { ...events[events.length - 1], branch: 'feat/zzz', run: 'r_0000000000' };
  assert.equal(foldAgentEvents([...events, stale])[0].branch, 'feat/b');
  // a finished run is not moved
  registry.finish('a', { sid: SID, outcome: 'done' });
  assert.throws(() => registry.setBranch('a', 'feat/c', { sid: SID }), /no open run/);
  run = registry.agents()[0];
  assert.equal(run.branch, 'feat/b');
  // the ledger log is not a line per branch event
});

test('write checks: a branch event with a bad name is refused', () => {
  const event = {
    v: 1,
    op: 'branch',
    id: `${SID}:a`,
    sid8: SID,
    name: 'a',
    at: new Date().toISOString(),
    by: 'cli',
    branch: 'feat/ok',
  };
  assert.deepEqual(strictAgentEvent(event), []);
  assert.notDeepEqual(strictAgentEvent({ ...event, branch: 'not a branch' }), []);
});

test('2. a storyteller started with --pr only is one work card with its story and the storyteller on it, and mints no card', async () => {
  const home = tmp('card-branch-pr');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('card-branch-pr-sess') });
  prStory(home, 'acme-widgets-91', 91, 'feat/x');
  const env = fakeGh('feat/x');
  const started = await runCli(
    home,
    [
      'agent',
      'start',
      'story-x',
      '--sid',
      SID,
      '--role',
      'storyteller',
      '--pr',
      '91',
      '--repo',
      REPO,
      '--task',
      'tell it',
    ],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  assert.doesNotMatch(started.stdout, /ic_/);
  const run = new AgentRegistry(home).agents()[0];
  assert.equal(run.branch, 'feat/x');
  assert.equal(run.pr, 91);
  assert.equal(run.card ?? null, null);
  const rows = readFileSync(path.join(home, 'agents.jsonl'), 'utf8');
  assert.doesNotMatch(rows, /"card":"ic_/);
  const cards = await cardsOf(home);
  const work = cards.filter((card) => card.kind === 'work');
  assert.equal(work.length, 1);
  assert.equal(work[0].story?.id, 'acme-widgets-91');
  assert.deepEqual(
    work[0].agents.map((agent) => agent.name),
    ['story-x'],
  );
  assert.equal(cards.filter((card) => card.kind === 'agent').length, 0, 'and no card of its own');
});

test('--pr with no card and no branch is stamped from gh for any run; a gh failure warns, and refuses a storyteller', async () => {
  const home = tmp('card-branch-pr-gh');
  const args = (name: string, ...more: string[]) => [
    'agent',
    'start',
    name,
    '--sid',
    SID,
    '--pr',
    '91',
    '--repo',
    REPO,
    '--kind',
    'helper',
    '--task',
    'work',
    ...more,
  ];
  const ok = await runCli(home, args('helper-a'), fakeGh('feat/y'));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(
    new AgentRegistry(home).agents().find((agent) => agent.name === 'helper-a')?.branch,
    'feat/y',
  );
  // gh fails: a plain run carries on with a warning
  const noGh = fakeGh(null);
  const warned = await runCli(home, args('helper-b'), noGh);
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /gh could not read #91/);
  // a storyteller has nothing to read without the branch: refused with the one-line hint
  // (a storyteller is its own kind now, so it is started by --role alone)
  const storyArgs = args('story-b', '--role', 'storyteller');
  storyArgs.splice(storyArgs.indexOf('--kind'), 2);
  const refused = await runCli(home, storyArgs, noGh);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /gh could not read #91/);
  assert.match(refused.stderr, /--branch NAME/);
});

test('refusals: a storyteller with nothing to read; a `story-` run with no role, PR or branch; a critic on a card with no branch', async () => {
  const home = tmp('card-branch-refusals');
  const store = new BacklogStore(home);
  const bare = store.add({ title: 'No branch yet', repo: REPO });
  const none = await runCli(home, [
    'agent',
    'start',
    'story-q',
    '--sid',
    SID,
    '--role',
    'storyteller',
    '--repo',
    REPO,
    '--task',
    't',
  ]);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /a storyteller needs --pr N, --branch NAME or --card ID/);
  const named = await runCli(home, [
    'agent',
    'start',
    'story-tst-1',
    '--sid',
    SID,
    '--repo',
    REPO,
    '--task',
    't',
  ]);
  assert.notEqual(named.code, 0);
  assert.match(
    named.stderr,
    /a story run needs --role storyteller with --pr N \(or --branch NAME\)/,
  );
  // a story- helper that has a branch is untouched
  const fine = await runCli(home, [
    'agent',
    'start',
    'story-ok',
    '--sid',
    SID,
    '--kind',
    'helper',
    '--repo',
    REPO,
    '--branch',
    'feat/q',
    '--task',
    't',
  ]);
  assert.equal(fine.code, 0, fine.stderr);
  // a storyteller with --branch and no card is let through
  const byBranch = await runCli(home, [
    'agent',
    'start',
    'story-r',
    '--sid',
    SID,
    '--role',
    'storyteller',
    '--repo',
    REPO,
    '--branch',
    'feat/r',
    '--task',
    't',
  ]);
  assert.equal(byBranch.code, 0, byBranch.stderr);
  // a critic on a card with no branch: the short hint names what works under --card
  const critic = await runCli(home, [
    'agent',
    'start',
    'review-q',
    '--sid',
    SID,
    '--role',
    'critic',
    '--card',
    bare.id,
    '--task',
    't',
  ]);
  assert.notEqual(critic.code, 0);
  assert.match(critic.stderr, new RegExp(`no branch on ${bare.id}`));
  assert.match(critic.stderr, /backlog branch/);
  assert.match(critic.stderr, /--pr N/);
});

test('--card with --pr on a card with no branch stamps the card from the PR’s head, then the run takes it', async () => {
  const home = tmp('card-branch-card-pr');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'From a PR', repo: REPO });
  const started = await runCli(
    home,
    [
      'agent',
      'start',
      'story-c',
      '--sid',
      SID,
      '--role',
      'storyteller',
      '--card',
      item.id,
      '--pr',
      '91',
      '--task',
      't',
    ],
    fakeGh('feat/c'),
  );
  assert.equal(started.code, 0, started.stderr);
  assert.equal(cardOf(store, item.id)?.branch, 'feat/c');
  assert.equal(new AgentRegistry(home).agents()[0].branch, 'feat/c');
  // a card that has a branch is left alone
  const other = store.add({ title: 'Has one', repo: REPO });
  store.start(other.id, { branch: 'feat/own' });
  const kept = await runCli(
    home,
    [
      'agent',
      'start',
      'story-d',
      '--sid',
      SID,
      '--role',
      'storyteller',
      '--card',
      other.id,
      '--pr',
      '91',
      '--task',
      't',
    ],
    fakeGh('feat/c'),
  );
  assert.equal(kept.code, 0, kept.stderr);
  assert.equal(cardOf(store, other.id)?.branch, 'feat/own');
});

test('doctor: a card claimed past the grace with no branch is flagged; a fresh claim, open, someday and landed cards are not', () => {
  const store = new BacklogStore(tmp('card-branch-doctor'));
  const now = Date.now();
  const hours = (count: number) => new Date(now - count * 3600 * 1000).toISOString();
  store.add({ title: 'Open', repo: REPO });
  const someday = store.add({ title: 'Someday', repo: REPO });
  store.someday(someday.id, true);
  const stale = store.add({ title: 'Claimed long ago, no branch', repo: REPO });
  claimAt(store, stale.id, 'someone', hours(5), SID);
  const fresh = store.add({ title: 'Just claimed', repo: REPO });
  claimAt(store, fresh.id, 'someone-else', hours(0.1), SID);
  const landed = store.add({ title: 'Landed', repo: REPO });
  store.start(landed.id, { branch: 'feat/l' });
  store.done(landed.id, { sha: 'abc1234' });
  const fine = store.add({ title: 'Fine', repo: REPO });
  store.start(fine.id, { branch: 'feat/fine' });
  claimAt(store, fine.id, 'third', hours(5), SID);
  const lines = cardBranchProblems(store.items(), now);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], new RegExp(`${stale.id} has no branch`));
});

test('fix 1: a renamed card whose earlier run finished on the old branch gets no typed-branch line', async () => {
  const home = tmp('card-branch-finished');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Renamed with history', repo: REPO });
  store.start(item.id, { branch: 'feat/old', repo: REPO });
  const registry = new AgentRegistry(home, { ledger: null, progress: null }, cardLookup(store));
  registry.start({ name: 'plan', sid: SID, kind: 'author', task: 'plan', card: item.id });
  registry.finish('plan', { sid: SID, outcome: 'planned' });
  registry.start({ name: 'build', sid: SID, kind: 'author', task: 'build', card: item.id });
  const moved = await runCli(home, ['backlog', 'branch', item.id, 'feat/new']);
  assert.equal(moved.code, 0, moved.stderr);
  const agents = new AgentRegistry(home).agents();
  assert.equal(agents[0].name === 'plan' ? agents[0].branch : agents[1]?.branch, 'feat/old');
  const lines = cardRunProblems(new BacklogStore(home).items(), agents, Date.now());
  assert.deepEqual(
    lines.filter((line) => /typed branch/.test(line)),
    [],
  );
  // an open run that really disagrees with its card is still flagged
  const stray = [{ ...agents[agents.length - 1], branch: 'feat/other' }];
  assert.equal(
    cardRunProblems(new BacklogStore(home).items(), stray, Date.now()).filter((line) =>
      /typed branch/.test(line),
    ).length,
    1,
  );
});

test('fix 2: a refused --card --pr start leaves the card’s branch unchanged', async () => {
  const home = tmp('card-branch-refused');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Refused start', repo: REPO });
  const refused = await runCli(
    home,
    [
      'agent',
      'start',
      'build-r',
      '--sid',
      SID,
      '--role',
      'author',
      '--card',
      item.id,
      '--pr',
      '91',
    ],
    fakeGh('feat/r'),
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /task is needed/);
  assert.equal(cardOf(store, item.id)?.branch ?? null, null);
  assert.equal(new AgentRegistry(home).agents().length, 0);
});

test('fix 3: a branch event is not a sign of life', () => {
  const home = tmp('card-branch-life');
  const registry = new AgentRegistry(home, { ledger: null, progress: null });
  registry.start({ name: 'a', sid: SID, kind: 'author', task: 't', repo: REPO, branch: 'feat/a' });
  registry.setBranch('a', 'feat/b', { sid: SID });
  const events = registry.events();
  const started = new Date(events[0].at);
  const late = new Date(started.getTime() + 48 * 3600_000).toISOString();
  events[events.length - 1] = { ...events[events.length - 1], at: late };
  const [run] = foldAgentEvents(events);
  assert.equal(run.branch, 'feat/b');
  assert.equal(run.lastEvent?.getTime(), started.getTime());
  // a beat still is one
  registry.beat('a', { n: 1, of: 2, step: 'read', sid: SID });
  const beat = registry.events();
  beat[beat.length - 1] = { ...beat[beat.length - 1], at: late };
  assert.equal(foldAgentEvents(beat)[0].lastEvent?.toISOString(), late);
});
