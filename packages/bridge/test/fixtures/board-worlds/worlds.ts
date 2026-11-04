/* eslint-disable no-sequences, id-length, @typescript-eslint/no-explicit-any */
/*
 * Fixture worlds for the /api/board snapshot test: four temp-dir worlds (empty; a busy mix; listeners and voice;
 * backlog with worktrees), each driven through a real Board with a frozen clock, a fake status source and a fake
 * GitHub watcher. Importing this file builds them. `snapshots` maps a world name to its normalized JSON text and
 * `finish()` stops the child processes and removes the temp dir.
 */
import { AgentRegistry } from '../../../src/services/ledger/registry.ts';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'board-worlds-')));
process.env.CLAUDE_CONFIG_DIR = path.join(WORK, 'claude');
process.env.ONCE_UPON_DEV_DIR = path.join(WORK, 'dev');
process.env.ONCE_UPON_NO_HOST_CHECK = '1';
process.env.GIT_AUTHOR_DATE = '2026-10-20T12:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-10-20T12:00:00Z';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Snap';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'snap@example.com';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
// the board's two `ps` reads (every process's parent, and a pid's tty and start) are answered from the fixtures' own
// child processes, so a loaded machine can't time them out into a different board. The stub is first on the PATH.
const STUBS = path.join(WORK, 'stubs');
mkdirSync(STUBS, { recursive: true });
writeFileSync(
  path.join(STUBS, 'ps'),
  [
    '#!/bin/sh',
    'dir=$(dirname "$0")',
    'case "$*" in',
    '  *-A*) cat "$dir/parents.txt" ;;',
    '  *-p*) for pid in $(echo "${*##*-p }" | tr "," " "); do grep "^ *$pid " "$dir/starts.txt"; done ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
);
chmodSync(path.join(STUBS, 'ps'), 0o755);
process.env.PATH = `${STUBS}${path.delimiter}${process.env.PATH}`;
const parentRows: string[] = [];
const startRows: string[] = [];
const noteProcess = (pid: number, ppid: number, start: string) => {
  parentRows.push(`${pid} ${ppid}`);
  startRows.push(`${pid} ?? ${start}`);
  writeFileSync(path.join(STUBS, 'parents.txt'), `${parentRows.join('\n')}\n`);
  writeFileSync(path.join(STUBS, 'starts.txt'), `${startRows.join('\n')}\n`);
};

const NOW = new Date('2026-10-26T19:00:00Z');
// freeze the clock: the stores stamp events with `new Date()` and the board compares against Date.now()
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(NOW.getTime());
    } else {
      // @ts-expect-error pass through
      super(...args);
    }
  }
  static now() {
    return NOW.getTime();
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const src = (file: string) => import(path.join(ROOT, 'packages/bridge/src', file));
const { Board, noPrWatcher } = await src('services/board/board.ts');
const { StoryStore } = await src('services/stories/store.ts');
const { Builds } = await src('services/inbox/builds.ts');
const { seenCheckout, repoOfCheckoutAsync } = await src('services/config/repos.ts');
// the repo of a folder, already answered: the board waits only 500 ms for a lookup and falls back to what it knew
// (the real async lookup, with git run in-process so its answer, and the board's last-known repo, are there at once)
const gitNow = (repo: string, args: string[]) => {
  try {
    const stdout = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  } catch {
    return Promise.resolve({ code: 1, stdout: '', stderr: '' });
  }
};
const repoOf = (cwd: string) => repoOfCheckoutAsync(cwd, { run: gitNow });

let counter = 0;
const tmp = (name: string) => {
  const dir = path.join(WORK, `${name}-${String(++counter).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitAt = (cwd: string, when: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  }).trim();
// the real ps (by path, not the stub), asked once when a child is made
const procStartOf = (pid: number, ppid: number) => {
  const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();
  noteProcess(pid, ppid, start);
  return start;
};

const children: { pid: number; kill: () => void }[] = [];
const servers: net.Server[] = [];
function liveChild() {
  const child = spawn('sleep', ['120']);
  children.push({ pid: child.pid as number, kill: () => child.kill() });
  const pid = child.pid as number;
  return { pid, procStart: procStartOf(pid, process.pid) };
}
function parentWithChild(): Promise<{ parent: number; child: number; procStart: string }> {
  const shell = spawn('sh', ['-c', 'sleep 120 & echo $!; wait']);
  return new Promise((resolve) => {
    shell.stdout.once('data', (chunk) => {
      const child = Number(String(chunk).trim());
      children.push({
        pid: shell.pid as number,
        kill: () => {
          shell.kill();
          try {
            process.kill(child);
          } catch {
            /* gone */
          }
        },
      });
      const procStart = procStartOf(shell.pid as number, process.pid);
      procStartOf(child, shell.pid as number);
      resolve({ parent: shell.pid as number, child, procStart });
    });
  });
}
const pidsSeen = new Set<number>();
const pidOf = <T extends { pid: number }>(item: T) => (pidsSeen.add(item.pid), item);

const fullId = (pid: number) => `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');

function transcript(cwd: string, sessionId: string, lines: unknown[]) {
  const file = path.join(
    process.env.CLAUDE_CONFIG_DIR as string,
    'projects',
    cwd.replace(/[^A-Za-z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}
const usedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'user', message: { role: 'user', content: 'fix the build' }, sessionId },
  { type: 'assistant', message: { role: 'assistant', content: [] }, sessionId },
];
const clearedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  {
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>',
    },
    sessionId,
  },
];
function registry(
  dir: string,
  child: { pid: number; procStart: string },
  extra: Record<string, unknown> = {},
  { blank = false, titled }: { blank?: boolean; titled?: string } = {},
) {
  pidOf(child);
  const sessionId = fullId(child.pid);
  const cwd = (extra.cwd as string) || '/tmp/somewhere/widgets';
  const lines = blank ? clearedLines(sessionId) : usedLines(sessionId);
  if (titled) {
    lines.push({ type: 'ai-title', aiTitle: titled, sessionId } as never);
  }
  transcript(cwd, sessionId, lines);
  writeJson(path.join(dir, `${child.pid}.json`), {
    pid: child.pid,
    sessionId,
    cwd: '/tmp/somewhere/widgets',
    name: `session-${child.pid}`,
    status: 'idle',
    startedAt: NOW.getTime() - 3600000,
    statusUpdatedAt: NOW.getTime() - 600000,
    procStart: child.procStart,
    ...extra,
  });
}

function checkoutOf(name: string, branch: string, commit = false): string {
  const dir = tmp('checkout');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  if (commit) {
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  return dir;
}

/** The story's files get a fixed modified time (it is the story's version), so the order stories list in is the same every run. */
function stamp(dir: string, n: number) {
  const when = new RealDate(NOW.getTime() - 3600000 - n * 60000);
  for (const name of ['chapters.json', 'meta.json']) {
    utimesSync(path.join(dir, name), when, when);
  }
}

function prStory(
  home: string,
  id: string,
  repo: string,
  number: number,
  branch: string | null = null,
  state: Record<string, unknown> = {},
) {
  const dir = path.join(home, id);
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo,
    number,
    pr_title: `PR ${number}`,
    built_at: `2026-10-26T12:${String(number).padStart(2, '0')}:00Z`,
    ...(branch ? { head_ref: branch } : {}),
  });
  writeJson(path.join(dir, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
  stamp(dir, number);
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}
function localStory(
  home: string,
  id: string,
  repoPath: string,
  branch: string | null,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    base: 'origin/main',
    head: 'HEAD',
    branch,
    title: `Local ${id}`,
    built_at: `2026-10-26T13:${String(id.length).padStart(2, '0')}:00Z`,
    ...extra,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story of ${id}`, chapters: [] });
  stamp(path.join(home, id), 100 + id.length);
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

const sourceSaying = (
  says: Record<string, { status: 'waiting' | 'working' | 'done'; detail: string | null }>,
) => ({
  name: 'iterm' as const,
  statuses: async (sessions: { session: string }[]) =>
    new Map(
      sessions.flatMap((session) => {
        const found = says[session.session.slice(0, 8)];
        return found ? [[session.session, { ...found, title: 'Tab title' }] as const] : [];
      }),
    ),
});

const prInfo = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  branch: null,
  author: 'octocat',
  mine: true,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
  ...extra,
});

/** A GitHub watcher that answers from what it is given and logs what was asked, in order. */
function fakeWatcher(
  infos: ReturnType<typeof prInfo>[] = [],
  branchPrs: Record<string, unknown> = {},
  requested: { repo: string; number: number }[] = [],
) {
  const asked: string[] = [];
  const watcher = {
    kick: (list: { id: string }[]) => asked.push(`kick ${list.map((story) => story.id).join(',')}`),
    kickInfo: (repo: string, number: number) => asked.push(`kickInfo ${repo}#${number}`),
    kickBranch: (repo: string, branch: string, checkout: string) =>
      asked.push(`kickBranch ${repo}@${branch} ${checkout}`),
    info: (_repo: string, number: number) => infos.find((info) => info.number === number) || null,
    branchPr: (repo: string, branch: string) => branchPrs[`${repo}@${branch}`],
    kickLocal: (list: { story: { id: string } }[]) =>
      asked.push(`kickLocal ${list.map((entry) => entry.story.id).join(',')}`),
    kickRequested: () => asked.push('kickRequested'),
    requested: () => requested,
  };
  return { watcher, asked };
}

const results: Record<string, unknown> = {};
/** commits whose sha shows in a golden: made at run time, so normalized like the pids */
const shasSeen: string[] = [];
async function record(
  name: string,
  board: any,
  extras: Record<string, () => Promise<unknown>> = {},
) {
  const out: Record<string, unknown> = { board: await board.snapshot() };
  for (const [key, fn] of Object.entries(extras)) {
    try {
      out[key] = await fn();
    } catch (err) {
      out[key] = { error: (err as Error).message, status: (err as { status?: number }).status };
    }
  }
  results[name] = out;
}

// ---- 1. nothing configured
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('1-empty', board);
}

// ---- 2. the busy mix: PR works, sessions on branches, agents, merged and requested PRs, claimed builds, blank sessions
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  const notes = tmp('notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  const [onStory, second, onBranch, onMain, loose, staleOne, staleTwo, blank, titled] = Array.from(
    { length: 9 },
    () => liveChild(),
  );
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const widgetsZ = checkoutOf('widgets', 'feat/z');
  const gadgets = checkoutOf('gadgets', 'main');
  const noRepo = tmp('no-repo');
  const stale = checkoutOf('widgets', 'old/merged');
  registry(sessions, onStory, { cwd: widgetsX, name: 'story-one', status: 'busy' });
  registry(sessions, second, { cwd: widgetsX, name: 'story-two' });
  registry(sessions, onBranch, { cwd: widgetsY, name: 'branch-one' });
  registry(sessions, onMain, { cwd: gadgets, name: 'main-one' });
  registry(sessions, loose, { cwd: noRepo, name: 'loose-one' });
  registry(sessions, staleOne, { cwd: stale, name: 'stale-one' });
  registry(sessions, staleTwo, { cwd: stale, name: 'stale-two' });
  registry(sessions, blank, { cwd: gadgets, name: 'blank-one' }, { blank: true });
  registry(
    sessions,
    titled,
    { cwd: noRepo, name: '', statusUpdatedAt: NOW.getTime() - 5000 },
    { titled: 'Fixing the flaky spec' },
  );

  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  prStory(home, 'acme-widgets-8', 'acme/widgets', 8, 'feat/z');
  prStory(home, 'acme-widgets-14', 'acme/widgets', 14, 'feat/theirs');
  prStory(home, 'acme-widgets-15', 'acme/widgets', 15, 'feat/unknown');
  const byHand = { 'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' } };
  const opened = { 'position.json': { at: '2099-01-01T00:00:00Z' } };
  prStory(home, 'acme-widgets-10', 'acme/widgets', 10, 'feat/ten', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-11', 'acme/widgets', 11, 'feat/eleven', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-17', 'acme/widgets', 17, 'feat/seventeen', byHand);
  prStory(home, 'acme-widgets-18', 'acme/widgets', 18, 'feat/eighteen', { ...byHand, ...opened });
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3600000).toISOString();
  prStory(home, 'acme-widgets-12', 'acme/widgets', 12, 'feat/twelve', {
    'merged.json': { at: hoursAgo(1), why: 'merged', merged_at: hoursAgo(2) },
  });
  prStory(home, 'acme-widgets-13', 'acme/widgets', 13, 'feat/thirteen', {
    'merged.json': { at: hoursAgo(71), why: 'merged', merged_at: hoursAgo(72) },
  });
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-18',
      repo: 'acme/widgets',
      kind: 'github',
      title: null,
      url: null,
      branch: null,
      checkout: null,
      notes: [],
      to: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      claimed_by: 'session-a',
      claimed_at: NOW.toISOString(),
    },
  });
  new Builds(home).save({
    'acme/widgets#16': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 16,
      url: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      mode: 'rebuild',
      claimed_by: 'session-b',
      claimed_at: NOW.toISOString(),
    },
  });
  // local stories: one on a branch GitHub knows a PR for, one on a default branch, one with no branch, one approved
  localStory(home, 'local-y', widgetsY, 'feat/y');
  localStory(home, 'local-main', gadgets, 'main', { repo_name: 'gadgets' });
  localStory(home, 'local-nobranch', widgetsZ, null);
  localStory(
    home,
    'local-seen',
    widgetsZ,
    'feat/seen',
    {},
    { 'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' } },
  );
  localStory(
    home,
    'local-approved',
    widgetsZ,
    'feat/appr',
    {},
    { 'approved.json': { at: '2026-10-26T15:00:00Z' } },
  );
  localStory(home, 'local-merged-branch', widgetsZ, 'feat/mb');
  // agents registered on a branch or PR: nested in its card. The ledger lines below are agents nobody registered
  const registered = new AgentRegistry(home);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const widgets = { repo: 'acme/widgets', model: 'sonnet', effort: 'low' };
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'nested-one',
    kind: 'author',
    task: 'nested task',
    branch: 'feat/x',
    at: et(14, 50),
  });
  registered.beat('nested-one', { n: 3, of: 6, step: 'code', note: 'writing', at: et(14, 52) });
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'pr-agent',
    kind: 'author',
    task: 'review fixes',
    pr: 7,
    at: et(14, 51),
  });
  registered.start({
    ...widgets,
    sid: sid(onBranch),
    name: 'gated-plan',
    kind: 'author',
    task: 'plan for feat/y',
    branch: 'feat/y',
    at: et(14, 46),
  });
  registered.state('gated-plan', {
    state: 'plan',
    outcome: 'plan up',
    notes: 'notes/p.md',
    at: et(14, 46),
  });
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'parked-review',
    kind: 'author',
    task: 'story for PR #8',
    pr: 8,
    at: et(14, 47),
  });
  registered.state('parked-review', { state: 'review', outcome: 'story up', at: et(14, 47) });
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'fixer',
    kind: 'author',
    task: 'fixing PR #18',
    pr: 18,
    at: et(14, 49),
  });
  registered.state('fixer', { state: 'fixing', outcome: 'fixing', at: et(14, 49) });
  // finished with no result and no card to nest in: research is Research, a helper that did its job is Done, an author that made nothing is Waiting for an hour
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'scout',
    kind: 'research',
    task: 'compare the options',
    at: et(14, 40),
  });
  registered.finish('scout', {
    outcome: 'options laid out',
    notes: '~/Development/ClariFi/notes/research/2026-10-26-options.md',
    at: et(14, 50),
  });
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'built-nothing',
    kind: 'author',
    task: 'try the thing',
    at: et(14, 41),
  });
  registered.finish('built-nothing', { outcome: 'nothing to commit', at: et(14, 51) });
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'lookup',
    kind: 'helper',
    task: 'check the deploy status',
    at: et(14, 42),
  });
  registered.finish('lookup', { outcome: 'deploy is healthy', at: et(14, 52) });
  writeFileSync(
    ledger,
    [
      `- [done] sid:${sid(onStory)} nested-done — 2:40 PM ET, 10/26 — it finished`,
      `- [done] sid:${sid(onStory)} nested-old — 7:40 AM ET, 10/26 — hours ago`,
      `- [running] sid:${sid(onStory)} lane:cross-cutting tagged-one (sonnet, high) — tagged task — started 2:55 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} wt-agent (sonnet, low) — refactor in widgets-worktrees/refactor — started 2:52 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} crosscut-note (sonnet, low) — notes for the Cross Cutting plan — started 2:53 PM ET, 10/26`,
      `- [waiting] sid:${sid(onMain)} needs-answer — 2:45 PM ET, 10/26 — needs Eric: pick A or B — notes/x.md`,
      `- [review] sid:${sid(loose)} parked-two (sonnet, low) — story elsewhere — 2:48 PM ET, 10/26 — story up`,
      '- [running] sid:deadbeef orphan (sonnet, high) — no parent — started 2:57 PM ET, 10/26',
      '- [failed] sid:deadbeef broke — 2:58 PM ET, 10/26 — exploded',
      '- [stopped] sid:deadbeef stopped-one — 2:59 PM ET, 10/26 — asked to stop',
      '- [waiting] sid:deadbeef ancient — 9:00 AM ET, 10/22 — needs Eric: long ago — notes/y.md',
    ].join('\n'),
  );
  writeFileSync(progress, '- 2:56 PM tagged-one 1/6 read: reading\n');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
    board_sessions_dir: sessions,
    board_ledger_time_zone: 'America/New_York',
    board_it2_path: (() => {
      const file = path.join(tmp('it2'), 'it2');
      writeFileSync(file, '#!/bin/sh\necho "[]"\n');
      chmodSync(file, 0o755);
      return file;
    })(),
  });
  // statusline files: context and usage limits
  writeJson(path.join(home, 'statusline', `${fullId(onStory.pid)}.json`), {
    at: NOW.getTime() / 1000 - 30,
    context: 52,
    rate_limits: {
      five_hour: { used_percentage: 61, resets_at: NOW.getTime() / 1000 + 3600 },
      seven_day: { used_percentage: 22, resets_at: NOW.getTime() / 1000 + 86400 },
    },
  });
  const { watcher, asked } = fakeWatcher(
    [
      prInfo(7, {
        title: 'Seven on GitHub',
        branch: 'feat/x',
        approvals: 1,
        required: 2,
        checks: 'success',
        merge: { ready: false, text: 'needs 1 more approval', tone: 'warn' },
      }),
      prInfo(8),
      prInfo(14, { author: 'someone', mine: false }),
      prInfo(16, { author: 'someone', mine: false }),
      prInfo(17),
      prInfo(18),
      prInfo(19, { author: 'someone', mine: false, review_requested: true }),
      prInfo(9, { branch: 'feat/y', checks: 'pending' }),
      prInfo(10, { viewer_at: '2026-10-26T13:00:00Z', others_at: '2026-10-26T15:00:00Z' }),
      prInfo(11, { others_at: '2026-10-26T13:00:00Z' }),
      prInfo(12, { state: 'merged', merged_at: hoursAgo(2) }),
      prInfo(21, { branch: 'feat/mb', state: 'merged', merged_at: hoursAgo(3) }),
      prInfo(22, { state: 'closed' }),
    ],
    {
      'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
      'acme/widgets@old/merged': { number: 3, state: 'merged', merged_at: hoursAgo(5) },
      'acme/widgets@feat/mb': { number: 21, state: 'merged', merged_at: hoursAgo(3) },
    },
    [{ repo: 'acme/widgets', number: 19 }],
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(onBranch)]: { status: 'waiting', detail: 'asked you a question' },
      [sid(loose)]: { status: 'working', detail: 'compiling' },
      [sid(staleTwo)]: { status: 'done', detail: null },
      [sid(blank)]: { status: 'idle', detail: null } as never,
      [sid(titled)]: { status: 'done', detail: null },
    }),
    now: () => NOW,
    repoOf,
    aheadOf: async () => 2,
  });
  await record('2-busy-mix', board, {
    asked: async () => asked.slice(),
    listenSessions: () => board.listenSessions('acme/widgets'),
    storyListen: () => board.storyListenSessions('local-y'),
  });
  // a second snapshot a moment later: the kept answer and `since`
  (results['2-busy-mix'] as Record<string, unknown>).asked2 = asked.slice();
}

// ---- 3. listeners (repo and story), a voice session with phone mode, agents on the voice session
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  const voiceDir = tmp('voice');
  const larmor = tmp('larmor');
  mkdirSync(path.join(larmor, '.venv-app', 'bin'), { recursive: true });
  mkdirSync(path.join(larmor, 'app'), { recursive: true });
  writeFileSync(path.join(larmor, '.venv-app', 'bin', 'python'), '');
  writeFileSync(path.join(larmor, 'app', 'voice_ctl.py'), '');
  const tree = await parentWithChild();
  const tree2 = await parentWithChild();
  const [voice, other, idleOne, idleTwo, busy] = Array.from({ length: 5 }, () => liveChild());
  const widgets = checkoutOf('widgets', 'main');
  const gadgets = checkoutOf('gadgets', 'main');
  registry(
    sessions,
    { pid: tree.parent, procStart: tree.procStart },
    { cwd: widgets, name: 'listener-one' },
  );
  registry(
    sessions,
    { pid: tree2.parent, procStart: tree2.procStart },
    { cwd: gadgets, name: 'listener-two' },
  );
  registry(sessions, voice, { cwd: widgets, name: 'clarifi-f9', status: 'busy' });
  registry(sessions, other, { cwd: widgets, name: 'plain-one' });
  registry(sessions, idleOne, { cwd: widgets, name: 'idle-one' });
  registry(sessions, idleTwo, { cwd: gadgets, name: 'idle-two' });
  registry(sessions, busy, { cwd: widgets, name: 'busy-one', status: 'busy' });
  const notes = tmp('notes');
  const ledger = path.join(notes, 'ledger.md');
  writeFileSync(
    ledger,
    [
      `- [running] sid:${sid(voice)} lane:elsewhere helper-one (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
      `- [waiting] sid:${sid(voice)} helper-two — 2:55 PM ET, 10/26 — needs Eric: pick — notes/x.md`,
      `- [done] sid:${sid(voice)} helper-three — 2:56 PM ET, 10/26 — done`,
      `- [review] sid:${sid(voice)} helper-four (sonnet, low) — story abc up, two chapters — 2:57 PM ET, 10/26`,
      `- [review] sid:${sid(voice)} helper-five — story old — 9:00 AM ET, 10/24`,
      `- [running] sid:${sid(other)} not-the-voice (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
    ].join('\n'),
  );
  // an editor (the `busy` session, not the voice session) with one registered builder it launched: the editors strip
  // and the author's "by Editor"
  const editing = new AgentRegistry(home);
  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60000);
  editing.start({
    name: 'editor-widgets',
    sid: sid(busy),
    session: fullId(busy.pid),
    kind: 'editor',
    slots: 3,
    task: 'editor for widgets',
    repo: 'acme/widgets',
    cwd: widgets,
    at: minutesAgo(120),
  });
  editing.start({
    name: 'ou-writer',
    sid: sid(busy),
    kind: 'author',
    task: 'write the thing',
    repo: 'acme/widgets',
    at: minutesAgo(30),
  });
  editing.beat('ou-writer', { n: 3, of: 6, step: 'code', note: '', at: minutesAgo(5) });
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    last_listen: 5,
    last_speak: 4,
  });
  writeFileSync(path.join(voiceDir, 'voice-session-name'), 'clarifi-f9\n');
  writeFileSync(path.join(voiceDir, 'away'), '');
  const wall = (minutes: number) => NOW.getTime() / 1000 - minutes * 60;
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    [
      {
        id: 'm1',
        wall: wall(5),
        text: 'One sec, checking.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
      {
        id: 'm3',
        wall: wall(2),
        text: 'It is green.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(voiceDir, 'turns.jsonl'),
    [{ type: 'turn', channel: 'mic', text: 'Is it green?', is_final: true, wall_clock: wall(3) }]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  writeJson(path.join(home, 'statusline', `${fullId(voice.pid)}.json`), {
    at: NOW.getTime() / 1000 - 30,
    context: 37,
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  localStory(home, 'local-w', widgets, 'main');
  writeJson(path.join(home, 'listeners', 'repo-acme-widgets.json'), {
    consumer: 'repo-acme-widgets',
    pid: tree.child,
    state: 'waiting',
    at: NOW.toISOString(),
    repo: 'acme/widgets',
  });
  writeJson(path.join(home, 'listeners', 'story-local-w.json'), {
    consumer: 'story-local-w',
    pid: tree2.child,
    state: 'waiting',
    at: NOW.toISOString(),
    story: 'local-w',
  });
  writeJson(path.join(home, 'listeners', 'story-acme-widgets-7.json'), {
    consumer: 'story-acme-widgets-7',
    pid: 999999,
    state: 'handling',
    at: NOW.toISOString(),
    story: 'acme-widgets-7',
    session: fullId(other.pid),
  });
  const it2 = path.join(tmp('it2'), 'it2');
  writeFileSync(it2, '#!/bin/sh\necho "[]"\n');
  chmodSync(it2, 0o755);
  // the phone bridge's port is this world's own listener, so `phone.bridge` never depends on the machine running the tests
  const sink = net.createServer((socket) => socket.destroy()).unref();
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  servers.push(sink);
  writeJson(path.join(voiceDir, 'phone.json'), {
    sink_port: (sink.address() as net.AddressInfo).port,
  });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_ledger_time_zone: 'UTC',
    board_voice_dir: voiceDir,
    board_larmor_dir: larmor,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  const { watcher, asked } = fakeWatcher([prInfo(7, { branch: 'feat/x' })]);
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(busy)]: { status: 'working', detail: 'compiling' },
      [sid(idleOne)]: { status: 'done', detail: null },
      [sid(idleTwo)]: { status: 'done', detail: null },
      [sid(other)]: { status: 'done', detail: null },
      [sid(tree.parent as never)]: { status: 'working', detail: '1 background task running' },
      [sid(tree2.parent as never)]: { status: 'done', detail: null },
    }),
    now: () => NOW,
    repoOf,
  });
  await record('3-listeners-voice', board, {
    asked: async () => asked.slice(),
    listenWidgets: () => board.listenSessions('acme/widgets'),
    listenGadgets: () => board.listenSessions('acme/gadgets'),
    storyListen: () => board.storyListenSessions('local-w'),
  });
}

// ---- 4. the backlog: open, assigned, started with a worktree, merged; and the worktree section
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  const notes = tmp('notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(
    ledger,
    [
      '- [running] sid:54736864 ou-kill-inbox (sonnet, high) — remove the inbox — started 2:30 PM ET, 10/26',
      '- [done] sid:54736864 ou-old-one (sonnet, high) — build in widgets-worktrees/old-one — 1:30 PM ET, 10/26 — committed on old-one — notes',
    ].join('\n'),
  );
  writeFileSync(progress, '- 2:50 PM ou-kill-inbox 3/6 code: removing\n');
  const parent = tmp('links-repo');
  const checkout = path.join(parent, 'widgets');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  writeFileSync(path.join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  const trees = path.join(parent, 'widgets-worktrees');
  mkdirSync(trees);
  git(checkout, 'worktree', 'add', '-q', path.join(trees, 'kill-inbox'), '-b', 'kill-inbox');
  git(checkout, 'worktree', 'add', '-q', path.join(trees, 'old-one'), '-b', 'old-one');
  git(checkout, 'worktree', 'add', '-q', path.join(trees, 'loose-one'), '-b', 'loose-one');
  git(checkout, 'worktree', 'add', '-q', path.join(trees, 'in-use'), '-b', 'in-use');
  // old-one landed in main (a fast-forward), so it counts as merged locally
  writeFileSync(path.join(trees, 'old-one', 'b.txt'), 'b\n');
  git(path.join(trees, 'old-one'), 'add', '.');
  gitAt(path.join(trees, 'old-one'), '2026-10-26T18:30:00Z', 'commit', '-q', '-m', 'work');
  git(checkout, 'merge', '-q', '--ff-only', 'old-one');
  // dep-bump: an author committed on it, with no PR and not merged: Ready for your review, not Done
  const depBump = path.join(trees, 'dep-bump');
  git(checkout, 'worktree', 'add', '-q', depBump, '-b', 'dep-bump');
  writeFileSync(path.join(depBump, 'c.txt'), 'c\n');
  git(depBump, 'add', '.');
  gitAt(depBump, '2026-10-26T18:40:00Z', 'commit', '-q', '-m', 'bump');
  // the author finished with the worktree's tip (its sha changes run to run, so the golden names it <SHA:n>)
  const depBumpTip = git(depBump, 'rev-parse', 'HEAD');
  shasSeen.push(depBumpTip);
  seenCheckout(home, 'acme/widgets', checkout);
  const [builder, usingTree] = Array.from({ length: 2 }, () => liveChild());
  registry(sessions, builder, { cwd: path.join(trees, 'kill-inbox'), name: 'the builder' });
  registry(sessions, usingTree, { cwd: path.join(trees, 'in-use'), name: 'in-use-one' });
  const idleW = liveChild();
  registry(sessions, idleW, { cwd: checkout, name: 'idle-widgets' });
  const CLAIMED_AT = '2026-10-26T18:35:00.000Z';
  const events = [
    {
      op: 'add',
      id: 'bl_aaaaaa1',
      title: 'Retire the inbox page?',
      note: null,
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    {
      op: 'start',
      id: 'bl_aaaaaa1',
      branch: 'kill-inbox',
      repo: 'acme/widgets',
      by: 'ou-kill-inbox',
    },
    {
      op: 'add',
      id: 'bl_aaaaaa2',
      title: 'Old one',
      note: 'n',
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    { op: 'start', id: 'bl_aaaaaa2', branch: 'old-one', repo: 'acme/widgets', by: 'ou-old-one' },
    {
      op: 'add',
      id: 'bl_aaaaaa3',
      title: 'Open one',
      note: 'second note',
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    {
      op: 'add',
      id: 'bl_aaaaaa4',
      title: 'Open two (no repo)',
      note: null,
      repo: null,
      branch: null,
      by: 'cli',
    },
    {
      op: 'add',
      id: 'bl_aaaaaa5',
      title: 'Assigned one',
      note: null,
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    {
      op: 'assign',
      id: 'bl_aaaaaa5',
      session: fullId(builder.pid),
      branch: 'assigned-one',
      by: 'cli',
    },
    {
      op: 'add',
      id: 'bl_aaaaaa6',
      title: 'Dropped',
      note: null,
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    { op: 'drop', id: 'bl_aaaaaa6', by: 'cli' },
    {
      op: 'add',
      id: 'bl_aaaaaa7',
      title: 'Started, no tree',
      note: null,
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    { op: 'start', id: 'bl_aaaaaa7', branch: 'ghost-branch', repo: 'acme/widgets', by: 'someone' },
    // maybe someday: still a Backlog card, flagged for the Someday section, with no Assign
    {
      op: 'add',
      id: 'bl_aaaaaa8',
      title: 'Maybe someday',
      note: 'later',
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    { op: 'someday', id: 'bl_aaaaaa8', on: true, by: 'cli' },
    // tried by an agent that failed, then set aside: back in Backlog, and someday
    {
      op: 'add',
      id: 'bl_aaaaaa9',
      title: 'Tried, then set aside',
      note: null,
      repo: 'acme/widgets',
      branch: null,
      by: 'cli',
    },
    {
      op: 'claim',
      id: 'bl_aaaaaa9',
      agent: 'ou-tried',
      sid: 'aaaaaaaa',
      by: 'cli',
      at: CLAIMED_AT,
    },
    { op: 'someday', id: 'bl_aaaaaa9', on: true, by: 'cli' },
  ];
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify({ at: NOW.toISOString(), ...event })).join('\n') + '\n',
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_ledger_file: ledger,
    board_progress_file: progress,
    board_ledger_time_zone: 'UTC',
  });
  const authors = new AgentRegistry(home);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  authors.start({
    sid: sid(builder),
    name: 'dep-bump',
    kind: 'author',
    task: 'bump the lockfile',
    repo: 'acme/widgets',
    branch: 'dep-bump',
    cwd: depBump,
    model: 'sonnet',
    effort: 'low',
    at: et(14, 30),
  });
  authors.finish('dep-bump', {
    outcome: 'lockfile bumped',
    result: { commit: depBumpTip, branch: 'dep-bump' },
    at: et(14, 41),
  });
  authors.start({
    sid: 'aaaaaaaa',
    name: 'ou-tried',
    kind: 'author',
    task: 'try the set-aside card',
    repo: 'acme/widgets',
    model: 'sonnet',
    effort: 'low',
    at: et(14, 30),
  });
  authors.finish('ou-tried', { state: 'failed', outcome: 'gave up', at: et(14, 41) });
  const { watcher, asked } = fakeWatcher([], {
    'acme/widgets@dep-bump': null,
    'acme/widgets@kill-inbox': null,
    'acme/widgets@loose-one': { number: 31, state: 'merged', merged_at: '2026-10-25T10:00:00Z' },
  });
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({ [sid(idleW)]: { status: 'done', detail: null } }),
    now: () => NOW,
    repoOf,
  });
  await board.snapshot();
  await (board as any).scanner.idle();
  (board as any).invalidate();
  await record('4-backlog-worktrees', board, {
    asked: async () => asked.slice(),
  });
  await (board as any).scanner.idle();
  (board as any).invalidate();
  results['4b-backlog-worktrees-again'] = { board: await board.snapshot(), asked: asked.slice() };
}

// ---- normalize paths and pids
export const snapshots: Record<string, string> = {};
for (const [name, value] of Object.entries(results)) {
  let text = JSON.stringify(
    value,
    (_key, item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)));
      }
      return item;
    },
    2,
  );
  text = text.split(WORK).join('<WORK>');
  const all = [...new Set([...pidsSeen, ...children.map((child) => child.pid)])];
  // Pids become stable tokens, matched as whole numbers so one can never hit the inside of a sha or another number.
  for (const pid of all) {
    const token = all.indexOf(pid);
    const padded = new RegExp(
      `(?<![0-9A-Za-z])${String(pid).padStart(8, '0')}(?![0-9A-Za-z])`,
      'g',
    );
    const bare = new RegExp(`(?<![0-9A-Za-z.])${pid}(?![0-9A-Za-z])`, 'g');
    text = text.replace(padded, `<PID:${token}>`).replace(bare, `<pid:${token}>`);
  }
  shasSeen.forEach((sha, token) => {
    text = text.split(sha).join(`<SHA:${token}>`).split(sha.slice(0, 7)).join(`<SHA:${token}>`);
  });
  // Disk usage depends on the filesystem's block size.
  text = text.replace(/"size_kb": \d+/g, '"size_kb": "<kb>"');
  snapshots[name] = text + '\n';
}

export function finish() {
  children.forEach((child) => child.kill());
  servers.forEach((server) => server.close());
  rmSync(WORK, { recursive: true, force: true });
}
