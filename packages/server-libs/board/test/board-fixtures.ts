import '@once-upon-a-diff/test-kit/env';
import { spawn } from 'node:child_process';
import { type PrWatcher } from '../src/board.ts';
import { type CtlResult } from '@once-upon-a-diff/adapters/larmor';
import { type StatusSource } from '@once-upon-a-diff/adapters/status-source';
import { type BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import { type PrInfo } from '@once-upon-a-diff/contracts/types';
import { pause, procStartOf } from '@once-upon-a-diff/state/test/board-fixtures';

/** A source that says what it's told, keyed by session id prefix. */
export const sourceSaying = (
  says: Record<
    string,
    { status: 'waiting' | 'working' | 'done'; detail: string | null; tasks?: number | null }
  >,
): StatusSource => ({
  name: 'iterm',
  statuses: async (sessions) =>
    new Map(
      sessions.flatMap((session) => {
        const found = says[session.session.slice(0, 8)];
        return found
          ? [[session.session, { tasks: null, ...found, title: 'Tab title' }] as const]
          : [];
      }),
    ),
});

/** A PR as GitHub would say it, with what a test changes. */
export const prInfo = (number: number, extra: Partial<PrInfo> = {}): PrInfo => ({
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

/** A GitHub watcher that answers from what a test gives it, and records what the board asked. */
export function fakeWatcher(
  infos: PrInfo[] = [],
  branchPrs: Record<string, BranchPr | null> = {},
  requested: { repo: string; number: number }[] = [],
) {
  const asked = {
    branches: [] as string[],
    checkouts: [] as string[],
    infos: [] as number[],
    stories: [] as string[],
    locals: [] as string[],
  };
  const watcher: PrWatcher = {
    kick: (list) => asked.stories.push(...list.map((story) => story.id)),
    kickInfo: (_repo, number) => asked.infos.push(number),
    kickBranch: (repo, branch, checkout) => {
      asked.branches.push(`${repo}@${branch}`);
      asked.checkouts.push(checkout);
    },
    info: (_repo, number) => infos.find((info) => info.number === number) || null,
    // an answer a test gave counts as just in (never old); no answer is "never"
    infoAt: (_repo, number) => (infos.some((info) => info.number === number) ? Infinity : null),
    branchPr: (repo, branch) => branchPrs[`${repo}@${branch}`],
    branchAt: (repo, branch) => (`${repo}@${branch}` in branchPrs ? Infinity : null),
    kickLocal: (list) => asked.locals.push(...list.map((entry) => entry.story.id)),
    kickRequested: () => undefined,
    requested: () => requested,
  };
  return { watcher, asked };
}

/** voice_ctl's answer, for the functions that take it. */
export const ctl = (extra: Partial<CtlResult> = {}): CtlResult => ({
  ok: true,
  why: '',
  away: false,
  bridge: false,
  voiceOn: false,
  paused: false,
  sessionId: null,
  since: null,
  lastListen: null,
  lastSpeak: null,
  name: null,
  lastVoice: null,
  ...extra,
});

/** Waits, up to a deadline, until `read` gives a value that `done` accepts; returns the last value. */
export async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  seconds = 10,
) {
  const end = Date.now() + seconds * 1000;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await pause(100);
    value = await read();
  }
  return value;
}

/** A process that runs a child, as a Claude Code session runs a `once-upon wait`: the parent's pid and the child's. */
export function parentWithChild(): Promise<{
  parent: number;
  child: number;
  procStart: string;
  stop: () => void;
}> {
  const shell = spawn('sh', ['-c', 'sleep 60 & echo $!; wait']);
  return new Promise((resolve) => {
    shell.stdout.once('data', (chunk) => {
      resolve({
        parent: shell.pid as number,
        child: Number(String(chunk).trim()),
        procStart: procStartOf(shell.pid as number),
        stop: () => {
          shell.kill();
          try {
            process.kill(Number(String(chunk).trim()));
          } catch {
            /* gone already */
          }
        },
      });
    });
  });
}

/** A wall-clock time on 10/26 in ET (EDT, UTC-4), for the registry's `at`. */
export const etAt = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 9, 26, hour + 4, minute));
