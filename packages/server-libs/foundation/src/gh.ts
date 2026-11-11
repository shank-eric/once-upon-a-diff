/**
 * gh as the logged-in gh user: config.json decides whether GITHUB_TOKEN is dropped from the environment (ghEnv). The
 * gh calls themselves are in adapters/github.ts, which only this file imports.
 */
import * as github from '@once-upon-a-diff/adapters/github';
import { ghEnv } from './settings.ts';

const withEnv = (options: github.GhOptions = {}): github.GhOptions => ({
  ...options,
  env: options.env ?? ghEnv(),
});

/** `gh api <path>`, parsed, every page with `paginate` (see adapters/github.ts). */
export const ghApiJson = <T = unknown>(
  path: string,
  options: Parameters<typeof github.ghApiJson>[1] = {},
): Promise<T> => github.ghApiJson<T>(path, { ...options, env: options.env ?? ghEnv() });
/** `gh api graphql` with a query and its variables, parsed (see adapters/github.ts). */
export const ghGraphql = <T = unknown>(
  query: string,
  variables?: Record<string, string | number>,
  options?: github.GhOptions,
): Promise<T> => github.ghGraphql<T>(query, variables, withEnv(options));
/** The open PR for a branch, parsed (see adapters/github.ts). */
export const ghOpenPullList: typeof github.ghOpenPullList = (repo, branch, options) =>
  github.ghOpenPullList(repo, branch, withEnv(options));
/** A PR's head branch (see adapters/github.ts). */
export const prHeadBranch: typeof github.prHeadBranch = (repo, number, options) =>
  github.prHeadBranch(repo, number, withEnv(options));
