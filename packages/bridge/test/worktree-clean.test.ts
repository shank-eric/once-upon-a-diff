import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { fixture } from './worktree-fixture.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { seenCheckout } from '../src/services/config/repos.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';
import { cleanWorktree, type CleanInput } from '../src/services/worktrees/worktree-clean.ts';
import { WorktreeScanner } from '../src/services/worktrees/worktrees.ts';
import { boardKey, pageKey } from '../src/services/pages/page-key.ts';
import { BoardError } from '../src/services/errors.ts';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

/** Two hours on: past the hour a new worktree is protected for. */
const LATER = () => Date.now() + 2 * 3600 * 1000;

/** A worktree that is merged into main, one that is only superseded, and ones that must be kept. */
function setup(name = 'widgets', remote = 'git@github.com:acme/widgets.git') {
  const repo = fixture(name, remote);
  const merged = repo.add('merged-work');
  repo.commit(merged, 'merged work');
  git(repo.main, 'merge', '-q', '--ff-only', 'merged-work');
  const open = repo.add('open-work');
  repo.commit(open, 'open work', 5);
  const copied = repo.add('copied-work');
  // the same patch on main (a new file), so git cherry sees a copy
  writeFileSync(path.join(copied, 'copy.txt'), 'x\n');
  git(copied, 'add', '.');
  git(copied, 'commit', '-q', '-m', 'copied work');
  repo.commit(repo.main, 'edit three', 3);
  writeFileSync(path.join(repo.main, 'copy.txt'), 'x\n');
  git(repo.main, 'add', '.');
  git(repo.main, 'commit', '-q', '-m', 'copied work again');
  return { ...repo, merged, open, copied };
}

async function scannerOf(main: string) {
  const scanner = new WorktreeScanner({ home: tmp('wc-home'), dirs: () => [] });
  scanner.kick([main]);
  await scanner.idle();
  return scanner;
}

const idle = async () => ({ inUse: [], pr: { number: null, state: 'none' as const } });

function input(scanner: WorktreeScanner, dir: string, over: Partial<CleanInput> = {}): CleanInput {
  return {
    scanner,
    dir,
    ack: [],
    contextOf: idle,
    keepBranches: ['everfi-frontend'],
    home: tmp('wc-log'),
    now: LATER,
    ...over,
  };
}

const refused = async (promise: Promise<unknown>, status: number, message: RegExp) => {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof BoardError, String(err));
    assert.equal(err.status, status);
    assert.match(err.message, message);
    return true;
  });
};

const branches = (main: string) => git(main, 'branch', '--format=%(refname:short)').split('\n');

test('a clean merged worktree is removed without --force, and its merged branch deleted and logged', async () => {
  const tree = setup();
  const scanner = await scannerOf(tree.main);
  const sha = git(tree.merged, 'rev-parse', 'HEAD');
  const request = input(scanner, tree.merged);
  const done = await cleanWorktree(request);
  assert.equal(existsSync(tree.merged), false);
  assert.equal(done.removed, tree.merged);
  assert.deepEqual(done.branch, {
    name: 'merged-work',
    sha,
    restore: `git -C '${tree.main}' branch 'merged-work' '${sha}'`,
  });
  assert.ok(!branches(tree.main).includes('merged-work'));
  assert.equal(scanner.find(tree.merged), null, 'the scanner forgot it');
  const log = readFileSync(path.join(request.home, 'worktree-cleanups.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    log.map((line) => line.phase),
    ['attempt', 'removed'],
    'the attempt is written before git runs',
  );
  assert.equal(log[0].restore, `git -C '${tree.main}' branch 'merged-work' '${sha}'`);
  assert.deepEqual(
    [log[1].path, log[1].branch, log[1].head, log[1].verdict, log[1].branch_deleted],
    [tree.merged, 'merged-work', sha, 'merged', true],
  );
  // the other worktrees were not touched
  assert.ok(existsSync(tree.open) && existsSync(tree.copied));
});

test('a superseded worktree needs the page to say so, and its branch is kept', async () => {
  const tree = setup();
  const scanner = await scannerOf(tree.main);
  await refused(cleanWorktree(input(scanner, tree.copied)), 409, /only superseded/);
  assert.ok(existsSync(tree.copied));
  await refused(
    cleanWorktree(input(scanner, tree.copied, { ack: ['superseded'] })).then(() =>
      cleanWorktree(input(scanner, tree.merged, { ack: ['superseded'] })),
    ),
    409,
    /no longer only superseded/,
  );
  assert.equal(existsSync(tree.copied), false, 'the acknowledged one went');
  assert.ok(branches(tree.main).includes('copied-work'), 'a superseded branch is kept');
  assert.ok(existsSync(tree.merged), 'a merged one is not removed on a superseded ack');
});

test('refused, with nothing changed: dirty, unpushed and unmerged, in use, locked, new, unlisted, the main checkout', async () => {
  const tree = setup();
  const scanner = await scannerOf(tree.main);
  const untouched = () => {
    for (const dir of [tree.merged, tree.open, tree.copied, tree.main]) {
      assert.ok(existsSync(dir), dir);
    }
    assert.ok(branches(tree.main).includes('merged-work'));
  };
  // unmerged work, with commits on no remote
  await refused(cleanWorktree(input(scanner, tree.open)), 409, /not in the main line.*unpushed/);
  // dirty: an untracked file after the scan is seen, because the bridge looks again at the click
  writeFileSync(path.join(tree.merged, 'scratch.txt'), 'x\n');
  await refused(
    cleanWorktree(input(scanner, tree.merged)),
    409,
    /dirty \(0 modified, 1 untracked\)/,
  );
  git(tree.merged, 'add', 'scratch.txt');
  await refused(
    cleanWorktree(input(scanner, tree.merged)),
    409,
    /dirty \(1 modified, 0 untracked\)/,
  );
  git(tree.merged, 'rm', '-q', '-f', 'scratch.txt');
  // a session or agent is working in it
  await refused(
    cleanWorktree(
      input(scanner, tree.merged, {
        contextOf: async () => ({
          ...(await idle()),
          inUse: [{ kind: 'agent' as const, id: 'ou-builder', label: 'the builder' }],
        }),
      }),
    ),
    409,
    /in use by the builder/,
  );
  // locked
  git(tree.main, 'worktree', 'lock', tree.merged);
  await refused(cleanWorktree(input(scanner, tree.merged)), 409, /locked/);
  git(tree.main, 'worktree', 'unlock', tree.merged);
  // made within the hour (the real clock, not two hours on)
  await refused(
    cleanWorktree(input(scanner, tree.merged, { now: Date.now })),
    409,
    /less than an hour/,
  );
  // not a worktree the board lists: the main checkout, a made-up path, a path outside
  await refused(cleanWorktree(input(scanner, tree.main)), 404, /does not list/);
  await refused(cleanWorktree(input(scanner, path.join(tree.trees, 'nope'))), 404, /does not list/);
  await refused(cleanWorktree(input(scanner, tmp('wc-elsewhere'))), 404, /does not list/);
  untouched();
  // and it goes once nothing is in the way
  await cleanWorktree(input(scanner, tree.merged));
  assert.equal(existsSync(tree.merged), false);
});

test('the bridge looks at the unpushed commits too: a clean, unmerged branch with a commit on no remote stays', async () => {
  const tree = setup();
  const scanner = await scannerOf(tree.main);
  git(tree.open, 'checkout', '-q', '--', '.');
  assert.equal(git(tree.open, 'status', '--porcelain'), '');
  await refused(cleanWorktree(input(scanner, tree.open)), 409, /not in the main line/);
  assert.ok(existsSync(tree.open));
});

test('an everfi-frontend branch is never deleted, whatever its worktree’s state', async () => {
  const tree = setup('everfi-frontend', 'git@github.com:EverFI/everfi-frontend.git');
  const scanner = await scannerOf(tree.main);
  const done = await cleanWorktree(input(scanner, tree.merged));
  assert.equal(existsSync(tree.merged), false);
  assert.equal(done.branch, null);
  assert.ok(branches(tree.main).includes('merged-work'), 'the branch is still there');
  // also by folder name when the origin is not on GitHub
  const local = setup('everfi-frontend', '/some/where.git');
  const kept = await cleanWorktree(input(await scannerOf(local.main), local.merged));
  assert.equal(kept.branch, null);
  assert.ok(branches(local.main).includes('merged-work'));
});

test('when git will not delete the branch the folder is still gone and the answer says so', async () => {
  const tree = setup();
  // merged into main as a ref, but the main checkout is on another branch, so `git branch -d` finds it unmerged
  git(tree.main, 'checkout', '-q', '-b', 'elsewhere', 'HEAD~3');
  git(tree.main, 'branch', '-f', 'main', 'merged-work');
  const scanner = await scannerOf(tree.main);
  const done = await cleanWorktree(input(scanner, tree.merged));
  assert.equal(existsSync(tree.merged), false);
  assert.equal(done.branch, null);
  assert.match(done.note ?? '', /would not delete the branch/);
  assert.ok(branches(tree.main).includes('merged-work'));
});

test('two clicks at once clean it up once', async () => {
  const tree = setup();
  const scanner = await scannerOf(tree.main);
  const results = await Promise.allSettled([
    cleanWorktree(input(scanner, tree.merged)),
    cleanWorktree(input(scanner, tree.merged)),
  ]);
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1);
  assert.equal(existsSync(tree.merged), false);
});

/** A board over a home that knows the repo, with a ledger and session folder of its own. */
function boardOf(repo: ReturnType<typeof setup>, ledger?: string) {
  const home = tmp('wc-board');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('wc-sessions'),
    ...(ledger ? { board_ledger_file: ledger, board_ledger_time_zone: 'UTC' } : {}),
  });
  seenCheckout(home, 'acme/widgets', repo.main);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(LATER()),
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

const stampOf = () => {
  const started = new Date(LATER() - 3600 * 1000);
  return `${started.getUTCHours() % 12 || 12}:00 ${started.getUTCHours() >= 12 ? 'PM' : 'AM'}, ${started.getUTCMonth() + 1}/${started.getUTCDate()}`;
};

test('the board: a ledger agent that only names the worktree in its task or by its name does not hold it', async () => {
  const tree = setup();
  const notes = tmp('wc-notes');
  const ledger = path.join(notes, 'ledger.md');
  writeFileSync(
    ledger,
    `- [running] sid:54736864 merged-work (sonnet, high) — working in ${tree.trees}/merged-work, branch merged-work — started ${stampOf()}\n`,
  );
  const { board } = boardOf(tree, ledger);
  const data = await settled(board);
  const found = data.lanes
    .flatMap((lane) => lane.cards.flatMap((one) => one.worktrees ?? []))
    .concat(data.worktrees?.items ?? [])
    .find((one) => one.name === 'merged-work');
  assert.deepEqual(found?.in_use, []);
  assert.equal(found?.removable, true);
  const done = await board.cleanWorktree(tree.merged, []);
  assert.equal(done.branch?.name, 'merged-work');
  assert.equal(existsSync(tree.merged), false);
});

test('the board: a live session whose folder is in the worktree holds it, by session id', async () => {
  const tree = setup();
  const { board, home } = boardOf(tree);
  const sessions = (
    JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      board_sessions_dir: string;
    }
  ).board_sessions_dir;
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: 'aaaaaaaa-aaaa-bbbb-cccc-dddddddddddd',
    cwd: `${tree.merged}/packages`,
    name: 'working-here',
    status: 'busy',
    startedAt: Date.now() - 3600000,
    procStart,
  });
  mkdirSync(`${tree.merged}/packages`, { recursive: true });
  await settled(board);
  await refused(board.cleanWorktree(tree.merged, []), 409, /in use by working-here/);
  assert.ok(existsSync(tree.merged));
});

test('the board: an agent registered from the main checkout on the worktree’s branch holds it until it finishes', async () => {
  const tree = setup();
  const { board, home } = boardOf(tree);
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'builder',
    sid: '54736864',
    kind: 'builder',
    task: 'build it',
    cwd: tree.main,
    repo: 'acme/widgets',
    branch: 'merged-work',
    at: new Date(LATER() - 3600 * 1000),
  });
  const data = await settled(board);
  const found = data.lanes
    .flatMap((lane) => lane.cards.flatMap((one) => one.worktrees ?? []))
    .concat(data.worktrees?.items ?? [])
    .find((one) => one.name === 'merged-work');
  assert.deepEqual(found?.in_use, [{ kind: 'agent', id: '54736864:builder', label: 'builder' }]);
  assert.equal(found?.removable, false);
  await refused(board.cleanWorktree(tree.merged, []), 409, /in use by builder/);
  assert.ok(existsSync(tree.merged));
  registry.finish('builder', { outcome: 'done', at: new Date(LATER() - 60 * 1000) });
  await board.cleanWorktree(tree.merged, []);
  assert.equal(existsSync(tree.merged), false);
});

test('the board: Clean up refuses what an open registered agent is working in, then removes it once it is done', async () => {
  const tree = setup();
  const { board, home } = boardOf(tree);
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'merger',
    sid: '54736864',
    kind: 'builder',
    task: 'merge it',
    cwd: `${tree.merged}/packages`,
    at: new Date(LATER() - 3600 * 1000),
  });
  mkdirSync(`${tree.merged}/packages`, { recursive: true });
  const data = await settled(board);
  // an open agent works in it, so it is on that agent's card
  const card = data.lanes
    .flatMap((lane) => lane.cards)
    .find((one) => one.worktrees?.some((tree) => tree.name === 'merged-work'));
  assert.ok(
    card?.agents.some((agent) => agent.name === 'merger'),
    'on the agent’s card',
  );
  assert.deepEqual(card?.worktrees?.[0].in_use, [
    { kind: 'agent', id: '54736864:merger', label: 'merger' },
  ]);
  await refused(board.cleanWorktree(tree.merged, []), 409, /in use by merger/);
  assert.ok(existsSync(tree.merged));
  registry.finish('merger', { outcome: 'done', at: new Date(LATER() - 60 * 1000) });
  const done = await board.cleanWorktree(tree.merged, []);
  assert.equal(existsSync(tree.merged), false);
  assert.equal(done.branch?.name, 'merged-work');
  const after = await settled(board);
  const left = after.lanes.flatMap((lane) => lane.cards.flatMap((one) => one.worktrees ?? []));
  assert.ok(
    ![...left, ...(after.worktrees?.items ?? [])].some((one) => one.name === 'merged-work'),
  );
});

test('the route: the board key only, a path to clean, and a 404 for one the board does not list', async () => {
  const home = tmp('wc-route');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('wc-sessions') });
  mkdirSync(home, { recursive: true });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const key = boardKey(TOKEN);
  const post = (body: unknown, auth: string) =>
    bridge.call('POST', '/api/board/worktree/clean', body, { Authorization: `Bearer ${auth}` });
  assert.equal((await post({ path: '/tmp/x' }, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post({ path: '/tmp/x' }, `${key}x`)).status, 403);
  assert.equal((await post({}, key)).status, 400);
  assert.equal((await post({ path: 'relative/path' }, key)).status, 400);
  const unknown = await post({ path: path.join(tmp('wc-none'), 'x') }, key);
  assert.equal(unknown.status, 404);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('wc-sessions'),
    board_worktrees: false,
  });
  assert.equal((await post({ path: '/tmp/x' }, key)).status, 404);
});
