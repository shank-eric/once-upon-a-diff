import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git } from './helpers.ts';
import { fixture } from './worktree-fixture.ts';
import {
  cleanWorktree,
  removalError,
  shellQuote,
  type CleanInput,
} from '../src/board/worktree-clean.ts';
import {
  WorktreeScanner,
  irreplaceableIgnored,
  judge,
  runCommand,
  type Runner,
} from '../src/board/worktrees.ts';
import { readSettings } from '../src/config/settings.ts';
import { HttpError } from '../src/server/request.ts';

const LATER = () => Date.now() + 2 * 3600 * 1000;
const idle = async () => ({ inUse: [], pr: { number: null, state: 'none' as const } });
const branches = (main: string) => git(main, 'branch', '--format=%(refname:short)').split('\n');

async function scannerOf(main: string, run?: Runner) {
  const scanner = new WorktreeScanner({ home: tmp('ws-home'), dirs: () => [], run });
  scanner.kick([main]);
  await scanner.idle();
  return scanner;
}

function input(scanner: WorktreeScanner, dir: string, over: Partial<CleanInput> = {}): CleanInput {
  return {
    scanner,
    dir,
    ack: [],
    contextOf: idle,
    keepBranches: ['everfi-frontend'],
    home: tmp('ws-log'),
    now: LATER,
    ...over,
  };
}

const refused = async (promise: Promise<unknown>, status: number, message: RegExp) => {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status);
    assert.match(err.message, message);
    return true;
  });
};

const one = (scanner: WorktreeScanner, dir: string) => {
  const found = scanner.find(dir);
  assert.ok(found, dir);
  return found;
};

test('a branch only the main checkout’s detached HEAD holds is not merged, and is not removed (stack/33 and 34)', async () => {
  const repo = fixture();
  const dir = repo.add('stack-33');
  repo.commit(dir, 'stack work');
  // the main checkout is deployed from the stack: detached, at the branch's tip; main itself stays behind
  git(repo.main, 'checkout', '-q', '--detach', 'stack-33');
  const scanner = await scannerOf(repo.main);
  const found = one(scanner, dir);
  assert.equal(found.merged, false, 'a detached HEAD is not a branch');
  assert.equal(found.defaultBranch, 'main');
  const judged = judge(found, {
    inUse: [],
    pr: { number: null, state: 'none' },
    keepBranches: [],
    now: LATER(),
  });
  assert.equal(judged.removable, false);
  assert.equal(judged.deletes_branch, false);
  await refused(cleanWorktree(input(scanner, dir)), 409, /not in the main line/);
  assert.ok(existsSync(dir));
  assert.ok(branches(repo.main).includes('stack-33'));
});

test('a main checkout on a branch built on the default (larmor’s phone/live) counts, one that is not built on it does not', async () => {
  const repo = fixture();
  const dir = repo.add('voice-work');
  repo.commit(dir, 'voice work');
  git(repo.main, 'checkout', '-q', '-b', 'live', 'main');
  git(repo.main, 'merge', '-q', '--ff-only', 'voice-work');
  let scanner = await scannerOf(repo.main);
  assert.equal(one(scanner, dir).merged, true, 'in live, which is main plus more');
  const done = await cleanWorktree(input(scanner, dir));
  assert.equal(done.branch?.name, 'voice-work');
  assert.ok(!branches(repo.main).includes('voice-work'));
  assert.ok(branches(repo.main).includes('live'));

  // a checkout on an unrelated branch (main has moved on without it) is not a place work is merged into
  const other = fixture();
  const work = other.add('work');
  other.commit(work, 'work');
  git(other.main, 'checkout', '-q', '-b', 'stray', 'main');
  git(other.main, 'merge', '-q', '--ff-only', 'work');
  git(other.main, 'checkout', '-q', 'main');
  other.commit(other.main, 'main moves on', 4);
  git(other.main, 'checkout', '-q', 'stray');
  scanner = await scannerOf(other.main);
  assert.equal(one(scanner, work).merged, false);
  await refused(cleanWorktree(input(scanner, work)), 409, /not in the main line/);
});

test('the default branch is origin’s HEAD, not just main or master', async () => {
  const repo = fixture();
  const dir = repo.add('feature');
  repo.commit(dir, 'feature work');
  git(repo.main, 'branch', 'develop', 'feature');
  const sha = git(repo.main, 'rev-parse', 'develop');
  git(repo.main, 'update-ref', 'refs/remotes/origin/develop', sha);
  git(repo.main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const scanner = await scannerOf(repo.main);
  const found = one(scanner, dir);
  assert.equal(found.defaultBranch, 'develop');
  assert.equal(found.merged, true);
  // and a worktree on develop itself is never cleaned, nor its branch deleted
  const onDevelop = repo.add('develop-copy');
  git(onDevelop, 'checkout', '-q', '--detach');
  git(onDevelop, 'branch', '-f', 'tmp-keep', 'HEAD');
  const judged = judge(
    { ...found, branch: 'develop' },
    { inUse: [], pr: { number: null, state: 'none' }, keepBranches: [], now: LATER() },
  );
  assert.match(judged.keep.join(), /default branch/);
});

test('a detached worktree is removable only when a branch reaches its HEAD', async () => {
  const repo = fixture();
  const onMain = path.join(repo.trees, 'detached-main');
  git(repo.main, 'worktree', 'add', '-q', '--detach', onMain, 'main');
  const lost = path.join(repo.trees, 'detached-lost');
  git(repo.main, 'worktree', 'add', '-q', '--detach', lost, 'main');
  repo.commit(lost, 'only here');
  // a copy of that patch in main: the same patch, but the commits are still only on the detached HEAD
  repo.commit(repo.main, 'only here', 1, 'theirs');
  const scanner = await scannerOf(repo.main);
  const reached = one(scanner, onMain);
  assert.equal(reached.reachable, true);
  assert.equal(
    judge(reached, {
      inUse: [],
      pr: { number: null, state: 'none' },
      keepBranches: [],
      now: LATER(),
    }).removable,
    true,
  );
  const unreached = one(scanner, lost);
  assert.equal(unreached.reachable, false);
  const judged = judge(unreached, {
    inUse: [],
    pr: { number: null, state: 'none' },
    keepBranches: [],
    now: LATER(),
  });
  assert.equal(judged.removable, false);
  assert.match(judged.keep.join(), /on no branch/);
  await refused(cleanWorktree(input(scanner, lost)), 409, /on no branch/);
  assert.ok(existsSync(lost));
  // the reachable one goes, with no branch to delete
  const done = await cleanWorktree(input(scanner, onMain));
  assert.equal(done.branch, null);
  assert.equal(existsSync(onMain), false);
});

test('superseded for a detached HEAD needs the same patch: the same subject and file counts is not enough', async () => {
  const repo = fixture();
  const lookalike = path.join(repo.trees, 'lookalike');
  git(repo.main, 'worktree', 'add', '-q', '--detach', lookalike, 'main');
  repo.commit(lookalike, 'edit one', 1, 'mine');
  repo.commit(repo.main, 'edit three', 3);
  repo.commit(repo.main, 'edit one', 1, 'theirs');
  const named = repo.add('named');
  repo.commit(named, 'edit two', 2, 'mine');
  repo.commit(repo.main, 'edit two', 2, 'theirs');
  const scanner = await scannerOf(repo.main);
  assert.equal(one(scanner, lookalike).superseded, false, 'a detached HEAD: patch-identical only');
  assert.equal(one(scanner, named).superseded, true, 'a branch is kept, so the heuristic stands');
});

test('ignored files that cannot be rebuilt are named, and need a confirm that named them', async () => {
  const repo = fixture();
  const dir = repo.add('done-work');
  repo.commit(dir, 'done work');
  git(repo.main, 'merge', '-q', '--ff-only', 'done-work');
  writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(dir, 'x.local.json'), '{}\n');
  mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), '1');
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'dist/out.js'), '1');
  const scanner = await scannerOf(repo.main);
  assert.deepEqual(one(scanner, dir).ignored, ['.env', 'x.local.json']);
  const judged = judge(one(scanner, dir), {
    inUse: [],
    pr: { number: null, state: 'none' },
    keepBranches: [],
    now: LATER(),
  });
  assert.equal(judged.removable, true, 'removable with a confirm');
  assert.deepEqual(judged.ignored, ['.env', 'x.local.json']);
  await refused(cleanWorktree(input(scanner, dir)), 409, /ignored files.*\.env, x\.local\.json/);
  await refused(
    cleanWorktree(input(scanner, dir, { ack: ['ignored-files'], seen: ['.env'] })),
    409,
    /ignored files/,
  );
  assert.ok(existsSync(path.join(dir, '.env')), 'nothing was deleted');
  await cleanWorktree(
    input(scanner, dir, { ack: ['ignored-files'], seen: ['.env', 'x.local.json', 'more'] }),
  );
  assert.equal(existsSync(dir), false);
});

test('irreplaceableIgnored skips caches, build output and dependencies', () => {
  assert.deepEqual(
    irreplaceableIgnored([
      '!! node_modules/',
      '!! packages/a/node_modules/',
      '!! .output/',
      '!! dist/',
      '!! build/',
      '!! .turbo/',
      '!! coverage/',
      '!! .next/cache/',
      '!! .yarn/install-state.gz',
      '!! .husky/_/',
      '!! .DS_Store',
      '!! packages/a/.DS_Store',
      '!! tsconfig.tsbuildinfo',
      '!! debug.log',
      '!! .env',
      '!! .env.local',
      '!! .claude/settings.local.json',
      '!! notes/',
      ' M tracked.txt',
      '?? new.txt',
    ]),
    ['.claude/settings.local.json', '.env', '.env.local', 'notes/'],
  );
});

test('a review checkout (a branch the same as origin’s, nothing local) is removable once it is an hour old', async () => {
  const repo = fixture();
  // someone's PR commit, on origin and not in main
  const sha = git(repo.main, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'their change');
  git(repo.main, 'update-ref', 'refs/remotes/origin/pr-1', sha);
  const dir = path.join(repo.trees, 'review-1');
  git(repo.main, 'worktree', 'add', '-q', '-b', 'pr-1', dir, 'refs/remotes/origin/pr-1');
  const scanner = await scannerOf(repo.main);
  const found = one(scanner, dir);
  assert.equal(found.onRemote, true);
  assert.equal(found.unmoved, true);
  const context = {
    inUse: [],
    pr: { number: 1, state: 'open' as const },
    keepBranches: [],
    now: LATER(),
  };
  const judged = judge(found, context);
  assert.equal(judged.verdict, 'pushed');
  assert.equal(judged.removable, true);
  assert.equal(judged.deletes_branch, false, 'its branch is kept');
  assert.equal(
    judge(found, { ...context, now: Date.now() }).removable,
    false,
    'not within the hour',
  );
  // a branch made fresh from main, with no origin copy, is still new work
  const fresh = repo.add('fresh-idea');
  const again = await scannerOf(repo.main);
  assert.equal(judge(one(again, fresh), context).verdict, 'new');
  // ignored files it holds need the confirm like any other
  writeFileSync(path.join(dir, '.env'), 'x\n');
  const scanned = await scannerOf(repo.main);
  await refused(cleanWorktree(input(scanned, dir)), 409, /ignored files/);
  assert.ok(existsSync(dir));
});

test('a removal git refuses or that times out is reported as it is, logged with the restore line, and not retried', async () => {
  const repo = fixture();
  const dir = repo.add('merged-work');
  repo.commit(dir, 'merged work');
  git(repo.main, 'merge', '-q', '--ff-only', 'merged-work');
  const scanner = await scannerOf(repo.main);
  const tip = git(repo.main, 'rev-parse', 'merged-work');
  let removes = 0;
  const refusing: Runner = async (cmd, args, timeoutMs) => {
    if (args.includes('remove')) {
      removes += 1;
      return {
        code: 128,
        stdout: '',
        stderr: "fatal: '/x' contains modified or untracked files, use --force to delete it\n",
        timedOut: false,
      };
    }
    return runCommand(cmd, args, timeoutMs);
  };
  const request = input(scanner, dir, { run: refusing });
  await refused(
    cleanWorktree(request),
    409,
    /git refused: the worktree has modified or untracked files.*needing attention/,
  );
  assert.equal(
    one(scanner, dir).attention,
    'git refused: the worktree has modified or untracked files',
  );
  const lines = readFileSync(path.join(request.home, 'worktree-cleanups.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.phase),
    ['attempt', 'failed'],
  );
  assert.equal(lines[0].restore, `git -C '${repo.main}' branch 'merged-work' '${tip}'`);
  assert.match(lines[1].error, /modified or untracked/);
  // not retried: it is held for a look
  await refused(cleanWorktree(request), 409, /needs attention/);
  assert.equal(removes, 1);
  const judged = judge(one(scanner, dir), {
    inUse: [],
    pr: { number: null, state: 'none' },
    keepBranches: [],
    now: LATER(),
  });
  assert.equal(judged.removable, false);
  assert.match(judged.attention ?? '', /modified or untracked/);
  assert.ok(existsSync(dir) && branches(repo.main).includes('merged-work'));
});

test('removalError tells a timeout, a dirty and a locked worktree apart', () => {
  assert.match(
    removalError({ code: 1, stdout: '', timedOut: true }),
    /did not finish in 30 minutes.*partly deleted/,
  );
  assert.match(
    removalError({
      code: 1,
      stdout: '',
      stderr: 'fatal: x contains modified or untracked files',
      timedOut: false,
    }),
    /modified or untracked/,
  );
  assert.match(
    removalError({
      code: 1,
      stdout: '',
      stderr: 'fatal: cannot remove a locked working tree',
      timedOut: false,
    }),
    /locked/,
  );
  assert.equal(
    removalError({ code: 1, stdout: '', stderr: 'error: something odd\nmore', timedOut: false }),
    'git refused: something odd',
  );
});

test('the restore line is quoted and carries the tip captured before the delete, for a path with spaces and commas', async () => {
  const repo = fixture('my widgets, v2');
  const dir = repo.add('merged-work');
  repo.commit(dir, 'merged work');
  git(repo.main, 'merge', '-q', '--ff-only', 'merged-work');
  const tip = git(repo.main, 'rev-parse', 'merged-work');
  const scanner = await scannerOf(repo.main);
  const done = await cleanWorktree(input(scanner, dir));
  assert.equal(done.branch?.sha, tip);
  assert.equal(done.branch?.restore, `git -C '${repo.main}' branch 'merged-work' '${tip}'`);
  assert.equal(tip.length, 40);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('a status that times out at the click is “not known”, and nothing is removed', async () => {
  const repo = fixture();
  const dir = repo.add('merged-work');
  repo.commit(dir, 'merged work');
  git(repo.main, 'merge', '-q', '--ff-only', 'merged-work');
  let hang = false;
  const run: Runner = async (cmd, args, timeoutMs) => {
    if (hang && args.includes('status')) {
      return { code: 1, stdout: '', timedOut: true };
    }
    return runCommand(cmd, args, timeoutMs);
  };
  const scanner = await scannerOf(repo.main, run);
  hang = true;
  await refused(cleanWorktree(input(scanner, dir)), 409, /clean or dirty not known/);
  assert.ok(existsSync(dir));
});

test('a worktree removed while a scan runs does not come back from it', async () => {
  const repo = fixture();
  const dir = repo.add('one');
  repo.add('two');
  let now = Date.now();
  let gate: Promise<void> | null = null;
  let hit: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (hit = resolve));
  let release: () => void = () => undefined;
  const run: Runner = async (cmd, args, timeoutMs) => {
    if (gate && args.includes('rev-list')) {
      hit();
      await gate;
    }
    return runCommand(cmd, args, timeoutMs);
  };
  const scanner = new WorktreeScanner({
    home: tmp('ws-home'),
    dirs: () => [],
    run,
    now: () => now,
  });
  scanner.kick([repo.main]);
  await scanner.idle();
  now += 120 * 1000;
  gate = new Promise<void>((resolve) => (release = resolve));
  scanner.kick([repo.main]);
  await reached;
  scanner.forget(dir);
  release();
  await scanner.idle();
  assert.deepEqual(
    scanner.read().items.map((item) => path.basename(item.path)),
    ['two'],
  );
});

test('readSettings keeps everfi-frontend on the keep list whatever config.json says', () => {
  const home = tmp('ws-settings');
  assert.deepEqual(readSettings(home).board.keepBranches, ['everfi-frontend']);
  writeJson(path.join(home, 'config.json'), { board_keep_branches: [] });
  assert.deepEqual(readSettings(home).board.keepBranches, ['everfi-frontend']);
  writeJson(path.join(home, 'config.json'), { board_keep_branches: ['Acme/Widgets', 5, ''] });
  assert.deepEqual(readSettings(home).board.keepBranches, ['everfi-frontend', 'acme/widgets']);
});
