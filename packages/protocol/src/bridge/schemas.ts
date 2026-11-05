/*
 * The bridge-wide request bodies: page settings, usage counts, status-many and a build request. Server side only: it
 * imports valibot, so the bridge never serves this file to a page.
 */
import {
  array,
  boolean,
  check,
  fallback,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  string,
  transform,
  union,
  type GenericSchema,
} from 'valibot';
import { MAX_BATCH_ENTRIES } from '../domain/usage-actions.ts';

export const BRIDGE_BODIES = {
  /** POST /api/prefs and .../prefs: page settings; anything else is dropped, a bad view is unified */
  prefs: object({
    hideWhitespace: optional(fallback(boolean(), false)),
    diffView: optional(fallback(picklist(['unified', 'split']), 'unified')),
    layout: optional(
      fallback(
        nullable(
          object({
            width: optional(fallback(nullable(number()), null)),
            chatHeight: optional(fallback(nullable(number()), null)),
          }),
        ),
        null,
      ),
    ),
  }),
  /** POST /api/usage and .../usage: counts by action name. The bridge keeps only the names domain/usage-actions.ts lists. */
  usage: object({
    counts: pipe(
      record(string(), number()),
      check(
        (counts) => Object.keys(counts).length <= MAX_BATCH_ENTRIES,
        'too many actions in one batch',
      ),
    ),
  }),
  /** POST /api/stories/status-many */
  statusMany: object({
    // a list that isn't one of PRs gets no results, as it always has
    prs: optional(
      fallback(
        pipe(
          array(object({ repo: string(), number: number() })),
          transform((list) => list.slice(0, 200)),
        ),
        [],
      ),
      [],
    ),
  }),
  /** POST /api/builds */
  buildRequest: object({
    repo: string(),
    number: union([number(), string()]),
    mode: optional(string()),
    base_sha: optional(string()),
    retell: optional(fallback(boolean(), false), false),
    requested_at: optional(string()),
  }),
} satisfies Record<string, GenericSchema>;

/** What the bridge has always said about a field of these bodies, where a page shows it. */
export const BRIDGE_MESSAGES: Partial<Record<keyof typeof BRIDGE_BODIES, Record<string, string>>> =
  {
    buildRequest: { repo: 'bad repo', number: 'bad number' },
  };
