import { appendFileSync, mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createBridge, type Bridge } from '../src/server/index.ts';
import type { BranchCheck, PrCheck, RequestedCheck } from '../src/services/review/auto-review.ts';
import {
  localEntries,
  localStory,
  markStoryReviewed,
  prStories,
  prStory,
} from '../src/services/review/story-lists.ts';
import type { InboxLocalStory, InboxStory } from '@once-upon-a-diff/protocol/types';
import type { Build } from '../src/services/inbox/builds.ts';
import type { listeningOf } from '../src/services/listeners/listeners.ts';

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

// the helpers every package's tests share live in the test kit; they are re-exported so the tests keep importing them from here
export { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
export { git, localRepo } from '@once-upon-a-diff/test-kit/git';
export { githubStory } from '@once-upon-a-diff/test-kit/stories';

const BIN = fileURLToPath(new URL('../bin/once-upon.mjs', import.meta.url));

/**
 * A claim event stamped `stamp`: the store stamps the real clock, and a fixture's ledger is days old, so a test that needs the
 * claim made while a fixture run was going writes it with the time it means.
 */
export function claimAt(
  store: { file: string },
  id: string,
  agent: string,
  stamp: string,
  sid?: string,
): void {
  appendFileSync(
    store.file,
    JSON.stringify({ op: 'claim', id, agent, ...(sid ? { sid } : {}), by: 'test', at: stamp }) +
      '\n',
  );
}

// tests never look in (or move stories into) the real ~/Development checkouts
process.env.ONCE_UPON_DEV_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-dev-'));
// tests never read the real ~/.claude (the board's registry and transcripts are found under it by default)
export const CLAUDE_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-claude-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
// the proxy name is taken as reaching this machine, so no test depends on the machine's DNS
process.env.ONCE_UPON_NO_HOST_CHECK = '1';
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

/** Runs the once-upon CLI against `home`: {code, stdout, stderr}. */
export const runCli = (
  home: string,
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, ONCE_UPON_HOME: home, ...env }, cwd },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
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
