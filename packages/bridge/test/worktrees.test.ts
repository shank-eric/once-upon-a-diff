import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git } from './helpers.ts';
import { fixture } from './worktree-fixture.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { BacklogStore } from '../src/services/backlog/backlog.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { seenCheckout } from '../src/services/config/repos.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import {
  WorktreeScanner,
  judge,
  parseWorktreeEntries,
  workingIn,
  type JudgeContext,
  type WorktreeFacts,
} from '../src/services/worktrees/worktrees.ts';
import { runCommand, type Runner } from '../src/adapters/os.ts';
import type { BoardCard } from '@once-upon-a-diff/protocol/types';

/** A scan to its end: kicks it and waits. */
async function scanned(scanner: WorktreeScanner, seeds: string[]) {
  scanner.kick(seeds);
  await scanner.idle();
  return scanner.read();
}
const byName = (items: WorktreeFacts[], name: string) =>
  items.find((one) => path.basename(one.path) === name) as WorktreeFacts;

const NOW = Date.parse('2026-10-29T20:00:00Z');
const context = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  inUse: [],
  pr: { number: null, state: 'none' },
  keepBranches: ['everfi-frontend'],
  now: NOW,
  ...over,
});
const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  path: '/d/widgets-worktrees/x',
  main: '/d/widgets',
  mainBranch: 'main',
  defaultBranch: 'main',
  repo: 'acme/widgets',
  branch: 'x',
  head: 'abc',
  detached: false,
  locked: false,
  lastCommitMs: NOW - 3 * 24 * 3600 * 1000,
  created: NOW - 3 * 24 * 3600 * 1000,
  unmoved: false,
  modified: 0,
  untracked: 0,
  statusHead: 'abc',
  statusAt: NOW,
  unpushed: 0,
  sizeKb: 100,
  sizeAt: NOW,
  merged: true,
  superseded: false,
  onRemote: false,
  reachable: true,
  ignored: [],
  ...over,
});

test('parseWorktreeEntries reads head, branch, detached, locked and prunable', () => {
  const text = [
    'worktree /d/widgets',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /d/widgets-worktrees/a',
    'HEAD bbbb',
    'branch refs/heads/feat/a',
    'locked because',
    '',
    'worktree /d/widgets-worktrees/split',
    'HEAD cccc',
    'detached',
    '',
    'worktree /d/widgets-worktrees/gone',
    'HEAD dddd',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const [main, linked, split, gone] = parseWorktreeEntries(text);
  assert.deepEqual([main.path, main.branch, main.detached], ['/d/widgets', 'main', false]);
  assert.deepEqual([linked.branch, linked.locked, linked.head], ['feat/a', true, 'bbbb']);
  assert.deepEqual([split.branch, split.detached], [null, true]);
  assert.equal(gone.prunable, 'gitdir file points to non-existent location');
});

test('judge: clean and merged is removable, and says whether the branch goes too', () => {
  const found = judge(facts(), context());
  assert.equal(found.removable, true);
  assert.equal(found.verdict, 'merged');
  assert.equal(found.deletes_branch, true);
  assert.deepEqual(found.keep, []);
  // unpushed commits do not matter once the work is in live
  assert.equal(judge(facts({ unpushed: 4 }), context()).removable, true);
});

test('judge: every reason to keep a worktree', () => {
  const keep = (over: Partial<WorktreeFacts>, ctx: Partial<JudgeContext> = {}) =>
    judge(facts(over), context(ctx));
  assert.match(
    keep({ modified: 2, untracked: 1 }).keep.join(),
    /dirty \(2 modified, 1 untracked\)/,
  );
  assert.equal(keep({ modified: 0, untracked: 3 }).removable, false, 'untracked files count');
  assert.equal(keep({ modified: null, untracked: null }).state, 'unknown');
  assert.equal(
    keep({ modified: null, untracked: null }).removable,
    false,
    'an unknown status is not clean',
  );
  assert.match(
    keep({}, { inUse: [{ kind: 'agent', id: 'ou-builder', label: 'the builder' }] }).keep.join(),
    /in use by the builder/,
  );
  assert.match(keep({ locked: true }).keep.join(), /locked/);
  assert.match(keep({ loaded: true }).keep.join(), /scanning/);
  assert.match(keep({ merged: false, superseded: false }).keep.join(), /not in the main line/);
  assert.match(keep({ merged: null, superseded: null }).keep.join(), /not known/);
  const unpushed = keep({ merged: false, superseded: false, unpushed: 2 });
  assert.match(unpushed.keep.join(), /2 unpushed/);
  assert.match(
    keep({ merged: false, superseded: false }, { pr: { number: 5, state: 'open' } }).keep.join(),
    /PR #5 open/,
  );
  assert.match(keep({ branch: 'main' }).keep.join(), /default branch/);
  assert.match(
    keep({ branch: 'phone/live', mainBranch: 'phone/live' }).keep.join(),
    /default branch/,
  );
});

test('judge: new worktrees are never offered, superseded ones are, with the branch kept', () => {
  const fresh = judge(facts({ unmoved: true }), context());
  assert.equal(fresh.verdict, 'new');
  assert.equal(fresh.removable, false);
  const justMade = judge(facts({ created: NOW - 5 * 60 * 1000 }), context());
  assert.equal(justMade.verdict, 'new');
  assert.equal(justMade.removable, false);
  const copied = judge(facts({ merged: false, superseded: true }), context());
  assert.equal(copied.verdict, 'superseded');
  assert.equal(copied.removable, true);
  assert.equal(copied.deletes_branch, false, 'a superseded branch is kept');
  const prMerged = judge(
    facts({ merged: false, superseded: false }),
    context({ pr: { number: 3, state: 'merged' } }),
  );
  assert.equal(prMerged.verdict, 'pr_merged');
  assert.equal(prMerged.removable, true);
  assert.equal(prMerged.deletes_branch, false);
  const unpushedAfterMerge = judge(
    facts({ merged: false, superseded: false, unpushed: 1 }),
    context({ pr: { number: 3, state: 'merged' } }),
  );
  assert.equal(unpushedAfterMerge.removable, false, 'commits after the PR merged are not safe');
  const detached = judge(facts({ branch: null, detached: true }), context());
  assert.equal(detached.removable, true);
  assert.equal(detached.deletes_branch, false);
});

test('judge: an everfi-frontend branch is never deleted, however it is named', () => {
  const frontend = (over: Partial<WorktreeFacts>) =>
    judge(
      facts({ repo: 'EverFI/everfi-frontend', main: '/d/everfi-frontend', ...over }),
      context(),
    );
  assert.equal(frontend({}).removable, true);
  assert.equal(frontend({}).deletes_branch, false);
  assert.equal(frontend({ repo: null }).deletes_branch, false, 'the folder name counts too');
  assert.equal(frontend({ repo: 'someone/else', main: '/d/ef-fe-checkout' }).deletes_branch, true);
  const configured = judge(
    facts({ repo: 'acme/widgets' }),
    context({ keepBranches: ['acme/widgets'] }),
  );
  assert.equal(configured.deletes_branch, false, 'a name from config.json counts');
});

test('workingIn: live sessions and registered agents by cwd or by repo and branch, by id; names and task text count for nothing', () => {
  const dir = '/d/widgets-worktrees/kill-inbox';
  const sessions = [
    { id: 's1', title: 'in it', cwd: `${dir}/packages` },
    { id: 's2', title: 'beside it', cwd: '/d/widgets-worktrees/kill-inbox-2' },
  ];
  const run = { sid: 'abcd1234', state: 'running' as const };
  const agents = [
    { ...run, name: 'a1', cwd: `${dir}/x` },
    { ...run, name: 'a2', task: 'work in /d/widgets-worktrees/kill-inbox/x' },
    { ...run, name: 'a3', task: 'worktree widgets-worktrees/kill-inbox' },
    { ...run, name: 'kill-inbox', state: 'plan' as const },
    { ...run, name: 'a4', state: 'done' as const, cwd: dir },
    { ...run, name: 'a5', cwd: '/d/widgets-worktrees/kill-inbox-2' },
    { ...run, name: 'a6', cwd: '/d/widgets', repo: 'Acme/Widgets', branch: 'kill-inbox' },
    { ...run, name: 'a7', cwd: '/d/widgets', repo: 'acme/widgets', branch: 'other' },
    { ...run, name: 'a8', cwd: '/d/widgets', repo: 'else/where', branch: 'kill-inbox' },
    { ...run, name: 'a9', state: 'done' as const, cwd: '/d/widgets', branch: 'kill-inbox' },
  ];
  const tree = { repo: 'acme/widgets', branch: 'kill-inbox' };
  assert.deepEqual(workingIn(dir, sessions, agents, tree), [
    { kind: 'session', id: 's1', label: 'in it' },
    { kind: 'agent', id: 'abcd1234:a1', label: 'a1' },
    { kind: 'agent', id: 'abcd1234:a6', label: 'a6' },
  ]);
});

/** A repo with a worktree for each case the verdicts tell apart. */
function cases() {
  const repo = fixture();
  const merged = repo.add('merged-work');
  repo.commit(merged, 'merged work');
  git(repo.main, 'merge', '-q', '--ff-only', 'merged-work');
  const unmerged = repo.add('open-work');
  repo.commit(unmerged, 'open work', 5);
  const fresh = repo.add('fresh');
  const dirty = repo.add('dirty-work');
  repo.commit(dirty, 'dirty work', 6);
  git(repo.main, 'merge', '-q', '--no-edit', 'dirty-work');
  writeFileSync(path.join(dirty, 'note.txt'), 'scratch\n');
  // same patch on main: git cherry sees it
  const samePatch = repo.add('same-patch');
  writeFileSync(path.join(samePatch, 'f.txt'), 'x\n');
  git(samePatch, 'add', '.');
  git(samePatch, 'commit', '-q', '-m', 'add f');
  writeFileSync(path.join(repo.main, 'f.txt'), 'x\n');
  git(repo.main, 'add', '.');
  git(repo.main, 'commit', '-q', '-m', 'add f again');
  // the context moved: a different patch, the same subject and file counts (main edits line 3 first)
  const moved = repo.add('moved-context');
  repo.commit(moved, 'edit one', 1);
  repo.commit(repo.main, 'edit three', 3);
  repo.commit(repo.main, 'edit one', 1);
  return { ...repo, merged, unmerged, fresh, dirty, samePatch, moved };
}

test('the scanner finds every worktree and tells merged, superseded (the same patch), new, dirty and open work apart', async () => {
  const tree = cases();
  const home = tmp('wt-home');
  const scanner = new WorktreeScanner({ home, dirs: () => [] });
  const scan = await scanned(scanner, [tree.main]);
  assert.equal(scan.items.length, 6);
  const one = (name: string) => byName(scan.items, name);
  assert.equal(one('merged-work').merged, true);
  assert.equal(one('merged-work').repo, 'acme/widgets');
  assert.equal(one('open-work').merged, false);
  assert.equal(one('open-work').superseded, false);
  // the fixture has no remote-tracking refs, so the base commit counts as unpushed too
  assert.equal(one('open-work').unpushed, 3);
  assert.equal(one('fresh').unmoved, true);
  assert.equal(one('dirty-work').untracked, 1);
  assert.equal(one('dirty-work').modified, 0);
  assert.equal(one('merged-work').untracked, 0);
  assert.equal(one('same-patch').superseded, true, 'git cherry: the same patch');
  assert.equal(
    one('moved-context').superseded,
    false,
    'the same subject and file counts is not a copy',
  );
  assert.equal(one('moved-context').merged, false);
  assert.ok((one('merged-work').sizeKb ?? 0) > 0);
  assert.ok(one('merged-work').lastCommitMs);
  const verdicts = Object.fromEntries(
    scan.items.map((item) => {
      const judged = judge(item, context({ now: Date.now() + 2 * 3600 * 1000 }));
      return [path.basename(item.path), [judged.verdict, judged.removable]];
    }),
  );
  assert.deepEqual(verdicts, {
    'merged-work': ['merged', true],
    'open-work': ['unmerged', false],
    fresh: ['new', false],
    'dirty-work': ['merged', false],
    'same-patch': ['superseded', true],
    'moved-context': ['unmerged', false],
  });
});

test('a superseded check does not pass when a commit has no copy', async () => {
  const repo = fixture();
  const dir = repo.add('half-copied');
  repo.commit(dir, 'copied', 1);
  repo.commit(dir, 'not copied', 2);
  repo.commit(repo.main, 'copied', 1);
  const scan = await scanned(new WorktreeScanner({ home: tmp('wt-home'), dirs: () => [] }), [
    repo.main,
  ]);
  assert.equal(byName(scan.items, 'half-copied').superseded, false);
});

test('discovery: checkout_dirs two levels down, and seeds, each repo once; a repo with no worktree is left out', async () => {
  const repo = fixture('widgets');
  repo.add('one');
  const lonely = fixture('lonely');
  void lonely;
  const group = tmp('wt-group');
  mkdirSync(path.join(group, 'inner'));
  const nested = path.join(group, 'inner', 'gadgets');
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(nested, 'x'), 'x');
  git(nested, 'add', '.');
  git(nested, 'commit', '-q', '-m', 'base');
  git(nested, 'worktree', 'add', '-q', path.join(group, 'g-two'), '-b', 'two');
  const scanner = new WorktreeScanner({
    home: tmp('wt-home'),
    dirs: () => [repo.base, group, lonely.base],
  });
  // the seed is a worktree of widgets: it resolves to the same main
  const scan = await scanned(scanner, [path.join(repo.trees, 'one')]);
  assert.deepEqual(scan.items.map((item) => path.basename(item.path)).sort(), ['g-two', 'one']);
  assert.equal(byName(scan.items, 'g-two').repo, null, 'no GitHub origin, no repo');
});

test('every git call has a timeout flag set: no fsmonitor, no optional locks', async () => {
  const repo = fixture();
  repo.add('one');
  const calls: string[][] = [];
  const run: Runner = (cmd, args, timeoutMs) => {
    calls.push([cmd, ...args]);
    assert.ok(timeoutMs > 0 && timeoutMs <= 180000, 'every call has a time limit');
    return runCommand(cmd, args, timeoutMs);
  };
  await scanned(new WorktreeScanner({ home: tmp('wt-home'), dirs: () => [], run }), [repo.main]);
  const gits = calls.filter((call) => call[0] === 'git');
  assert.ok(gits.length > 5);
  for (const call of gits) {
    assert.ok(call.includes('--no-optional-locks'), call.join(' '));
    assert.ok(
      call.some((arg, index) => arg === '-c' && call[index + 1] === 'core.fsmonitor=false'),
      call.join(' '),
    );
  }
  assert.ok(calls.some((call) => call[0] === 'du'));
});

test('slow facts are kept: a second scan does not redo status, size, or the merge checks', async () => {
  const repo = fixture();
  const dir = repo.add('one');
  repo.commit(dir, 'work');
  let now = Date.now();
  const calls: string[] = [];
  const run: Runner = (cmd, args, timeoutMs) => {
    calls.push([cmd, ...args].join(' '));
    return runCommand(cmd, args, timeoutMs);
  };
  const scanner = new WorktreeScanner({
    home: tmp('wt-home'),
    dirs: () => [],
    run,
    now: () => now,
  });
  await scanned(scanner, [repo.main]);
  const count = (word: string) => calls.filter((call) => call.includes(word)).length;
  const first = { status: count(' status '), merge: count(' merge-base '), du: count('du -sk') };
  assert.deepEqual(first, { status: 1, merge: first.merge, du: 1 });
  assert.ok(first.merge >= 1);
  // too soon: nothing starts
  now += 10 * 1000;
  scanner.kick([repo.main]);
  assert.equal(scanner.read().scanning, false);
  // a minute on: a scan runs, with only the cheap facts again
  now += 61 * 1000;
  await scanned(scanner, [repo.main]);
  assert.equal(count(' status '), 1);
  assert.equal(count(' merge-base '), first.merge, 'merge-base answers are kept per tip');
  assert.equal(count('du -sk'), 1);
  // five minutes on: status again, the size still kept
  now += 5 * 60 * 1000;
  await scanned(scanner, [repo.main]);
  assert.equal(count(' status '), 2);
  assert.equal(count('du -sk'), 1);
  // the branch moves: its merge state is worked out again, and its status
  repo.commit(dir, 'more work', 2);
  now += 61 * 1000;
  await scanned(scanner, [repo.main]);
  assert.ok(count(' merge-base ') > first.merge);
  assert.equal(count(' status '), 3);
});

test('a hung git never holds anything up: kick returns at once, and a status that times out is unknown', async () => {
  const repo = fixture();
  repo.add('one');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run: Runner = async (cmd, args, timeoutMs) => {
    if (args.includes('worktree')) {
      await gate;
    }
    if (args.includes('status')) {
      return { code: 1, stdout: '', timedOut: true };
    }
    return runCommand(cmd, args, timeoutMs);
  };
  const scanner = new WorktreeScanner({ home: tmp('wt-home'), dirs: () => [], run });
  // kick is synchronous: it returns while git is still held at the gate
  scanner.kick([repo.main]);
  assert.equal(scanner.read().scanning, true);
  assert.deepEqual(scanner.read().items, []);
  release();
  await scanner.idle();
  const item = scanner.read().items[0];
  assert.equal(item.modified, null);
  const judged = judge(item, context({ now: Date.now() + 2 * 3600 * 1000 }));
  assert.equal(judged.state, 'unknown');
  assert.equal(judged.removable, false);
});

test('the last scan is saved, and a new process shows it as scanning until a scan confirms it', async () => {
  const repo = fixture();
  const dir = repo.add('one');
  repo.commit(dir, 'work');
  git(repo.main, 'merge', '-q', '--ff-only', 'one');
  const home = tmp('wt-home');
  await scanned(new WorktreeScanner({ home, dirs: () => [] }), [repo.main]);
  assert.ok(existsSync(path.join(home, 'worktrees.json')));
  const later = new WorktreeScanner({ home, dirs: () => [] });
  const loaded = later.read().items;
  assert.equal(loaded.length, 1);
  const judged = judge(loaded[0], context({ now: Date.now() + 2 * 3600 * 1000 }));
  assert.equal(judged.stale, true);
  assert.equal(judged.removable, false);
  assert.match(judged.keep.join(), /scanning/);
  assert.equal(loaded[0].modified, null, 'the saved status is not trusted');
  const scan = await scanned(later, [repo.main]);
  assert.equal(
    judge(scan.items[0], context({ now: Date.now() + 2 * 3600 * 1000 })).removable,
    true,
  );
});

test('prunable entries are reported with the command, not as worktrees', async () => {
  const repo = fixture();
  const dir = repo.add('gone');
  repo.add('here');
  git(repo.main, 'worktree', 'lock', dir);
  const scanner = new WorktreeScanner({ home: tmp('wt-home'), dirs: () => [] });
  await scanned(scanner, [repo.main]);
  assert.equal(byName(scanner.read().items, 'gone').locked, true);
  git(repo.main, 'worktree', 'unlock', dir);
  const { rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true });
  const again = new WorktreeScanner({ home: tmp('wt-home2'), dirs: () => [] });
  const scan = await scanned(again, [repo.main]);
  assert.deepEqual(
    scan.items.map((item) => path.basename(item.path)),
    ['here'],
  );
  assert.equal(scan.prunable.length, 1);
  assert.match(scan.prunable[0].line, /worktree prune$/);
});

/** A board over a home that knows the repo, with the worktree scan's git optionally held. */
function boardWith(repo: ReturnType<typeof fixture>, run?: Runner) {
  const home = tmp('wt-board');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('wt-sessions') });
  seenCheckout(home, 'acme/widgets', repo.main);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    worktreeRun: run,
  });
  return { home, board };
}

async function settled(board: Board) {
  for (let tries = 0; tries < 200; tries++) {
    const data = await board.snapshot();
    if (data.worktrees && !data.worktrees.scanning) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the scan did not finish');
}

test('the board: a worktree a started backlog card links goes on that card, the rest in the lane', async () => {
  const repo = fixture();
  repo.add('kill-inbox');
  const orphan = repo.add('orphan');
  repo.commit(orphan, 'orphaned work');
  const { home, board } = boardWith(repo);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'kill-inbox', repo: 'acme/widgets', by: 'someone' });
  const data = await settled(board);
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = cards.find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.deepEqual(
    card.worktrees?.map((tree) => tree.name),
    ['kill-inbox'],
  );
  assert.deepEqual(
    data.worktrees?.items.map((tree) => tree.name),
    ['orphan'],
  );
  assert.equal(data.worktrees?.total, 2);
  // made a moment ago, so not offered whatever it holds
  assert.equal(data.worktrees?.items[0].verdict, 'new');
  assert.equal(data.worktrees?.items[0].removable, false);
  assert.equal(data.worktrees?.items[0].keep[0], 'made less than an hour ago');
  assert.equal(data.worktrees?.items[0].lane, 'acme/widgets');
});

test('the board: the header counts the removable worktrees the lane lists, not the ones on cards', async () => {
  const repo = fixture();
  const onCard = repo.add('on-card');
  repo.commit(onCard, 'card work');
  git(repo.main, 'merge', '-q', '--ff-only', 'on-card');
  const loose = repo.add('loose');
  repo.commit(loose, 'loose work', 2);
  git(repo.main, 'merge', '-q', '--ff-only', 'loose');
  const home = tmp('wt-board');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('wt-sessions') });
  seenCheckout(home, 'acme/widgets', repo.main);
  // a clock past the hour a new worktree is kept for
  const later = new Date(Date.now() + 2 * 3600 * 1000);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => later,
  });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Work on a card', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'on-card', repo: 'acme/widgets', by: 'someone' });
  const data = await settled(board);
  const card = data.lanes
    .flatMap((lane) => lane.cards)
    .find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.equal(card.worktrees?.[0].removable, true, 'the card has a removable worktree');
  assert.deepEqual(
    data.worktrees?.items.map((tree) => [tree.name, tree.removable]),
    [['loose', true]],
  );
  assert.equal(data.worktrees?.total, 2, 'every worktree is still on this Mac');
  assert.equal(data.worktrees?.removable, 1, 'the count is what the lane lists');
});

test('the board answers while git hangs: the section says it is scanning', async () => {
  const repo = fixture();
  repo.add('one');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { board } = boardWith(repo, async (cmd, args, timeoutMs) => {
    await gate;
    return runCommand(cmd, args, timeoutMs);
  });
  const started = Date.now();
  const data = await board.snapshot();
  assert.ok(Date.now() - started < 1500, 'the poll did not wait for the scan');
  assert.equal(data.worktrees?.scanning, true);
  assert.equal(data.worktrees?.total, 0);
  release();
  const done = await settled(board);
  assert.equal(done.worktrees?.total, 1);
});

test('board_worktrees: false leaves the section off', async () => {
  const repo = fixture();
  repo.add('one');
  const { home, board } = boardWith(repo);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('wt-sessions'),
    board_worktrees: false,
  });
  assert.equal((await board.snapshot()).worktrees, null);
});
