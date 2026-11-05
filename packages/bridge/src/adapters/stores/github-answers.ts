/*
 * <home>/github-answers.json: what GitHub last said, kept so a bridge that restarts shows the last known state of each
 * branch's PR, each PR and the lists of your PRs until GitHub answers again. Each entry carries the time it was answered
 * (ms); entries older than a week are dropped on read and on write, and a time ahead of now (a clock that was ahead when it was written) is read as now, so it expires a week on. A missing file, a file that isn't JSON or one of another
 * version reads as empty, and an entry of the wrong shape is skipped, so the next write leaves a clean file. Writes go
 * through writeJsonAtomic.
 */
import path from 'node:path';
import type { PrInfo } from '@once-upon-a-diff/protocol/types';
import { readJson, writeJsonAtomic } from './fs/json-file.ts';

const file = (home: string) => path.join(home, 'github-answers.json');

const VERSION = 1;
/** Entries this old are dropped, long after any card they could show has gone. */
export const KEEP_MS = 7 * 24 * 3600 * 1000;

/** The PR GitHub has for a branch (see BranchPr in github-checks.ts), as stored. */
export interface StoredBranchPr {
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
  requested: { at: number; list: { repo: string; number: number }[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function branchPrOf(value: unknown): StoredBranchPr | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    (value.state !== 'open' && value.state !== 'merged') ||
    !(value.merged_at === null || typeof value.merged_at === 'string') ||
    !(value.head_oid === undefined || typeof value.head_oid === 'string') ||
    !(
      value.shipped === undefined ||
      (Array.isArray(value.shipped) && value.shipped.every((oid) => typeof oid === 'string'))
    )
  ) {
    return undefined;
  }
  return value as unknown as StoredBranchPr;
}

/** What was kept, without the entries older than a week at `now`. */
export function readGithubAnswers(home: string, now = Date.now()): GithubAnswers {
  const out: GithubAnswers = { branches: {}, prs: {}, requested: null };
  const stored = readJson<unknown>(file(home));
  if (!isRecord(stored) || stored.version !== VERSION) {
    return out;
  }
  const fresh = (when: unknown): when is number => typeof when === 'number' && now - when < KEEP_MS;
  if (isRecord(stored.branches)) {
    for (const [key, entry] of Object.entries(stored.branches)) {
      const pr = isRecord(entry) ? branchPrOf(entry.pr) : undefined;
      if (isRecord(entry) && fresh(entry.at) && pr !== undefined) {
        out.branches[key] = { at: Math.min(entry.at, now), pr };
      }
    }
  }
  if (isRecord(stored.prs)) {
    for (const [key, entry] of Object.entries(stored.prs)) {
      const info = isRecord(entry) ? entry.info : undefined;
      if (
        isRecord(entry) &&
        fresh(entry.at) &&
        isRecord(info) &&
        typeof info.number === 'number' &&
        (info.state === 'open' || info.state === 'merged' || info.state === 'closed')
      ) {
        out.prs[key] = { at: Math.min(entry.at, now), info: info as unknown as PrInfo };
      }
    }
  }
  const asked = stored.requested;
  if (
    isRecord(asked) &&
    fresh(asked.at) &&
    Array.isArray(asked.list) &&
    asked.list.every(
      (pr) => isRecord(pr) && typeof pr.repo === 'string' && typeof pr.number === 'number',
    )
  ) {
    out.requested = {
      at: Math.min(asked.at, now),
      list: asked.list as { repo: string; number: number }[],
    };
  }
  return out;
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
