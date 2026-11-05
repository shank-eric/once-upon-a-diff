import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createBridge, type Bridge } from '@once-upon-a-diff/server/index';
import type {
  BranchCheck,
  PrCheck,
  RequestedCheck,
} from '@once-upon-a-diff/core/records/github/github-checks';
import {
  localEntries,
  localStory,
  markStoryReviewed,
  prStories,
  prStory,
} from '@once-upon-a-diff/core/features/review/story-lists';
import type { InboxLocalStory, InboxStory } from '@once-upon-a-diff/contracts/types';
import type { Build } from '@once-upon-a-diff/core/queues/requests/builds';
import type { listeningOf } from '@once-upon-a-diff/core/records/listeners/listeners';

/** A build request as the bridge answers with it: the request and its state. */
export type BuildView = Build & { state: string };
/** POST /api/builds. */
export type BuildAnswer = { state: string; request: BuildView };
/** One PR's line in status-many's answer (catalog.ts). */
export interface PrLine {
  repo: string;
  number: number;
  state: string;
  request?: BuildView | null;
  story?: string;
  story_head?: string | null;
  current_head?: string;
  stale?: boolean | null;
  newer?: number | null;
  updating?: boolean;
  update_state?: string | null;
  update_mode?: string | null;
  reads?: { read: number; total: number; next: number | null };
  unread_answers?: number;
}
/** POST /api/stories/status-many: each PR's line, and who's listening for each repo. */
export type StatusMany = {
  results: PrLine[];
  listening: Record<string, ReturnType<typeof listeningOf>>;
};

// the helpers the core's tests share (isolation env, the test kit's helpers, claimAt) are re-exported so the tests keep importing them from here
export {
  CLAUDE_DIR,
  claimAt,
  registerRuns,
  git,
  githubStory,
  localRepo,
  tmp,
  writeJson,
} from '@once-upon-a-diff/core/test/helpers';
export type { AgentRun } from '@once-upon-a-diff/core/test/helpers';

const BIN = fileURLToPath(new URL('../bin/once-upon.mjs', import.meta.url));

export const TOKEN = 'test-token-0123456789abcdef';

/** A bridge on a random port with the test token, and `call` for its API: the answer's JSON is T, as the test expects it. */
export async function startBridge(opts: {
  home: string;
  log?: (line: string) => void;
  checkPr?: PrCheck;
  checkBranch?: BranchCheck;
  checkRequested?: RequestedCheck;
}) {
  // no test asks GitHub unless it brings its own check
  const server: Bridge = createBridge({
    token: TOKEN,
    checkPr: async () => ({ merged: false, why: null }),
    checkBranch: async () => null,
    checkRequested: async () => [],
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; text: string; headers: Headers }> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return {
    server,
    base,
    call,
    close: () => new Promise<unknown>((resolve) => server.close(resolve)),
  };
}

/** Runs the once-upon CLI against `home`, with `input` on its stdin: {code, stdout, stderr}. */
export const runCli = (
  home: string,
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
  input?: string,
): Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, ONCE_UPON_HOME: home, ...env }, cwd },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
    // `input` is the run's stdin (a flag that reads `-`); the run's argv stays short, as long text must
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });

/** startBridge's bridge, with `call` and `close`. */
export type TestBridge = Awaited<ReturnType<typeof startBridge>>;

/** The built PR stories and the local stories, read in-process as the board reads them. */
export interface StoryList {
  stories: InboxStory[];
  local_stories: InboxLocalStory[];
}

/**
 * The PR stories and local stories the bridge has, and the GitHub checks they start (kicked in the background, as a
 * board poll does).
 */
export function storyList(bridge: TestBridge): StoryList {
  const { stories, autoReview } = bridge.server;
  const everything = prStories(stories);
  const localList = localEntries(stories);
  autoReview.kick(everything);
  autoReview.kickLocal(localList);
  return { stories: everything, local_stories: localList.map((entry) => entry.story) };
}

/** Marks a PR story or a local story reviewed (or not), the way the board's Mark reviewed does, and answers with the story. */
export function markReviewed(bridge: TestBridge, id: string, reviewed = true) {
  const { stories } = bridge.server;
  if (!prStory(stories, id) && !localStory(stories, id)) {
    return null;
  }
  markStoryReviewed(stories, id, reviewed);
  return prStory(stories, id) ?? localStory(stories, id);
}

/**
 * A git on PATH that runs every command with the real git except the ones that would reach a remote or change what it
 * tracks: `push` and `branch --set-upstream-to`, which it only logs (no test runs a real push). `calls()` answers the logged
 * argument lists, and `restore()` puts PATH back.
 */
export function fakeGitPush(): { calls: () => string[][]; restore: () => void } {
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'once-upon-fake-git-'));
  const log = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'git');
  writeFileSync(
    script,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    push|--set-upstream-to=*)
      node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${log}" "$@"
      exit 0;;
  esac
done
exec "${real}" "$@"
`,
  );
  chmodSync(script, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  return {
    calls: () => {
      try {
        return readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    restore: () => {
      process.env.PATH = before;
    },
  };
}
