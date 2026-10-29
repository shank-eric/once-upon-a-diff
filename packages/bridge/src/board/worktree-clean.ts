/**
 * Clean up: the board's one write to your checkouts, on a click. It removes a worktree's folder with `git worktree
 * remove` (never --force, so git itself also refuses a dirty or locked one) and, only when the branch is merged into the
 * default branch (or the main checkout's own branch built on it), deletes the branch with `git branch -d`.
 *
 * The page sends a path and what its confirm said, nothing else of substance. Before anything runs the bridge:
 *   1. finds the path in the scanner's own list (a path git does not list as a linked worktree is a 404)
 *   2. looks at that worktree again now: facts worked out fresh, the status taken afresh (a timeout is "not known")
 *   3. runs the same `judge` the board used, with who is working in it as of now; any reason to keep it is a 409.
 *      A detached HEAD that no branch reaches is one: removing it would drop its commits
 *   4. for a superseded worktree, wants ack "superseded", which the page sends only after its confirm said so
 *   5. for ignored files that cannot be rebuilt (.env, *.local.json), wants ack "ignored-files" and the names the confirm
 *      showed: a name the page did not show is a 409
 *   6. never deletes a branch of a repo on the keep list (everfi-frontend is always on it), a default branch, or one
 *      that is not merged
 * It writes the attempt, with the line that restores the branch, to <home>/worktree-cleanups.jsonl before it runs
 * git, and the outcome after. A removal that fails or times out is not retried: the worktree is marked "needs
 * attention" and Clean up is not offered for it again.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.ts';
import { gitArgs, judge, runCommand } from './worktrees.ts';
import type {
  JudgeContext,
  RunResult,
  Runner,
  WorktreeFacts,
  WorktreeScanner,
} from './worktrees.ts';

/** `git worktree remove` deletes node_modules too, which can take minutes: a kill partway leaves half a folder, so the limit is long. */
const REMOVE_MS = 30 * 60 * 1000;
const SHORT_MS = 10000;

export interface CleanInput {
  scanner: WorktreeScanner;
  /** the folder to clean up, as the page named it */
  dir: string;
  /** what the page's confirm said: "superseded", "ignored-files" */
  ack: string[];
  /** the ignored files the confirm named */
  seen?: string[];
  /** who is working in it and what its PR says, as of now */
  contextOf: (facts: WorktreeFacts) => Promise<Omit<JudgeContext, 'keepBranches' | 'now'>>;
  keepBranches: string[];
  home: string;
  run?: Runner;
  now?: () => number;
}

export interface CleanResult {
  removed: string;
  /** the branch that was deleted, with the sha to restore it from; null when it was kept */
  branch: { name: string; sha: string; restore: string } | null;
  /** why a branch that was to be deleted was kept (git refused) */
  note: string | null;
}

/** Paths being cleaned right now, so a second click waits out the first. */
const inFlight = new Set<string>();

/** A word for a shell: single-quoted, so a path with spaces or commas pastes right. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** What went wrong with a removal, in words: a timeout, a dirty or locked worktree, or git's own line. */
export function removalError(result: RunResult): string {
  if (result.timedOut) {
    return `git worktree remove did not finish in ${REMOVE_MS / 60000} minutes and was stopped; the folder may be partly deleted`;
  }
  const said = (result.stderr || '').trim();
  if (/contains modified or untracked files/.test(said)) {
    return 'git refused: the worktree has modified or untracked files';
  }
  if (/locked/.test(said)) {
    return 'git refused: the worktree is locked';
  }
  const first = said.split('\n').find((line) => line.trim());
  return first
    ? `git refused: ${first.replace(/^(fatal|error): /, '')}`
    : 'git worktree remove failed';
}

/** The line that brings back the commits: the branch, or for a detached HEAD a branch made at its commit. */
function restoreLine(facts: WorktreeFacts, sha: string | null): string {
  if (!sha) {
    return '';
  }
  const name = facts.branch ?? `restored-${sha.slice(0, 7)}`;
  return `git -C ${shellQuote(facts.main)} branch ${shellQuote(name)} ${shellQuote(sha)}`;
}

function log(home: string, now: () => number, entry: Record<string, unknown>): void {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(
      path.join(home, 'worktree-cleanups.jsonl'),
      JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* the log is a convenience */
  }
}

export async function cleanWorktree(input: CleanInput): Promise<CleanResult> {
  const run = input.run ?? runCommand;
  const now = input.now ?? Date.now;
  const listed = input.scanner.find(input.dir);
  if (!listed) {
    throw new BoardError(404, 'the board does not list a worktree there');
  }
  if (inFlight.has(listed.path)) {
    throw new BoardError(409, 'that worktree is already being cleaned up');
  }
  inFlight.add(listed.path);
  try {
    const facts = await input.scanner.refreshOne(listed.path);
    if (!facts) {
      throw new BoardError(409, 'git no longer lists that worktree');
    }
    const judged = judge(facts, {
      ...(await input.contextOf(facts)),
      keepBranches: input.keepBranches,
      now: now(),
    });
    if (!judged.removable) {
      throw new BoardError(409, `not cleaned up: ${judged.keep.join(', ')}`);
    }
    const supersededAck = input.ack.includes('superseded');
    if (judged.verdict === 'superseded' && !supersededAck) {
      throw new BoardError(
        409,
        'this work is only superseded (the main line has a copy of each commit): confirm that first',
      );
    }
    if (judged.verdict !== 'superseded' && supersededAck) {
      throw new BoardError(409, 'the worktree is no longer only superseded: look at it again');
    }
    if (judged.ignored.length) {
      const shown = new Set(input.seen ?? []);
      if (!input.ack.includes('ignored-files') || judged.ignored.some((name) => !shown.has(name))) {
        throw new BoardError(
          409,
          `these ignored files would be deleted with the folder, so confirm them first: ${judged.ignored.join(', ')}`,
        );
      }
    }
    const sha = facts.head;
    const base = {
      path: facts.path,
      repo: facts.repo,
      branch: facts.branch,
      head: sha,
      verdict: judged.verdict,
      ignored: judged.ignored,
      restore: restoreLine(facts, sha),
    };
    log(input.home, now, { ...base, phase: 'attempt' });
    const removed = await run(
      'git',
      gitArgs(facts.main, ['worktree', 'remove', facts.path]),
      REMOVE_MS,
    );
    if (removed.code !== 0) {
      const error = removalError(removed);
      log(input.home, now, { ...base, phase: 'failed', error });
      input.scanner.markAttention(facts.path, error);
      throw new BoardError(409, `${error}. It is marked as needing attention and was not retried.`);
    }
    let branch: CleanResult['branch'] = null;
    let note: string | null = null;
    if (judged.deletes_branch && facts.branch && !facts.branch.startsWith('-')) {
      // the tip as it is now, captured before the delete (git's own message only has a short sha)
      const tip = await run(
        'git',
        gitArgs(facts.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${facts.branch}`]),
        SHORT_MS,
      );
      const tipSha = tip.code === 0 ? tip.stdout.trim() : '';
      const deleted = tipSha
        ? await run('git', gitArgs(facts.main, ['branch', '-d', '--', facts.branch]), SHORT_MS)
        : null;
      if (deleted && deleted.code === 0) {
        branch = {
          name: facts.branch,
          sha: tipSha,
          restore: `git -C ${shellQuote(facts.main)} branch ${shellQuote(facts.branch)} ${shellQuote(tipSha)}`,
        };
      } else {
        note = 'git would not delete the branch (it is not merged as git sees it), so it was kept';
      }
    }
    log(input.home, now, { ...base, phase: 'removed', branch_deleted: !!branch });
    input.scanner.forget(facts.path);
    return { removed: facts.path, branch, note };
  } finally {
    inFlight.delete(listed.path);
  }
}
