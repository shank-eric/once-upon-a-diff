import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git } from '@once-upon-a-diff/test-kit/git';
import { CLAUDE_DIR } from '@once-upon-a-diff/test-kit/env';
import { setVoiceWaits } from '@once-upon-a-diff/adapters/larmor';
import { fakeLarmorIn } from '@once-upon-a-diff/test-kit/fake-larmor';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readReviewRecord } from '@once-upon-a-diff/stories/review-record';

export const NOW = new Date('2026-10-26T19:00:00Z');

/** The process's start time as the registry's procStart spells it (UTC, as `ps` says it). */
export const procStartOf = (pid: number) =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();

/** A transcript the way Claude Code writes it, in the projects folder the board looks in by default. */
export function transcript(cwd: string, sessionId: string, lines: unknown[]) {
  const file = path.join(
    CLAUDE_DIR,
    'projects',
    cwd.replace(/[^A-Za-z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

/** The lines of a session that has had a prompt, and of one that was just cleared. */
export const usedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'user', message: { role: 'user', content: 'fix the build' }, sessionId },
  { type: 'assistant', message: { role: 'assistant', content: [] }, sessionId },
];

export const clearedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'file-history-snapshot', messageId: 'a', snapshot: {}, isSnapshotUpdate: false },
  {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: '<local-command-caveat>Caveat: not for you</local-command-caveat>',
    },
    sessionId,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>',
    },
    sessionId,
  },
  {
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout></local-command-stdout>',
    sessionId,
  },
];

export let startedCount = 0;

/**
 * A registry file the way Claude Code writes it, and (unless `blank`) a transcript of a session that has had a prompt, so
 * the board shows it as a card; `blank` leaves the transcript as just the clear.
 */
export function registry(
  dir: string,
  pid: number,
  extra: Record<string, unknown> = {},
  procStart: string | null = null,
  { blank = false }: { blank?: boolean } = {},
) {
  const sessionId = `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
  const cwd = (extra.cwd as string) || '/tmp/somewhere/widgets';
  transcript(cwd, sessionId, blank ? clearedLines(sessionId) : usedLines(sessionId));
  writeJson(path.join(dir, `${pid}.json`), {
    pid,
    sessionId,
    cwd: '/tmp/somewhere/widgets',
    name: `session-${pid}`,
    status: 'idle',
    // the board lists sessions oldest first: each one started a second after the one registered before it, so the order is
    // the order they are registered in, whatever pids the machine handed out (a pid that wrapped round is smaller)
    startedAt: NOW.getTime() - 3600000 + 1000 * startedCount++,
    statusUpdatedAt: NOW.getTime() - 600000,
    ...(procStart ? { procStart } : {}),
    ...extra,
  });
}

/** A built PR story in the home, where the bridge finds it. `state` adds files to its state folder. */
export function prStory(
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
    ...(branch ? { head_ref: branch } : {}),
  });
  writeJson(path.join(dir, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

/** A process that stays alive for the test, so a registry file can name it. */
export function liveChild(): { pid: number; procStart: string; stop: () => void } {
  const child = spawn('sleep', ['60']);
  const pid = child.pid as number;
  return { pid, procStart: procStartOf(pid), stop: () => child.kill() };
}

/** A checkout of acme/<name> on a branch, where a session can work. */
export function checkoutOf(name: string, branch: string): string {
  const dir = tmp('board-checkout');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  return dir;
}

export const fullId = (pid: number) =>
  `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

export const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/** A Larmor checkout whose venv python plays voice_ctl (fixtures/fake-larmor.ts), reading its voice state from `voiceDir`. */
export function fakeLarmor(voiceDir: string = tmp('board-voice')): string {
  return fakeLarmorIn(tmp('board-larmor'), voiceDir);
}

/**
 * The fake voice_ctl is a node process, and a full run's load can slow its start past the board's one-second cold wait and
 * its three-second call kill (cause not proven beyond that: a slow cold start of the fake under load). So every voice test
 * waits up to 30 s, and the few that check the board's own cutoffs run under withBoardWaits.
 */
export const WIDE_WAITS = { coldWaitMs: 30 * 1000, quickTimeoutMs: 30 * 1000 };
setVoiceWaits(WIDE_WAITS);

export async function withBoardWaits(run: () => Promise<void>): Promise<void> {
  setVoiceWaits(null);
  try {
    await run();
  } finally {
    setVoiceWaits(WIDE_WAITS);
  }
}

// ---------- local stories beside the PR stories

/** A local story as `once-upon local` writes it, in a checkout's .once-upon folder (here the story home), with what a test changes. */
export function localStory(
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
    ...extra,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story of ${id}`, chapters: [] });
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

export const reviewedBy = (home: string, id: string) =>
  readReviewRecord(new StoryStore({ home }), id)?.mark?.by ?? null;

/** A fake it2 that lists no tabs, so statuses fall back to the registry's. */
export function fakeIt2(): string {
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, "#!/bin/sh\necho '[]'\n");
  chmodSync(it2, 0o755);
  return it2;
}
