/*
 * <home>/github-answers.json: what GitHub last said, kept so a bridge that restarts shows the last known state of each
 * branch's PR, each PR and the lists of your PRs until GitHub answers again. Each entry carries the time it was answered
 * (ms); entries older than a week are dropped on read and on write, and a time ahead of now (a clock that was ahead when it was written) is read as now, so it expires a week on. A missing file, a file that isn't JSON or one of another
 * version reads as empty, and an entry of the wrong shape is skipped, so the next write leaves a clean file. Writes go
 * through writeJsonAtomic.
 */
import path from 'node:path';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import { readJson, writeJsonAtomic } from './fs/json-file.ts';

const file = (home: string) => path.join(home, 'github-answers.json');

const VERSION = 1;
/** Entries this old are dropped, long after any card they could show has gone. */
export const KEEP_MS = 7 * 24 * 3600 * 1000;

/** The PR GitHub has for a branch (see BranchPr in github-checks.ts), as stored. */
interface StoredBranchPr {
  number: number;
  state: 'open' | 'merged';
  merged_at: string | null;
  head_oid?: string;
  shipped?: string[];
}

export interface GithubAnswers {
  /** by `<repo lower>@<branch>`; `pr` null is an answer: GitHub has no PR for it */
  branches: Record<string, { at: number; pr: StoredBranchPr | null }>;
  /** by `<repo lower>#<number>` */
  prs: Record<string, { at: number; info: PrInfo }>;
  requested: { at: number; list: { repo: string; number: number; created_at?: string }[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a record's `number` is a number and its `state` is one of `states`: what a stored PR of either shape has. */
const hasNumberAndState = (record: Record<string, unknown>, states: readonly unknown[]): boolean =>
  typeof record.number === 'number' && states.includes(record.state);

/** Whether a stored value has the shape of a `StoredBranchPr`. */
export function isStoredBranchPr(value: unknown): value is StoredBranchPr {
  if (!isRecord(value)) {
    return false;
  }
  const hasMergedAt = value.merged_at === null || typeof value.merged_at === 'string';
  const hasHead = value.head_oid === undefined || typeof value.head_oid === 'string';
  const hasShipped =
    value.shipped === undefined ||
    (Array.isArray(value.shipped) && value.shipped.every((oid) => typeof oid === 'string'));
  const hasNumberAndKnownState = hasNumberAndState(value, ['open', 'merged']);
  return hasNumberAndKnownState && hasMergedAt && hasHead && hasShipped;
}

/** Whether a stored value has the shape of a `PrInfo`: a number and a known state. */
export const isStoredPrInfo = (info: unknown): info is Record<string, unknown> =>
  isRecord(info) && hasNumberAndState(info, ['open', 'merged', 'closed']);

function branchPrOf(value: unknown): StoredBranchPr | null | undefined {
  if (value === null) {
    return null;
  }
  return isStoredBranchPr(value) ? value : undefined;
}

/** Whether a stored time is a number and still inside the week at `now`. */
const isFresh = (when: unknown, now: number): when is number =>
  typeof when === 'number' && now - when < KEEP_MS;

/** The branch answers that are of the right shape and still fresh; a time ahead of `now` reads as `now`. */
function readBranches(stored: unknown, now: number): GithubAnswers['branches'] {
  const out: GithubAnswers['branches'] = {};
  for (const [key, entry] of Object.entries(isRecord(stored) ? stored : {})) {
    const pr = isRecord(entry) ? branchPrOf(entry.pr) : undefined;
    if (isRecord(entry) && isFresh(entry.at, now) && pr !== undefined) {
      out[key] = { at: Math.min(entry.at, now), pr };
    }
  }
  return out;
}

/** The PR answers that are of the right shape and still fresh; a time ahead of `now` reads as `now`. */
function readPrs(stored: unknown, now: number): GithubAnswers['prs'] {
  const out: GithubAnswers['prs'] = {};
  for (const [key, entry] of Object.entries(isRecord(stored) ? stored : {})) {
    const info = isRecord(entry) ? entry.info : undefined;
    if (isRecord(entry) && isFresh(entry.at, now) && isStoredPrInfo(info)) {
      out[key] = { at: Math.min(entry.at, now), info: info as unknown as PrInfo };
    }
  }
  return out;
}

/** Whether a stored value is one `{ repo, number }` of the list of your PRs. */
const isRequestedPr = (pr: unknown): pr is { repo: string; number: number } =>
  isRecord(pr) && typeof pr.repo === 'string' && typeof pr.number === 'number';

/** The list of your PRs that was asked for, when it is of the right shape and still fresh. */
function readRequested(asked: unknown, now: number): GithubAnswers['requested'] {
  if (!isRecord(asked) || !isFresh(asked.at, now) || !Array.isArray(asked.list)) {
    return null;
  }
  return asked.list.every(isRequestedPr) ? { at: Math.min(asked.at, now), list: asked.list } : null;
}

/** What was kept, without the entries older than a week at `now`. */
export function readGithubAnswers(home: string, now = Date.now()): GithubAnswers {
  const stored = readJson<unknown>(file(home));
  if (!isRecord(stored) || stored.version !== VERSION) {
    return { branches: {}, prs: {}, requested: null };
  }
  return {
    branches: readBranches(stored.branches, now),
    prs: readPrs(stored.prs, now),
    requested: readRequested(stored.requested, now),
  };
}

/** Writes what is kept (entries older than a week at `now` left out). A home that can't be written is not an error: the next start just has nothing to show. */
export function writeGithubAnswers(home: string, answers: GithubAnswers, now = Date.now()): void {
  const keep = <T extends { at: number }>(entries: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(entries)
        .filter(([, entry]) => now - entry.at < KEEP_MS)
        .map(([key, entry]) => [key, { ...entry, at: Math.min(entry.at, now) }]),
    );
  try {
    writeJsonAtomic(file(home), {
      version: VERSION,
      branches: keep(answers.branches),
      prs: keep(answers.prs),
      requested:
        answers.requested && now - answers.requested.at < KEEP_MS
          ? { ...answers.requested, at: Math.min(answers.requested.at, now) }
          : null,
    });
  } catch {
    /* the home is gone or read-only: GitHub sync still works */
  }
}
