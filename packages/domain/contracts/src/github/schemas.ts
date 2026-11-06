/*
 * What the extension reports about a GitHub page (page-made, so every field is checked). Server side only: it imports
 * valibot, so the bridge never serves this file to a page.
 */
import {
  check,
  integer,
  minValue,
  number,
  object,
  optional,
  picklist,
  pipe,
  regex,
  string,
  type GenericSchema,
} from 'valibot';
import { BRANCH_RE, REPO_RE } from '@once-upon-a-diff/terms/patterns';

/** What the extension saw you do on a GitHub page (a refresh's reason, for the bridge's log line). */
export const GITHUB_REFRESH_REASONS = ['review', 'open', 'merge', 'ready', 'close'] as const;

export const GITHUB_BODIES = {
  /** POST /api/github/refresh: what the extension saw you do on GitHub (page-made, so every field is checked) */
  githubRefresh: pipe(
    object({
      repo: pipe(string(), regex(REPO_RE)),
      branch: optional(pipe(string(), regex(BRANCH_RE))),
      number: optional(pipe(number(), integer(), minValue(1))),
      reason: picklist(GITHUB_REFRESH_REASONS),
    }),
    check((body) => !!body.branch || !!body.number, 'a branch or a PR number is needed'),
  ),
} satisfies Record<string, GenericSchema>;

/** What the bridge has always said about a field of these bodies, where a page shows it. */
export const GITHUB_MESSAGES: Partial<Record<keyof typeof GITHUB_BODIES, Record<string, string>>> =
  {
    githubRefresh: { repo: 'bad repo', branch: 'bad branch', number: 'bad number' },
  };
