/* eslint-disable no-sequences, id-length, @typescript-eslint/no-explicit-any */
/*
 * Fixture worlds for the /api/board snapshot test: four temp-dir worlds (empty; a busy mix; listeners and voice;
 * backlog with worktrees), each driven through a real Board with a frozen clock, a fake status source and a fake
 * GitHub watcher. Importing this file builds them. `snapshots` maps a world name to its normalized JSON text and
 * `finish()` stops the child processes and removes the temp dir.
 */
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { noteListener } from '@once-upon-a-diff/state/records/listeners/history';
import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import { dirOf } from '../../../../../../configs/layers.mjs';
import { fileURLToPath } from 'node:url';
import { voiceState } from '@once-upon-a-diff/adapters/larmor';
import { runCommand } from '@once-upon-a-diff/adapters/os';
import { fakeLarmorIn } from '@once-upon-a-diff/test-kit/fake-larmor';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
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

const src = (pkg: string, file: string) =>
  import(path.join(ROOT, 'packages', dirOf(pkg), 'src', file));
const { Board, noPrWatcher } = await src('board', 'board.ts');
const { backfillCards } = await src('core', 'features/runs/backfill.ts');
const { StoryStore } = await src('stories', 'store.ts');
const { Builds } = await src('state', 'queues/requests/builds.ts');
const { seenCheckout, repoOfCheckoutAsync } = await src('foundation', 'repos.ts');
const { branchMovedPastAsync } = await src('adapters', 'git.ts');
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
let startedCount = 0;

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
    // the board lists sessions oldest first: each one started a second after the one registered before it, so the order is
    // the order they are registered in, whatever pids the machine handed out (a pid that wrapped round is smaller)
    startedAt: NOW.getTime() - 3600000 + 1000 * startedCount++,
    statusUpdatedAt: NOW.getTime() - 600000,
    procStart: child.procStart,
    ...extra,
  });
}

/** A registered agent's run, standing where `now` says (still running without it), as the worlds' agents are set up. */
interface Run {
  sid: string;
  name: string;
  kind?: 'author' | 'critic' | 'helper' | 'research' | 'storyteller';
  model?: string;
  effort?: string;
  lane?: string;
  task?: string;
  started: Date;
  now?: {
    state: 'waiting' | 'review' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
    at: Date;
    outcome?: string;
    notes?: string;
  };
  beat?: { n: number; of: number; step: string; note: string; at: Date };
}

function registerRun(registry: AgentRegistry, run: Run) {
  const { sid, name, now } = run;
  registry.start({
    sid,
    name,
    kind: run.kind ?? 'helper',
    task: run.task ?? `${name}'s task`,
    model: run.model ?? null,
    effort: run.effort ?? null,
    lane: run.lane ?? null,
    at: run.started,
  });
  if (run.beat) {
    registry.beat(name, { ...run.beat, sid });
  }
  if (!now) {
    return;
  }
  const { state, at, outcome = null, notes = null } = now;
  if (state === 'done' || state === 'failed' || state === 'stopped') {
    registry.finish(name, { sid, state, outcome, notes, at });
  } else {
    registry.state(name, { sid, state, outcome, notes, at });
  }
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
  name: 'registry' as const,
  statuses: async (sessions: { session: string }[]) =>
    new Map(
      sessions.flatMap((session) => {
        const found = says[session.session.slice(0, 8)];
        return found ? [[session.session, { ...found, tab: true }] as const] : [];
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
    // an answer a world gave counts as just in (never old); no answer is "never"
    infoAt: (_repo: string, number: number) =>
      infos.some((info) => info.number === number) ? Infinity : null,
    branchPr: (repo: string, branch: string) => branchPrs[`${repo}@${branch}`],
    branchAt: (repo: string, branch: string) =>
      `${repo}@${branch}` in branchPrs ? Infinity : null,
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
// every world's board, for the stored-card gate below (storedCardsChangeNothing)
type BoardLike = {
  lanes: { cards: { subagents?: { rows: { started_at: string | null }[] } }[] }[];
};
const worldBoards: { name: string; board: any; home: string }[] = [];

async function record(
  name: string,
  board: any,
  extras: Record<string, () => Promise<unknown>> = {},
) {
  // the board joins a run to its card by the stored card: store the ones the world's runs name, as `card backfill` does
  backfillCards(board.home);
  worldBoards.push({ name, board, home: board.home });
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
  const byHand = { 'review.json': { mark: { at: '2026-10-26T14:00:00Z', by: 'manual' } } };
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
    { 'review.json': { mark: { at: '2026-10-26T14:00:00Z', by: 'manual' } } },
  );
  localStory(home, 'local-approved', widgetsZ, 'feat/appr');
  localStory(home, 'local-merged-branch', widgetsZ, 'feat/mb');
  // agents on an implicit card with a repo and branch: nested in the work card on that branch (ADR-27). A run that names no card
  // never nests, whatever PR or branch it was registered on: `parked-review`, `fixer` and the runs further down are cards of their own
  const registered = new AgentRegistry(home);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const widgets = { repo: 'acme/widgets', model: 'sonnet', effort: 'low' };
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'nested-one',
    kind: 'author',
    task: 'nested task',
    card: 'ic_nestedone01',
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
    card: 'ic_nestedpr0001',
    branch: 'feat/x',
    at: et(14, 51),
  });
  registered.start({
    ...widgets,
    sid: sid(onBranch),
    name: 'gated-plan',
    kind: 'author',
    task: 'plan for feat/y',
    card: 'ic_gatedplan001',
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
  // a research run still out finding something is Thinking, beside the finished one in Research
  registered.start({
    ...widgets,
    sid: sid(onStory),
    name: 'thinker',
    kind: 'research',
    task: 'find the cheaper option',
    at: et(14, 43),
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
  const sonnet = (effort: string) => ({ model: 'sonnet', effort });
  const ancient = new Date(Date.UTC(2026, 9, 22, 13, 0)); // 9:00 AM ET, 10/22
  for (const run of [
    {
      sid: sid(onStory),
      name: 'nested-done',
      started: et(14, 40),
      now: { state: 'done', at: et(14, 40), outcome: 'it finished' },
    },
    {
      sid: sid(onStory),
      name: 'nested-old',
      started: et(7, 40),
      now: { state: 'done', at: et(7, 40), outcome: 'hours ago' },
    },
    {
      sid: sid(onStory),
      name: 'tagged-one',
      ...sonnet('high'),
      task: 'tagged task',
      started: et(14, 55),
      beat: { n: 1, of: 6, step: 'read', note: 'reading', at: et(14, 56) },
    },
    {
      sid: sid(onStory),
      name: 'wt-agent',
      ...sonnet('low'),
      task: 'refactor in widgets-worktrees/refactor',
      started: et(14, 52),
    },
    {
      sid: sid(onStory),
      name: 'crosscut-note',
      ...sonnet('low'),
      task: 'notes for the Cross Cutting plan',
      started: et(14, 53),
    },
    {
      sid: sid(onMain),
      name: 'needs-answer',
      started: et(14, 45),
      now: {
        state: 'waiting',
        at: et(14, 45),
        outcome: 'needs Eric: pick A or B',
        notes: 'notes/x.md',
      },
    },
    {
      sid: sid(loose),
      name: 'parked-two',
      started: et(14, 48),
      now: { state: 'review', at: et(14, 48), outcome: 'story up' },
    },
    {
      sid: 'deadbeef',
      name: 'orphan',
      ...sonnet('high'),
      task: 'no parent',
      started: et(14, 57),
    },
    {
      sid: 'deadbeef',
      name: 'broke',
      started: et(14, 58),
      now: { state: 'failed', at: et(14, 58), outcome: 'exploded' },
    },
    {
      sid: 'deadbeef',
      name: 'stopped-one',
      started: et(14, 59),
      now: { state: 'stopped', at: et(14, 59), outcome: 'asked to stop' },
    },
    {
      sid: 'deadbeef',
      name: 'ancient',
      started: ancient,
      now: { state: 'waiting', at: ancient, outcome: 'needs Eric: long ago', notes: 'notes/y.md' },
    },
  ] as Run[]) {
    registerRun(registered, run);
  }
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
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
  // The first build kicks the worktree scan (real git, in the background) and the scan drops the board's kept answer
  // whenever it lands, so how many builds the calls below make (and so how often the watcher is asked again, the
  // `asked2` log) followed the machine's speed. Its git is held until the second build is done, then waited for.
  let releaseScan = () => {};
  const scanHeld = new Promise<void>((resolve) => (releaseScan = resolve));
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    worktreeRun: async (cmd: string, args: string[], timeoutMs: number) => {
      await scanHeld;
      return runCommand(cmd, args, timeoutMs);
    },
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
    listenSessions: async () => {
      const out = await board.listenSessions('acme/widgets');
      releaseScan();
      await (board as any).scanner.idle();
      return out;
    },
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
  const larmor = fakeLarmorIn(tmp('larmor'), voiceDir);
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
  // the voice session's agents and another session's, none registered on a repo, branch or PR
  const helpers = new AgentRegistry(home);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const old = new Date(Date.UTC(2026, 9, 24, 13, 0)); // 9:00 AM ET, 10/24
  for (const run of [
    {
      sid: sid(voice),
      name: 'helper-one',
      model: 'sonnet',
      effort: 'low',
      task: 'a task',
      started: et(14, 50),
    },
    {
      sid: sid(voice),
      name: 'helper-two',
      started: et(14, 55),
      now: { state: 'waiting', at: et(14, 55), outcome: 'needs Eric: pick', notes: 'notes/x.md' },
    },
    {
      sid: sid(voice),
      name: 'helper-three',
      started: et(14, 56),
      now: { state: 'done', at: et(14, 56), outcome: 'done' },
    },
    {
      sid: sid(voice),
      name: 'helper-four',
      started: et(14, 57),
      now: { state: 'review', at: et(14, 57), outcome: 'story abc up, two chapters' },
    },
    {
      sid: sid(voice),
      name: 'helper-five',
      started: old,
      now: { state: 'review', at: old, outcome: 'story old' },
    },
    {
      sid: sid(other),
      name: 'not-the-voice',
      model: 'sonnet',
      effort: 'low',
      task: 'a task',
      started: et(14, 50),
    },
  ] as Run[]) {
    registerRun(helpers, run);
  }
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    owner: process.pid,
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
  // what the wait's own heartbeat notes (the board only reads the history)
  noteListener(home, 'acme/widgets', 'repo-acme-widgets', NOW.getTime());
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
  // the fake voice_ctl says the phone bridge runs, so `phone.bridge` never depends on the machine running the tests
  writeFileSync(path.join(larmor, 'bridge-up'), '');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_larmor_dir: larmor,
    board_it2_path: it2,
  });
  // the board waits for voice_ctl only so long on its first build: have the answer in before the world is built, however loaded the machine is
  for (let tries = 0; tries < 100 && !(await voiceState(larmor)); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  const agents = new AgentRegistry(home);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  registerRun(agents, {
    sid: '54736864',
    name: 'ou-kill-inbox',
    kind: 'author',
    model: 'sonnet',
    effort: 'high',
    task: 'remove the inbox',
    started: et(14, 30),
    beat: { n: 3, of: 6, step: 'code', note: 'removing', at: et(14, 50) },
  });
  registerRun(agents, {
    sid: '54736864',
    name: 'ou-old-one',
    kind: 'author',
    task: 'build in widgets-worktrees/old-one',
    started: et(13, 30),
    now: { state: 'done', at: et(13, 30), outcome: 'committed on old-one' },
  });
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
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const authors = new AgentRegistry(home);
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
    card: 'bl_aaaaaa9',
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

// ---- 5. the card owns its runs (ADR-25): a fix round restarted with no --card, a critic that typed the wrong repo, a
// researcher that failed, and a carded critic beside an old cardless claimed author: each is one card, no agent card
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    repos: { larmor: { skips_review: true } },
  });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const card = (id: string, title: string, repo: string, branch: string, agent: string) => [
    {
      op: 'add',
      id,
      title,
      note: null,
      repo,
      branch: null,
      by: 'cli',
      at: et(13, 0).toISOString(),
    },
    { op: 'start', id, branch, repo, by: agent, at: et(13, 1).toISOString() },
    { op: 'claim', id, agent, sid: 'cccccccc', by: agent, at: et(13, 2).toISOString() },
  ];
  const ONCE = 'acme/once-upon-a-diff';
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    [
      ...card('bl_ccccc01', 'Fix round, restarted bare', ONCE, 'fix-round', 'ou-fix'),
      ...card('bl_ccccc02', 'Critic typed the wrong repo', ONCE, 'wrong-repo', 'ou-wrong'),
      ...card(
        'bl_ccccc03',
        'A lookup failed after the build',
        'acme/widgets',
        'built-it',
        'ou-built',
      ),
      ...card('bl_ccccc04', 'Old author, new critic', ONCE, 'mixed-rows', 'ou-old'),
      ...card('bl_ccccc05', 'Larmor skips review', 'acme/larmor', 'larmor-built', 'lm-built'),
      ...card('bl_ccccc06', 'Story being told', ONCE, 'story-told', 'ou-story'),
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const runs = new AgentRegistry(home);
  const sid8 = 'cccccccc';
  const author = (name: string, card: string | null, at: Date, extra = {}) =>
    runs.start({ sid: sid8, name, kind: 'author', task: `build ${name}`, card, at, ...extra });
  // 1: built, critic found two things, then a fix round started with no --card and told `fixing`
  author('ou-fix', 'bl_ccccc01', et(13, 5));
  runs.finish('ou-fix', { sid: sid8, result: { branch: 'fix-round' }, at: et(13, 40) });
  runs.start({
    sid: sid8,
    name: 'review-fix',
    kind: 'critic',
    task: 'review',
    card: 'bl_ccccc01',
    at: et(13, 41),
  });
  runs.finish('review-fix', { sid: sid8, findings: 2, at: et(13, 50) });
  author('ou-fix', null, et(13, 55));
  runs.state('ou-fix', { sid: sid8, state: 'fixing', findings: 2, at: et(13, 56) });
  // 2: the critic typed another repo, and passed it
  author('ou-wrong', 'bl_ccccc02', et(13, 5));
  runs.finish('ou-wrong', { sid: sid8, result: { branch: 'wrong-repo' }, at: et(13, 40) });
  runs.start({
    sid: sid8,
    name: 'review-wrong',
    kind: 'critic',
    task: 'review',
    card: 'bl_ccccc02',
    repo: 'esshank/once-upon-a-diff',
    at: et(13, 41),
  });
  runs.finish('review-wrong', { sid: sid8, findings: 0, at: et(13, 50) });
  // 3: built, then a carded researcher failed: no critic has passed, so Waiting (not back in Backlog)
  author('ou-built', 'bl_ccccc03', et(13, 5));
  runs.finish('ou-built', { sid: sid8, result: { branch: 'built-it' }, at: et(13, 40) });
  runs.start({
    sid: sid8,
    name: 'look-it-up',
    kind: 'research',
    task: 'look it up',
    card: 'bl_ccccc03',
    at: et(13, 41),
  });
  runs.finish('look-it-up', { sid: sid8, state: 'failed', at: et(13, 45) });
  // 4: an old brief registered its author with no card, and the claim used to find it. A claim finds no run now (ADR-25), so
  // the author names the card like every run; the cardless old-row case is gone
  author('ou-old', 'bl_ccccc04', et(13, 5), { repo: ONCE, branch: 'mixed-rows' });
  runs.start({
    sid: sid8,
    name: 'review-old',
    kind: 'critic',
    task: 'review',
    card: 'bl_ccccc04',
    at: et(13, 41),
  });
  // 5: a Larmor card whose critic passed is Ready to ship: Larmor skips review
  author('lm-built', 'bl_ccccc05', et(13, 5));
  runs.finish('lm-built', { sid: sid8, result: { branch: 'larmor-built' }, at: et(13, 40) });
  runs.start({
    sid: sid8,
    name: 'review-lm',
    kind: 'critic',
    task: 'review',
    card: 'bl_ccccc05',
    at: et(13, 41),
  });
  runs.finish('review-lm', { sid: sid8, findings: 0, at: et(13, 50) });
  // 6: once-upon-a-diff is reviewed through its story: the critic passed, and the storyteller still writing holds it in Agent checks
  author('ou-story', 'bl_ccccc06', et(13, 5));
  runs.finish('ou-story', { sid: sid8, result: { branch: 'story-told' }, at: et(13, 40) });
  runs.start({
    sid: sid8,
    name: 'review-story',
    kind: 'critic',
    task: 'review',
    card: 'bl_ccccc06',
    at: et(13, 41),
  });
  runs.finish('review-story', { sid: sid8, findings: 0, at: et(13, 50) });
  runs.start({
    sid: sid8,
    name: 'tell-story',
    kind: 'storyteller',
    task: 'tell the story',
    card: 'bl_ccccc06',
    at: et(14, 30),
  });
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('5-card-runs', board);
}

// ---- 6. editors: slots in use counted by the one function, a run launched from the editor's session, a run the sweep closed
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const widgets = checkoutOf('widgets', 'main');
  const editorChild = liveChild();
  registry(sessions, editorChild, { cwd: widgets, name: 'editor-tab', status: 'busy' });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const editorSid = sid(editorChild);
  const runs = new AgentRegistry(home);
  runs.start({
    name: 'editor-widgets',
    sid: editorSid,
    session: fullId(editorChild.pid),
    kind: 'editor',
    slots: 4,
    task: 'once-upon-editor, 4 slots',
    repo: 'acme/widgets',
    cwd: widgets,
    at: et(9, 0),
  });
  const author = (name: string, extra: Record<string, unknown> = {}, at = et(13, 0)) =>
    runs.start({
      sid: editorSid,
      name,
      kind: 'author',
      task: `build ${name}`,
      repo: 'acme/widgets',
      at,
      ...extra,
    });
  // holding a slot: running (with a beat), at its plan check, fixing findings
  author('e-run');
  runs.beat('e-run', { sid: editorSid, n: 3, of: 6, step: 'code', note: '', at: et(14, 0) });
  author('e-plan');
  runs.state('e-plan', { sid: editorSid, state: 'plan', outcome: 'plan ready', at: et(13, 10) });
  author('e-fix');
  runs.state('e-fix', { sid: editorSid, state: 'fixing', findings: 2, at: et(13, 20) });
  // handed back its slot: a question, a story review; and a critic, which is no author
  author('e-ask');
  runs.state('e-ask', { sid: editorSid, state: 'waiting', outcome: 'which one?', at: et(13, 30) });
  author('e-story');
  runs.state('e-story', { sid: editorSid, state: 'review', outcome: 'story abc', at: et(13, 31) });
  runs.start({
    sid: editorSid,
    name: 'e-critic',
    kind: 'critic',
    task: 'review e-run',
    repo: 'acme/widgets',
    at: et(13, 40),
  });
  // silent for over a day while running: the real sweep (below) stops it, so it is no author and holds no slot
  author('e-swept', {}, new Date(NOW.getTime() - 30 * 3600 * 1000));
  // parked at its plan check for over a day: the sweep leaves it (it waits on a person), but it is stale, so it is no
  // author of the editor's and holds no slot
  author('e-stale', {}, new Date(NOW.getTime() - 31 * 3600 * 1000));
  runs.state('e-stale', {
    sid: editorSid,
    state: 'plan',
    outcome: 'plan ready',
    at: new Date(NOW.getTime() - 30 * 3600 * 1000),
  });
  // an author launched from another session, whose run records the editor's full session: the editor's too, through its `session`
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    [
      {
        op: 'add',
        id: 'bl_ddddd01',
        title: 'Claimed by the editor',
        note: null,
        repo: 'acme/widgets',
        branch: null,
        by: 'cli',
        at: et(12, 0).toISOString(),
      },
      {
        op: 'claim',
        id: 'bl_ddddd01',
        agent: 'e-claimed',
        sid: editorSid,
        session: fullId(editorChild.pid),
        by: 'editor',
        at: et(12, 1).toISOString(),
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  runs.start({
    sid: '77777777',
    name: 'e-claimed',
    kind: 'author',
    task: 'build e-claimed',
    card: 'bl_ddddd01',
    session: fullId(editorChild.pid),
    at: et(13, 5),
  });
  // the editor has 4 slots and 4 authors hold them (e-run, e-plan, e-fix and e-claimed, whose run its session launched):
  // `in_use` 4 of 4. Not counted: e-ask and e-story (handed back), e-critic, e-swept (stopped by the sweep) and e-stale
  runs.sweep({ at: NOW });
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('6-editors', board);
}

// ---- 7. implicit cards (ADR-27): work that did not start in the backlog is its own card, held in agents.jsonl alone
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const sid8 = 'eeeeeeee';
  const runs = new AgentRegistry(home);
  const start = (
    name: string,
    card: string,
    kind: 'author' | 'critic' | 'helper' | 'research' | 'storyteller',
    at: Date,
    extra = {},
  ) => runs.start({ sid: sid8, name, kind, task: `${name}'s task`, card, at, ...extra });
  // a: an ad-hoc author that built something, and its critic, still running: one agent card with both
  start('ou-adhoc', 'ic_eeeee01', 'author', et(14, 20), {
    repo: 'acme/widgets',
    branch: 'adhoc-a',
  });
  runs.finish('ou-adhoc', {
    sid: sid8,
    result: { commit: 'abc1234', branch: 'adhoc-a' },
    at: et(14, 40),
  });
  start('review-adhoc', 'ic_eeeee01', 'critic', et(14, 45), {
    repo: 'acme/widgets',
    branch: 'adhoc-a',
  });
  // b: a helper restarted under its name: the same card, one agent card for the latest run
  start('a-helper', 'ic_eeeee02', 'helper', et(13, 0));
  runs.finish('a-helper', { sid: sid8, at: et(13, 10) });
  start('a-helper', 'ic_eeeee02', 'helper', et(14, 10));
  // c: a researcher on a card of its own, running
  start('a-scout', 'ic_eeeee03', 'research', et(14, 15));
  // d: adopted with a branch: the card is in the backlog under the same id and started on it (as `backlog adopt` writes), and
  // its author's run is its run (a Working backlog card, no Assign)
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    [
      {
        op: 'add',
        id: 'ic_eeeee04',
        title: 'Adopted ad-hoc work',
        note: null,
        repo: 'acme/widgets',
        branch: 'adopted-work',
        by: 'cli',
        at: et(14, 5).toISOString(),
      },
      {
        op: 'start',
        id: 'ic_eeeee04',
        branch: 'adopted-work',
        repo: 'acme/widgets',
        by: 'cli',
        at: et(14, 5).toISOString(),
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  start('ou-adopted', 'ic_eeeee04', 'author', et(14, 6), { repo: 'acme/widgets' });
  // c: `--new-card`: a helper restarted onto a card of its own again: the board shows its latest run, on the new card
  start('b-helper', 'ic_eeeee06', 'helper', et(13, 20));
  runs.finish('b-helper', { sid: sid8, at: et(13, 25) });
  start('b-helper', 'ic_eeeee07', 'helper', et(14, 20));
  // e: an implicit card whose last run ended hours ago is off the board
  start('old-helper', 'ic_eeeee05', 'helper', et(10, 0));
  runs.finish('old-helper', { sid: sid8, at: et(10, 30) });
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('7-implicit-cards', board);
}

// ---- 8. a landed card takes its approved local story to Done, then off the board: the work reached the default branch
// by a cherry-pick (the card's landed_sha is in no history of the checkout), so nothing in git says it shipped
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const approvedAt = '2026-10-26T15:00:00Z';
  const approved = (head: string) => ({
    at: approvedAt,
    head_oid: head,
    base_oid: null,
  });
  const landing = (id: string, branch: string, head: string, landedAt: Date) => {
    localStory(
      home,
      `story-${id}`,
      checkoutOf('widgets', branch),
      branch,
      { head_oid: head },
      { 'review.json': { approval: approved(head) } },
    );
    return [
      {
        op: 'add',
        id: `bl_landed${id}`,
        title: `Landed ${id}`,
        note: null,
        repo: 'acme/widgets',
        branch,
        by: 'cli',
        at: et(9, 0).toISOString(),
      },
      {
        op: 'start',
        id: `bl_landed${id}`,
        branch,
        repo: 'acme/widgets',
        by: 'cli',
        at: et(9, 1).toISOString(),
      },
      {
        op: 'done',
        id: `bl_landed${id}`,
        sha: 'c'.repeat(40),
        by: 'cli',
        at: landedAt.toISOString(),
      },
    ];
  };
  // a: landed 20 minutes ago: Done. b: landed 2 hours ago, its only agent finished: gone. d: landed 2 hours ago with an
  // agent still running: stays, without the story. c: approved, not landed: still Ready to ship
  const events = [
    ...landing('a', 'feat/landed-a', 'a'.repeat(40), new Date(NOW.getTime() - 20 * 60000)),
    ...landing('b', 'feat/landed-b', 'b'.repeat(40), new Date(NOW.getTime() - 2 * 3600000)),
    ...landing('d', 'feat/landed-d', 'e'.repeat(40), new Date(NOW.getTime() - 2 * 3600000)),
  ];
  const landedRuns = new AgentRegistry(home);
  landedRuns.start({
    sid: 'dddddddd',
    name: 'ou-landed-b',
    kind: 'author',
    task: 'build b',
    card: 'bl_landedb',
    at: et(9, 5),
  });
  landedRuns.finish('ou-landed-b', {
    sid: 'dddddddd',
    result: { branch: 'feat/landed-b' },
    at: et(9, 40),
  });
  landedRuns.start({
    sid: 'dddddddd',
    name: 'ou-landed-d',
    kind: 'author',
    task: 'build d',
    card: 'bl_landedd',
    at: et(9, 5),
  });
  localStory(
    home,
    'story-c',
    checkoutOf('widgets', 'feat/shipping'),
    'feat/shipping',
    { head_oid: 'd'.repeat(40) },
    { 'review.json': { approval: approved('d'.repeat(40)) } },
  );
  events.push(
    {
      op: 'add',
      id: 'bl_landedc',
      title: 'Not landed',
      note: null,
      repo: 'acme/widgets',
      branch: 'feat/shipping',
      by: 'cli',
      at: et(9, 0).toISOString(),
    },
    {
      op: 'start',
      id: 'bl_landedc',
      branch: 'feat/shipping',
      repo: 'acme/widgets',
      by: 'cli',
      at: et(9, 1).toISOString(),
    },
  );
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('8-landed-ship', board);
}

// ---- 9. a failed helper run (a deploy) is not news once a retry that named it (--replaces) finished done
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60000);
  const runs = new AgentRegistry(home);
  const helper = (sid: string, name: string, at: Date, replaces?: string) =>
    runs.start({
      sid,
      name,
      kind: 'helper',
      task: `${name}'s task`,
      repo: 'acme/widgets',
      at,
      ...(replaces ? { replaces } : {}),
    });
  const fail = (sid: string, name: string, at: Date) =>
    runs.finish(name, { sid, state: 'failed', outcome: `${name} failed`, at });
  const pass = (sid: string, name: string, at: Date) =>
    runs.finish(name, { sid, state: 'done', outcome: `${name} done`, at });
  // a: a deploy failed, then the retry that named it did the job: only the retry is on the board
  helper('99999991', 'deploy-a', minutesAgo(25));
  fail('99999991', 'deploy-a', minutesAgo(20));
  helper('99999991', 'deploy2-a', minutesAgo(15), 'deploy-a');
  pass('99999991', 'deploy2-a', minutesAgo(10));
  // b: a deploy failed and nothing replaced it: it stays in Waiting
  helper('99999992', 'deploy-b', minutesAgo(25));
  fail('99999992', 'deploy-b', minutesAgo(20));
  // c: an unrelated helper of the same session that finished done later (it named nothing), or one that started before the
  // failure and finished before it, does not replace it
  helper('99999993', 'deploy-c', minutesAgo(25));
  helper('99999993', 'lookup-c', minutesAgo(24));
  pass('99999993', 'lookup-c', minutesAgo(23));
  fail('99999993', 'deploy-c', minutesAgo(20));
  helper('99999993', 'lookup2-c', minutesAgo(15));
  pass('99999993', 'lookup2-c', minutesAgo(10));
  // d: a retry in another session, or one that names another run, does not replace it
  helper('99999994', 'deploy-d', minutesAgo(25));
  fail('99999994', 'deploy-d', minutesAgo(20));
  helper('99999995', 'deploy2-d', minutesAgo(15), 'deploy-d');
  pass('99999995', 'deploy2-d', minutesAgo(10));
  helper('99999996', 'deploy-e', minutesAgo(25));
  fail('99999996', 'deploy-e', minutesAgo(20));
  helper('99999996', 'deploy2-e', minutesAgo(15), 'deploy-other');
  pass('99999996', 'deploy2-e', minutesAgo(10));
  // e: a retry that failed too, or is still running, does not replace it
  helper('99999997', 'deploy-f', minutesAgo(25));
  fail('99999997', 'deploy-f', minutesAgo(20));
  helper('99999997', 'deploy2-f', minutesAgo(15), 'deploy-f');
  fail('99999997', 'deploy2-f', minutesAgo(10));
  helper('99999998', 'deploy-g', minutesAgo(25));
  fail('99999998', 'deploy-g', minutesAgo(20));
  helper('99999998', 'deploy2-g', minutesAgo(5), 'deploy-g');
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('9-failed-run-replaced', board);
}

// ---- 10. one piece of work, one card: work first, then `backlog add --branch` adopts the implicit card (no second card beside it)
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const sid8 = 'dddddddd';
  const runs = new AgentRegistry(home);
  const start = (
    name: string,
    card: string,
    kind: 'author' | 'critic' | 'helper' | 'research' | 'storyteller',
    at: Date,
    extra = {},
  ) => runs.start({ sid: sid8, name, kind, task: `${name}'s task`, card, at, ...extra });
  // a: an ad-hoc author that built on branch dup-a (an implicit card), and its critic; `backlog add --branch dup-a` then adopted
  // the implicit card with the add's title and note (an add under the implicit id, started on the branch, with an old claim
  // row for the author, which the fold still reads), so it is one card
  start('ou-dup', 'ic_ddddd01', 'author', et(14, 20), { repo: 'acme/widgets', branch: 'dup-a' });
  runs.finish('ou-dup', {
    sid: sid8,
    result: { commit: 'abc1234', branch: 'dup-a' },
    outcome: 'built it',
    at: et(14, 40),
  });
  start('review-dup', 'ic_ddddd01', 'critic', et(14, 45), {
    repo: 'acme/widgets',
    branch: 'dup-a',
  });
  // b: a card on another branch, one an old claim row names (nothing works it: it is Backlog), and one a run names: each is its own card, not part of a
  const item = (id: string, title: string, branch: string | null, at = et(13, 0)) => ({
    op: 'add',
    id,
    title,
    note: `${title}: the note`,
    repo: 'acme/widgets',
    branch,
    by: 'cli',
    at: at.toISOString(),
  });
  start('ou-named', 'bl_ddddd04', 'author', et(14, 10), {
    repo: 'acme/widgets',
    branch: 'dup-named',
  });
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    [
      item('ic_ddddd01', 'Backlog card for dup-a', 'dup-a', et(14, 30)),
      {
        op: 'start',
        id: 'ic_ddddd01',
        branch: 'dup-a',
        repo: 'acme/widgets',
        by: 'ou-dup',
        at: et(14, 30).toISOString(),
      },
      {
        op: 'claim',
        id: 'ic_ddddd01',
        agent: 'ou-dup',
        sid: sid8,
        by: 'ou-dup',
        at: et(14, 30).toISOString(),
      },
      item('bl_ddddd02', 'Another branch', 'dup-other'),
      item('bl_ddddd03', 'Claimed on dup-a', 'dup-a'),
      {
        op: 'claim',
        id: 'bl_ddddd03',
        agent: 'ou-claimer',
        sid: 'cccccccc',
        by: 'ou-claimer',
        at: et(13, 2).toISOString(),
      },
      item('bl_ddddd04', 'Named by a run', 'dup-named'),
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('10-duplicate-cards', board);
}

// ---- 11. a session that registered its own runs (`agent start --self`, named self-XXXXXX): a finished session does not hold its
// landed card, a busy one with no run open is Thinking beside a Ready card instead of making it Working, a self run of a
// session that is gone is shown stopped (its card is back in Backlog, tried), and a self research run is titled by its session
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const [doneOne, twin, thinker, researcher] = Array.from({ length: 4 }, () => liveChild());
  const approved = (head: string) => ({
    at: '2026-10-26T15:00:00Z',
    head_oid: head,
    base_oid: null,
  });
  const events: Record<string, unknown>[] = [];
  const card = (id: string, branch: string, title: string) =>
    events.push(
      {
        op: 'add',
        id,
        title,
        note: null,
        repo: 'acme/widgets',
        branch,
        by: 'cli',
        at: et(9, 0).toISOString(),
      },
      {
        op: 'start',
        id,
        branch,
        repo: 'acme/widgets',
        by: 'cli',
        at: et(9, 1).toISOString(),
      },
    );
  const land = (id: string, hoursAgo: number) =>
    events.push({
      op: 'done',
      id,
      sha: 'c'.repeat(40),
      by: 'cli',
      at: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(),
    });
  const runs = new AgentRegistry(home);
  const author = (sid: string, name: string, cardId: string, branch: string, finish: boolean) => {
    runs.start({ sid, name, kind: 'author', task: `build ${cardId}`, card: cardId, at: et(9, 5) });
    if (finish) {
      runs.finish(name, { sid, result: { branch, commit: 'abc1234' }, at: et(9, 40) });
    }
  };
  // a: landed 2 hours ago, its self run finished, and its session (registered, idle) is still on the branch: the card is gone,
  // the session is a card of its own. b: the same with a session that never registered: it still holds the card
  const checkoutA = checkoutOf('widgets', 'feat/self-landed');
  const checkoutB = checkoutOf('widgets', 'feat/plain-landed');
  localStory(
    home,
    'story-a',
    checkoutA,
    'feat/self-landed',
    { head_oid: 'a'.repeat(40) },
    {
      'review.json': { approval: approved('a'.repeat(40)) },
    },
  );
  localStory(
    home,
    'story-b',
    checkoutB,
    'feat/plain-landed',
    { head_oid: 'b'.repeat(40) },
    {
      'review.json': { approval: approved('b'.repeat(40)) },
    },
  );
  card('bl_selfruna', 'feat/self-landed', 'Landed by a self run');
  card('bl_selfrunb', 'feat/plain-landed', 'Landed, plain session');
  land('bl_selfruna', 2);
  land('bl_selfrunb', 2);
  registry(sessions, doneOne, { cwd: checkoutA, name: 'done-one' });
  registry(sessions, twin, { cwd: checkoutB, name: 'twin-one' });
  author(sid(doneOne), 'self-aaaaa1', 'bl_selfruna', 'feat/self-landed', true);
  author('dddddddd', 'ou-plain', 'bl_selfrunb', 'feat/plain-landed', true);
  // c: built by a self run (Ready for your review), and a busy registered session with no run open on its branch: Thinking
  // on its own card, the built card stays Ready
  const checkoutC = checkoutOf('widgets', 'feat/self-ready');
  localStory(home, 'story-c', checkoutC, 'feat/self-ready', { head_oid: 'd'.repeat(40) });
  card('bl_selfrunc', 'feat/self-ready', 'Built by a self run');
  registry(sessions, thinker, { cwd: checkoutC, name: 'thinker', status: 'busy' });
  author(sid(thinker), 'self-ccccc1', 'bl_selfrunc', 'feat/self-ready', true);
  // d: a self author of a session that is gone: stopped, its card back in Backlog, tried
  card('bl_selfrund', 'feat/self-gone', 'Its session closed');
  author('eeeeeeee', 'self-ddddd1', 'bl_selfrund', 'feat/self-gone', false);
  // e: a self research run of a busy session: the run's card is titled by the session, not self-eeeee1
  registry(
    sessions,
    researcher,
    { cwd: checkoutOf('widgets', 'main'), name: 'looker', status: 'busy' },
    { titled: 'Reading the retry code' },
  );
  runs.start({
    sid: sid(researcher),
    name: 'self-eeeee1',
    kind: 'research',
    task: 'how retries work',
    at: et(14, 30),
  });
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('11-self-runs', board);
}

// ---- 12. a failed run acknowledged (`agent ack`): its own card is gone, a backlog card's run is no line and no longer holds the
// card in Waiting (the card's tried chip reads stopped), and a failed run nobody acked stays as it was
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60000);
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const runs = new AgentRegistry(home);
  const events: Record<string, unknown>[] = [];
  const card = (id: string, branch: string, title: string) =>
    events.push(
      {
        op: 'add',
        id,
        title,
        note: null,
        repo: 'acme/widgets',
        branch,
        by: 'cli',
        at: et(9, 0).toISOString(),
      },
      { op: 'start', id, branch, repo: 'acme/widgets', by: 'cli', at: et(9, 1).toISOString() },
    );
  // a: a failed helper on its own card, acknowledged: no card. b: the same, nobody acked it: Waiting
  for (const [sid, name, acked] of [
    ['aaaaaaa1', 'deploy-acked', true],
    ['aaaaaaa2', 'deploy-open', false],
  ] as const) {
    runs.start({
      sid,
      name,
      kind: 'helper',
      task: `${name}'s task`,
      repo: 'acme/widgets',
      at: minutesAgo(25),
    });
    runs.finish(name, { sid, state: 'failed', outcome: `${name} failed`, at: minutesAgo(20) });
    if (acked) {
      runs.ack(name, { sid, at: minutesAgo(10) });
    }
  }
  // c: a backlog card whose author failed and was acked, d: the same, not acked (the card stays in Waiting)
  for (const [id, branch, name, acked] of [
    ['bl_ackedrun', 'feat/acked', 'ou-acked', true],
    ['bl_openrun', 'feat/open', 'ou-open', false],
  ] as const) {
    card(id, branch, `Card of ${name}`);
    runs.start({
      sid: 'bbbbbbb1',
      name,
      kind: 'author',
      task: `build ${id}`,
      card: id,
      at: minutesAgo(25),
    });
    runs.finish(name, { sid: 'bbbbbbb1', state: 'failed', outcome: 'broke', at: minutesAgo(20) });
    if (acked) {
      runs.ack(name, { sid: 'bbbbbbb1', at: minutesAgo(10) });
    }
  }
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('12-failed-run-acked', board);
}

// ---- 15. a Ready card whose branch moved past its story goes back to Working: a story told at X with the branch tip a later commit
// (a), the same tip (b), a rebase of X onto a moved main with every patch unchanged (c) and an amend of X (f); a finished author's
// commit C with a later commit D on its branch (d), and the same with another run's finished work at D, which carries the tip (e).
// No run is open on any of them. The real git answers (movedPast, awaited as the scan is), so the patch-id compare is exercised.
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const at = '2026-10-26T18:00:00Z';
  const parent = tmp('moved-repo');
  const checkout = path.join(parent, 'widgets');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  writeFileSync(path.join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', '.');
  gitAt(checkout, at, 'commit', '-q', '-m', 'base');
  const trees = path.join(parent, 'widgets-worktrees');
  mkdirSync(trees);
  const tipOf = (dir: string) => git(dir, 'rev-parse', 'HEAD');
  const commitIn = (dir: string, file: string, message: string) => {
    writeFileSync(path.join(dir, file), `${message}\n`);
    git(dir, 'add', '.');
    gitAt(dir, at, 'commit', '-q', '-m', message);
    return tipOf(dir);
  };
  const branch = (name: string) => {
    const dir = path.join(trees, name);
    git(checkout, 'worktree', 'add', '-q', dir, '-b', name);
    return dir;
  };
  const heads: Record<string, string> = {};
  // each branch has its own commit X, which its story is told over
  const dirs: Record<string, string> = {};
  for (const name of ['feat-a', 'feat-b', 'feat-c', 'feat-d', 'feat-e', 'feat-f']) {
    dirs[name] = branch(name);
    heads[name] = commitIn(dirs[name], `${name}.txt`, `work ${name}`);
  }
  // main moves on, so c is rebased onto a moved base
  commitIn(checkout, 'b.txt', 'main moves');
  // a: a later commit; c: the same commit rebased; f: the commit amended with another change
  const tips: Record<string, string> = {};
  tips['feat-a'] = commitIn(dirs['feat-a'], 'more.txt', 'second commit');
  tips['feat-b'] = heads['feat-b'];
  git(dirs['feat-c'], 'rebase', '-q', 'main');
  tips['feat-c'] = tipOf(dirs['feat-c']);
  writeFileSync(path.join(dirs['feat-f'], 'extra.txt'), 'extra\n');
  git(dirs['feat-f'], 'add', '.');
  gitAt(dirs['feat-f'], at, 'commit', '-q', '--amend', '-m', 'work feat-f amended');
  tips['feat-f'] = tipOf(dirs['feat-f']);
  // d and e: an author finished at C (their heads), then a later commit D
  tips['feat-d'] = commitIn(dirs['feat-d'], 'later.txt', 'by hand');
  tips['feat-e'] = commitIn(dirs['feat-e'], 'later.txt', 'by another run');
  shasSeen.push(...Object.values(heads), ...Object.values(tips));
  seenCheckout(home, 'acme/widgets', checkout);
  for (const name of ['feat-a', 'feat-b', 'feat-c', 'feat-f']) {
    localStory(home, `story-${name}`, checkout, name, {
      head_oid: tips[name],
      told_head_oid: heads[name],
      told_base_oid: null,
    });
  }
  const authors = new AgentRegistry(home);
  const author = (name: string, branch: string, commit: string, hour: number) => {
    authors.start({
      sid: 'dddddddd',
      name,
      kind: 'author',
      task: `build ${name}`,
      repo: 'acme/widgets',
      branch,
      cwd: dirs[branch],
      model: 'sonnet',
      effort: 'low',
      at: et(hour, 0),
    });
    authors.finish(name, {
      outcome: 'built',
      result: { commit, branch },
      at: et(hour, 30),
    });
  };
  author('moved-by-hand', 'feat-d', heads['feat-d'], 10);
  author('moved-first', 'feat-e', heads['feat-e'], 11);
  author('moved-second', 'feat-e', tips['feat-e'], 12);
  // f's amend is a recorded fix (`once-upon fixed --sha`): its story is not retold yet, but the move is covered by a run
  author('fixed-f', 'feat-f', tips['feat-f'], 13);
  const none = Object.fromEntries(
    ['feat-a', 'feat-b', 'feat-c', 'feat-d', 'feat-e', 'feat-f'].map((name) => [
      `acme/widgets@${name}`,
      null,
    ]),
  );
  const { watcher } = fakeWatcher([], none);
  const looks: Promise<unknown>[] = [];
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
    movedPast: (...args: Parameters<typeof branchMovedPastAsync>) => {
      const look = branchMovedPastAsync(...args);
      looks.push(look);
      return look;
    },
  });
  await board.snapshot();
  await (board as any).scanner.idle();
  (board as any).invalidate();
  // the first build with the scan asks git, a few looks at a time; each next build asks the rest, and the answers are in the one after
  for (let round = 0; round < 3; round++) {
    await board.snapshot();
    await Promise.all(looks);
    (board as any).invalidate();
  }
  await record('15-ready-moved', board);
}

// ---- 16. a session that dispatches agents (furnace-f3 on main): its card is Working while an agent it launched runs, wherever that agent
// sits (here a running author held by a backlog card), never Research; and the subagents nobody registered are light rows on it: one
// running, one done, one killed (no finished mark, quiet 40 minutes), while two Claude subagents that ARE registered runs (one by its
// description's name, one by its description against the run's task) are not shown twice
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const furnace = liveChild();
  const furnaceCwd = checkoutOf('widgets', 'main');
  registry(sessions, furnace, { cwd: furnaceCwd, name: 'furnace-f3' });
  const events = [
    {
      op: 'add',
      id: 'bl_dispatch1',
      title: 'Dispatched feature',
      note: null,
      repo: 'acme/widgets',
      branch: 'feat/dispatched',
      by: 'cli',
      at: et(9, 0).toISOString(),
    },
    {
      op: 'start',
      id: 'bl_dispatch1',
      branch: 'feat/dispatched',
      repo: 'acme/widgets',
      by: 'cli',
      at: et(9, 1).toISOString(),
    },
  ];
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const runs = new AgentRegistry(home);
  runs.start({
    sid: sid(furnace),
    name: 'ou-held',
    kind: 'author',
    task: 'Build the dispatched feature from the plan file',
    card: 'bl_dispatch1',
    at: et(14, 40),
  });
  runs.start({
    sid: sid(furnace),
    name: 'lookup-done',
    kind: 'helper',
    task: 'look something up',
    at: et(14, 30),
  });
  runs.finish('lookup-done', { sid: sid(furnace), outcome: 'found it', at: et(14, 45) });
  // Claude's subagent transcripts for the session, each last written some minutes before NOW
  // (the worlds' projects folder, beside the session's own transcript: CLAUDE_CONFIG_DIR is the world's)
  const folder = path.join(
    process.env.CLAUDE_CONFIG_DIR as string,
    'projects',
    furnaceCwd.replace(/[^A-Za-z0-9]/g, '-'),
    fullId(furnace.pid),
    'subagents',
  );
  mkdirSync(folder, { recursive: true });
  const subagent = (id: string, meta: Record<string, unknown>, minutesAgo: number) => {
    writeFileSync(path.join(folder, `agent-${id}.jsonl`), '{"type":"user"}\n');
    writeFileSync(path.join(folder, `agent-${id}.meta.json`), JSON.stringify(meta));
    const when = new Date(NOW.getTime() - minutesAgo * 60000);
    utimesSync(path.join(folder, `agent-${id}.jsonl`), when, when);
  };
  subagent('running1', { agentType: 'Explore', description: 'look up the retry docs' }, 1);
  subagent(
    'done1',
    { agentType: 'general-purpose', description: 'fetch the release notes', finished: true },
    10,
  );
  subagent('killed1', { agentType: 'general-purpose', description: 'read the old config' }, 40);
  subagent('reg-name', { description: 'lookup-done: look something up', finished: true }, 15);
  subagent('reg-task', { description: 'Build the dispatched feature from the plan' }, 2);
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('16-dispatching-session', board);
  // a transcript's creation time is the machine's, not the fixture's: a golden keeps the rows, not that clock
  for (const lane of (results['16-dispatching-session'] as { board: BoardLike }).board.lanes) {
    for (const card of lane.cards) {
      for (const row of card.subagents?.rows ?? []) {
        row.started_at = '<created>';
      }
    }
  }
}

// ---- 17. a parked card (reopened with `backlog reopen`, on hold, or set aside for someday) ignores a local story told before the
// mark: it is in Backlog, not Ready; a story told after the mark counts as usual (Ready). Every story is unreviewed with no PR.
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const events: Record<string, unknown>[] = [];
  const add = (id: string, branch: string | null) =>
    events.push({
      op: 'add',
      id,
      title: `Card ${id}`,
      note: null,
      repo: 'acme/widgets',
      ...(branch ? { branch } : {}),
      by: 'cli',
      at: et(8, 0).toISOString(),
    });
  // the marks are all at 11:00 ET (15:00Z); the old stories were told at 13:00Z, the new one at 17:00Z
  const reopen = (id: string, branch: string) =>
    events.push(
      { op: 'start', id, branch, repo: 'acme/widgets', by: 'cli', at: et(8, 1).toISOString() },
      { op: 'drop', id, by: 'cli', at: et(10, 0).toISOString() },
      { op: 'reopen', id, by: 'cli', at: et(11, 0).toISOString() },
    );
  // a reopened card added with a branch, with an old story (Backlog) and with a new one (Ready)
  add('bl_reopenold', 'feat/reopen-old');
  reopen('bl_reopenold', 'feat/reopen-old');
  add('bl_reopennew', 'feat/reopen-new');
  reopen('bl_reopennew', 'feat/reopen-new');
  // a reopened card added with no branch (a start gave it one, and the reopen forgot it): its run names the branch
  add('bl_reopenbare', null);
  reopen('bl_reopenbare', 'feat/reopen-bare');
  const runs = new AgentRegistry(home);
  runs.start({
    sid: 'ffffffff',
    name: 'au-reopen-bare',
    kind: 'author',
    task: 'the dropped work',
    card: 'bl_reopenbare',
    repo: 'acme/widgets',
    branch: 'feat/reopen-bare',
    at: et(8, 2),
  });
  runs.finish('au-reopen-bare', {
    sid: 'ffffffff',
    state: 'stopped',
    outcome: 'dropped with the card',
    at: et(9, 0),
  });
  // a card on hold, and one set aside for someday, whose branch holds an older story
  add('bl_heldold', 'feat/held-old');
  events.push({ op: 'hold', id: 'bl_heldold', on: true, by: 'cli', at: et(11, 0).toISOString() });
  add('bl_somedayold', 'feat/someday-old');
  events.push({
    op: 'someday',
    id: 'bl_somedayold',
    on: true,
    by: 'cli',
    at: et(11, 0).toISOString(),
  });
  for (const [id, branch, built] of [
    ['story-reopen-old', 'feat/reopen-old', '2026-10-26T13:00:00Z'],
    ['story-reopen-new', 'feat/reopen-new', '2026-10-26T17:00:00Z'],
    ['story-reopen-bare', 'feat/reopen-bare', '2026-10-26T13:00:00Z'],
    ['story-held-old', 'feat/held-old', '2026-10-26T13:00:00Z'],
    ['story-someday-old', 'feat/someday-old', '2026-10-26T13:00:00Z'],
  ] as const) {
    localStory(home, id, checkoutOf('widgets', branch), branch, { built_at: built });
  }
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('17-reopened-old-story', board);
}

// ---- 18. a parked card (reopened, on hold) whose runs finished before the mark is in Backlog, even with an unreviewed story and a failed
// or done run behind it; a run opened after the mark takes it out of Backlog.
{
  const home = tmp('home');
  const sessions = tmp('sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const events: Record<string, unknown>[] = [];
  const add = (id: string, branch: string, started = true) => {
    events.push({
      op: 'add',
      id,
      title: `Card ${id}`,
      note: null,
      repo: 'acme/widgets',
      branch,
      by: 'cli',
      at: et(8, 0).toISOString(),
    });
    if (started) {
      events.push({
        op: 'start',
        id,
        branch,
        repo: 'acme/widgets',
        by: 'cli',
        at: et(8, 1).toISOString(),
      });
    }
  };
  const reopen = (id: string) =>
    events.push(
      { op: 'drop', id, by: 'cli', at: et(10, 0).toISOString() },
      { op: 'reopen', id, by: 'cli', at: et(11, 0).toISOString() },
    );
  const runs = new AgentRegistry(home);
  const authorRun = (name: string, id: string, branch: string, startedAt: Date) =>
    runs.start({
      sid: 'ffffffff',
      name,
      kind: 'author',
      task: 'the work',
      card: id,
      repo: 'acme/widgets',
      branch,
      at: startedAt,
    });
  // the marks are all at 11:00 ET; the runs below ended at 9:00 ET and the stories were told at 13:00Z (9:00 ET)
  add('bl_parkdone', 'feat/park-done');
  authorRun('au-park-done', 'bl_parkdone', 'feat/park-done', et(8, 2));
  runs.finish('au-park-done', { sid: 'ffffffff', state: 'done', outcome: 'built', at: et(9, 0) });
  reopen('bl_parkdone');
  add('bl_parkfailed', 'feat/park-failed');
  authorRun('au-park-failed', 'bl_parkfailed', 'feat/park-failed', et(8, 2));
  runs.finish('au-park-failed', {
    sid: 'ffffffff',
    state: 'failed',
    outcome: 'broke',
    at: et(9, 0),
  });
  reopen('bl_parkfailed');
  // a hold on an open card whose run finished (a started one rides its branch's work card, whatever it is held for)
  add('bl_parkheld', 'feat/park-held', false);
  authorRun('au-park-held', 'bl_parkheld', 'feat/park-held', et(8, 2));
  runs.finish('au-park-held', { sid: 'ffffffff', state: 'done', outcome: 'built', at: et(9, 0) });
  events.push({ op: 'hold', id: 'bl_parkheld', on: true, by: 'cli', at: et(11, 0).toISOString() });
  // a reopened card with a new run after the mark: it leaves Backlog
  add('bl_parknew', 'feat/park-new');
  authorRun('au-park-new-1', 'bl_parknew', 'feat/park-new', et(8, 2));
  runs.finish('au-park-new-1', { sid: 'ffffffff', state: 'done', outcome: 'built', at: et(9, 0) });
  reopen('bl_parknew');
  authorRun('au-park-new-2', 'bl_parknew', 'feat/park-new', et(12, 0));
  for (const [id, branch] of [
    ['story-park-done', 'feat/park-done'],
    ['story-park-held', 'feat/park-held'],
    ['story-park-new', 'feat/park-new'],
  ] as const) {
    localStory(home, id, checkoutOf('widgets', branch), branch, {
      built_at: '2026-10-26T13:00:00Z',
    });
  }
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const { watcher } = fakeWatcher([], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf,
  });
  await record('18-parked-after-run', board);
}

/**
 * Pids become stable tokens, matched as whole numbers so one can never hit the inside of a sha, another number or a date
 * (a pid of 2026 must leave `2026-10-26T...` alone: a bare pid is never glued to a digit by a dash).
 */
export function scrubPids(text: string, all: number[]): string {
  let out = text;
  for (const pid of all) {
    const token = all.indexOf(pid);
    const padded = new RegExp(
      `(?<![0-9A-Za-z])${String(pid).padStart(8, '0')}(?![0-9A-Za-z])`,
      'g',
    );
    const bare = new RegExp(`(?<![0-9A-Za-z.]|\\d-)${pid}(?![0-9A-Za-z]|-\\d)`, 'g');
    out = out.replace(padded, `<PID:${token}>`).replace(bare, `<pid:${token}>`);
  }
  return out;
}

// ---- 19-22. the board reads stored cards (ADR-29, branch C3): a session's, a PR's and a story's card are read, not guessed
{
  const et = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
  const world = (rows: Record<string, unknown>[]) => {
    const home = tmp('home');
    const sessions = tmp('sessions');
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
    writeFileSync(
      path.join(home, 'backlog.jsonl'),
      rows
        .map((row) => JSON.stringify({ by: 'cli', at: et(8, 0).toISOString(), ...row }))
        .join('\n') + '\n',
    );
    return { home, sessions };
  };
  const boardOf = (home: string, watcher: unknown) =>
    new Board(home, new StoryStore({ home }), watcher as never, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
      repoOf,
    });

  // 19. a stored session card with a branch and no run is not Ready: its live session is a card, idle; a stored card nothing is on
  // (no run, PR, story or session) shows nothing
  {
    const child = liveChild();
    const cwd = checkoutOf('widgets', 'feat/sess');
    const { home, sessions } = world([
      {
        op: 'add',
        id: 'bl_sesscard001',
        title: 'a session card',
        repo: 'acme/widgets',
        branch: 'feat/sess',
        source: 'session',
        session: fullId(child.pid),
      },
      {
        op: 'add',
        id: 'bl_idlecard0001',
        title: 'nothing on it',
        repo: 'acme/widgets',
        branch: 'feat/idle',
        source: 'agent',
      },
    ]);
    registry(sessions, child, { cwd, name: 'session-card' });
    await record('19-stored-session-card', boardOf(home, fakeWatcher([], {}).watcher));
  }

  // 20. a PR whose head was renamed keeps its card: the started card names the PR by number, GitHub says the head is a new branch
  {
    const { home } = world([
      {
        op: 'add',
        id: 'bl_renamed0001',
        title: 'Renamed head',
        repo: 'acme/widgets',
        branch: 'feat/old-name',
      },
      { op: 'start', id: 'bl_renamed0001', repo: 'acme/widgets', branch: 'feat/old-name' },
      { op: 'link', id: 'bl_renamed0001', pr: 12 },
    ]);
    const info = prInfo(12, { title: 'Renamed PR', branch: 'feat/new-name' });
    await record('20-renamed-pr-head', boardOf(home, fakeWatcher([info], {}).watcher));
  }

  // 21. a PR GitHub waits on your review for, with no stored card, still shows
  {
    const { home } = world([
      { op: 'add', id: 'bl_unrelated001', title: 'unrelated', source: 'agent' },
    ]);
    const info = prInfo(21, { mine: false, review_requested: true, author: 'someone' });
    await record(
      '21-requested-pr-no-card',
      boardOf(home, fakeWatcher([info], {}, [{ repo: 'acme/widgets', number: 21 }]).watcher),
    );
  }

  // 22. a stored PR card for a PR GitHub reports merged leaves after the Done hour: one merged 20 minutes ago shows, one 3 hours ago does not
  {
    const { home } = world(
      [
        [22, 'feat/merged-old'],
        [23, 'feat/merged-new'],
      ].flatMap(([number, branch]) => [
        {
          op: 'add',
          id: `bl_storedpr${number}`,
          title: `stored PR ${number}`,
          repo: 'acme/widgets',
          branch,
          source: 'pr',
          pr: number,
        },
      ]),
    );
    const infos = [
      prInfo(22, {
        state: 'merged',
        merged_at: new Date(NOW.getTime() - 3 * 3600000).toISOString(),
      }),
      prInfo(23, {
        state: 'merged',
        merged_at: new Date(NOW.getTime() - 20 * 60000).toISOString(),
      }),
    ];
    await record('22-stored-pr-merged', boardOf(home, fakeWatcher(infos, {}).watcher));
  }

  // 23. a stored PR card that landed (ADR-29, branch D1): its `landed_at` is when it merged, and it is a merged work for the hour
  // after, with GitHub's lists and merged.json knowing nothing of it; one that landed 3 hours ago is no card
  {
    const { home } = world(
      [
        [24, 'feat/landed-new', et(14, 40)],
        [25, 'feat/landed-old', et(11, 0)],
      ].flatMap(([number, branch, at]) => [
        {
          op: 'add',
          id: `bl_storedland${number}`,
          title: `landed PR ${number}`,
          repo: 'acme/widgets',
          branch,
          source: 'pr',
          pr: number,
        },
        { op: 'done', id: `bl_storedland${number}`, merged_at: (at as Date).toISOString() },
      ]),
    );
    await record('23-stored-pr-landed', boardOf(home, fakeWatcher([], {}).watcher));
  }

  // 24. a session whose run names a card whose PR head was renamed (ADR-29, key by card id): the card's stored branch is the old
  // name, GitHub says the head is a new one, and the session still sits on the PR's work, joined by the card's id
  {
    const child = liveChild();
    const cwd = checkoutOf('widgets', 'main');
    const { home, sessions } = world([
      {
        op: 'add',
        id: 'bl_renamedsess1',
        title: 'Renamed head',
        repo: 'acme/widgets',
        branch: 'feat/old-name',
      },
      { op: 'start', id: 'bl_renamedsess1', repo: 'acme/widgets', branch: 'feat/old-name' },
      { op: 'link', id: 'bl_renamedsess1', pr: 12 },
    ]);
    registry(sessions, child, { cwd, name: 'renamed-session', status: 'busy' });
    new AgentRegistry(home).start({
      sid: sid(child),
      name: 'ou-renamed',
      kind: 'author',
      task: 'work on the renamed PR',
      card: 'bl_renamedsess1',
      at: et(14, 40),
    });
    const info = prInfo(12, { title: 'Renamed PR', branch: 'feat/new-name' });
    await record('24-renamed-head-session', boardOf(home, fakeWatcher([info], {}).watcher));
  }

  // 25. your own open PR whose branch has commits not pushed (the board asks each checkout, `aheadOf`) goes back to the Mac's side,
  // on its local story: a (1 ahead, story not reviewed) and d (1 ahead, story reviewed, approved at an older head: the armada
  // case: its PR story and its retold local story) are Ready; b (1 ahead, story approved for the head) is Ready to ship; f (1 ahead, a PR story and a local
  // one) shows the local story; c (pushed, 0 ahead) stays on the PR side; e is someone else's PR, which stays where it was
  {
    const approvedAt = '2026-10-26T15:00:00Z';
    const { home } = world([]);
    const counts: Record<string, number> = {
      'feat/ahead-a': 1,
      'feat/ahead-b': 1,
      'feat/ahead-c': 0,
      'feat/ahead-d': 1,
      'feat/ahead-e': 1,
      'feat/ahead-f': 1,
    };
    const [a, b, c, d, e, f] = Object.keys(counts);
    localStory(home, 'story-ahead-a', checkoutOf('widgets', a), a);
    localStory(
      home,
      'story-ahead-b',
      checkoutOf('widgets', b),
      b,
      { head_oid: 'b'.repeat(40) },
      { 'review.json': { approval: { at: approvedAt, head_oid: 'b'.repeat(40), base_oid: null } } },
    );
    localStory(home, 'story-ahead-c', checkoutOf('widgets', c), c);
    // d: approved at an older head (the tip is another commit), then amended; the retold story was reviewed by hand, not approved
    localStory(
      home,
      'story-ahead-d',
      checkoutOf('widgets', d, true),
      d,
      { head_oid: 'd'.repeat(40) },
      {
        'review.json': {
          mark: { at: '2026-10-26T14:00:00Z', by: 'manual' },
          approval: { at: approvedAt, head_oid: 'a'.repeat(40), base_oid: null },
        },
      },
    );
    prStory(home, 'acme-widgets-34', 'acme/widgets', 34, d);
    localStory(home, 'story-ahead-e', checkoutOf('widgets', e), e);
    prStory(home, 'acme-widgets-36', 'acme/widgets', 36, f);
    localStory(home, 'story-ahead-f', checkoutOf('widgets', f), f);
    const infos = [a, b, c, d, e, f].map((branch, index) =>
      prInfo(31 + index, { branch, mine: branch !== e }),
    );
    const board = new Board(
      home,
      new StoryStore({ home }),
      fakeWatcher(
        infos,
        Object.fromEntries(infos.map((info) => [`acme/widgets@${info.branch}`, info])),
      ).watcher as never,
      new Builds(home),
      {
        source: sourceSaying({}),
        now: () => NOW,
        repoOf,
        aheadOf: async (_checkout: string, branch: string) => counts[branch],
      },
    );
    // the first build has no ahead answer (it is looked up in the background); the answers are in by the next
    await board.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    (board as any).invalidate();
    await record('25-pr-ahead-local', board);
  }

  // 26. your own open PR whose branch has commits not pushed, with no local story of the branch (the 11/19 case: an author committed
  // after the push and ran `agent start --branch`): the worktree's unpushed count puts it on the Mac's side. a (an author's
  // finished commit, scanner says 1 unpushed, origin not asked yet) is Ready; c (pushed: its tracking ref is the tip) stays pr_open;
  // d (the scanner says 1 unpushed, but origin says 0: pushed from another clone) is pr_open once origin answers; e (origin
  // answers that it has a tip this checkout lacks: rebased or force-pushed elsewhere) is pr_open too, not the scanner's count
  {
    const names = ['feat-r2-a', 'feat-r2-c', 'feat-r2-d', 'feat-r2-e'];
    const { home } = world(
      names.map((branch, index) => ({
        op: 'add',
        id: `bl_storedpr${41 + index}`,
        title: `stored PR ${41 + index}`,
        repo: 'acme/widgets',
        branch,
        source: 'pr',
        pr: 41 + index,
      })),
    );
    const at = '2026-10-26T18:00:00Z';
    const parent = tmp('ahead-repo');
    const checkout = path.join(parent, 'widgets');
    mkdirSync(checkout);
    git(checkout, 'init', '-q', '-b', 'main');
    git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    writeFileSync(path.join(checkout, 'a.txt'), 'a\n');
    git(checkout, 'add', '.');
    gitAt(checkout, at, 'commit', '-q', '-m', 'base');
    // main is the remote's: only the branches' own commits count as unpushed
    git(checkout, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const trees = path.join(parent, 'widgets-worktrees');
    mkdirSync(trees);
    const tips: Record<string, string> = {};
    const authors = new AgentRegistry(home);
    for (const [index, name] of names.entries()) {
      const dir = path.join(trees, name);
      git(checkout, 'worktree', 'add', '-q', dir, '-b', name);
      writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
      git(dir, 'add', '.');
      gitAt(dir, at, 'commit', '-q', '-m', `work ${name}`);
      tips[name] = git(dir, 'rev-parse', 'HEAD');
      authors.start({
        sid: 'dddddddd',
        name: `round-two-${name}`,
        kind: 'author',
        task: `build ${name}`,
        repo: 'acme/widgets',
        branch: name,
        card: `bl_storedpr${41 + index}`,
        cwd: dir,
        model: 'sonnet',
        effort: 'low',
        at: et(10 + index, 0),
      });
      authors.finish(`round-two-${name}`, {
        outcome: 'built',
        result: { commit: tips[name], branch: name },
        at: et(10 + index, 30),
      });
    }
    git(checkout, 'update-ref', 'refs/remotes/origin/feat-r2-c', tips['feat-r2-c']);
    shasSeen.push(...Object.values(tips));
    seenCheckout(home, 'acme/widgets', checkout);
    const infos = names.map((branch, index) => prInfo(41 + index, { branch }));
    const board = new Board(
      home,
      new StoryStore({ home }),
      fakeWatcher(
        infos,
        Object.fromEntries(infos.map((info) => [`acme/widgets@${info.branch}`, info])),
      ).watcher as never,
      new Builds(home),
      {
        source: sourceSaying({}),
        now: () => NOW,
        repoOf,
        aheadOf: async (_checkout: string, branch: string) =>
          (({ 'feat-r2-d': 0, 'feat-r2-e': 'diverged' }) as const)[branch as 'feat-r2-d'] ?? null,
      },
    );
    await board.snapshot();
    await (board as any).scanner.idle();
    (board as any).invalidate();
    // the first build reads the scan; the origin look of d answers 0 in the background, and the next build has it
    await board.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    (board as any).invalidate();
    await record('26-pr-ahead-no-story', board);
  }
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
  text = scrubPids(text, [...new Set([...pidsSeen, ...children.map((child) => child.pid)])]);
  shasSeen.forEach((sha, token) => {
    text = text.split(sha).join(`<SHA:${token}>`).split(sha.slice(0, 7)).join(`<SHA:${token}>`);
  });
  // Disk usage depends on the filesystem's block size.
  text = text.replace(/"size_kb": \d+/g, '"size_kb": "<kb>"');
  snapshots[name] = text + '\n';
}

/**
 * The gate for ADR-29's branch A: cards a run or a writer stored (one of each source) change no board. For every world, the
 * board is built, then stored cards are appended to its backlog.jsonl (an `agent` card for each `ic_` id a run names, which is
 * what an `agent start` now writes, plus a `session`, a `pr` and a `story` card on a branch the world uses, one started, and an
 * orphan nothing names), and built again. The two builds are returned, by world name, for the test to compare.
 */
export async function storedCardsChangeNothing(): Promise<
  Record<string, { before: string; after: string }>
> {
  const out: Record<string, { before: string; after: string }> = {};
  const at = NOW.toISOString();
  for (const { name, board, home } of worldBoards) {
    const before = JSON.stringify(await board.rebuild());
    const agentsText = existsSync(path.join(home, 'agents.jsonl'))
      ? readFileSync(path.join(home, 'agents.jsonl'), 'utf8').split('\n')
      : [];
    const storedText = existsSync(path.join(home, 'backlog.jsonl'))
      ? readFileSync(path.join(home, 'backlog.jsonl'), 'utf8')
      : '';
    // the world already stores a card for each `ic_` id its runs name (record)
    const named = [
      ...new Set(agentsText.flatMap((line) => line.match(/ic_[a-z0-9]{6,24}/g) ?? [])),
    ].filter((id) => !storedText.includes(id));
    const rows = [
      ...named.map((id) => ({
        op: 'add',
        id,
        title: `stored ${id}`,
        repo: 'acme/widgets',
        source: 'agent',
      })),
      {
        op: 'add',
        id: 'bl_storedsess01',
        title: 'a session card',
        repo: 'acme/widgets',
        branch: 'feat/x',
        source: 'session',
        session: 'stored-session-1',
      },
      {
        op: 'add',
        id: 'bl_storedpr0001',
        title: 'a PR card',
        repo: 'acme/widgets',
        branch: 'feat/y',
        source: 'pr',
        pr: 7,
      },
      { op: 'start', id: 'bl_storedpr0001', branch: 'feat/y', repo: 'acme/widgets' },
      {
        op: 'add',
        id: 'bl_storedstory1',
        title: 'a story card',
        repo: 'acme/widgets',
        branch: 'feat/z',
        source: 'story',
        story: 'acme-widgets-8',
      },
      { op: 'link', id: 'bl_storedstory1', worktree: '/nowhere/stored', pr: 8 },
      { op: 'add', id: 'bl_storedorphan', title: 'an orphan', source: 'agent' },
    ].map((row) => ({ ...row, by: 'stored-card-gate', at }));
    appendFileSync(
      path.join(home, 'backlog.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    out[name] = { before, after: JSON.stringify(await board.rebuild()) };
  }
  return out;
}

/**
 * The gate for ADR-29's branch B: the card keeper changes no board. For every world, the board is built, a started backlog card is put
 * on a branch the world has a story on (its `worktree` unset, which the fold defaults from an old claim row), a keeper is attached, and the
 * board is built twice more. The three builds are returned by world name, with how many lines the keeper wrote; the second build of
 * the keeper writes nothing, so its count is the first's.
 */
export async function keeperChangesNothing(): Promise<
  Record<string, { before: string; first: string; second: string; wrote: number; again: number }>
> {
  const { CardKeeper } = await src('core', 'features/cards/card-keeper.ts');
  const out: Record<
    string,
    { before: string; first: string; second: string; wrote: number; again: number }
  > = {};
  const at = NOW.toISOString();
  const lines = (home: string) => {
    const file = path.join(home, 'backlog.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
  };
  for (const { name, board, home } of worldBoards) {
    const seed = [
      { op: 'add', id: 'bl_keepergate01', title: 'a started card', repo: 'acme/widgets' },
      { op: 'start', id: 'bl_keepergate01', branch: 'feat/z', repo: 'acme/widgets' },
    ].map((row) => ({ ...row, by: 'keeper-gate', at }));
    appendFileSync(
      path.join(home, 'backlog.jsonl'),
      seed.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    const before = JSON.stringify(await board.rebuild());
    const kept = lines(home);
    board.options.keeper = new CardKeeper(home, (line: string) => {
      throw new Error(`the keeper logged in ${name}: ${line}`);
    });
    const first = JSON.stringify(await board.rebuild());
    const wrote = lines(home) - kept;
    const second = JSON.stringify(await board.rebuild());
    out[name] = { before, first, second, wrote, again: lines(home) - kept - wrote };
    board.options.keeper = undefined;
  }
  return out;
}

export function finish() {
  children.forEach((child) => child.kill());
  rmSync(WORK, { recursive: true, force: true });
}
