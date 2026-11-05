/*
 * What the extension is told after it reports a GitHub page event. Types only: nothing here runs.
 */

import type { Ok } from '../bridge/types.ts';

/** POST /api/github/refresh: `refreshed` is false when the bridge skipped it (the same thing was refreshed a moment ago), `settled` false when GitHub's answers hadn't all landed when the wait ran out. */
export interface GithubRefreshAnswer extends Ok {
  refreshed: boolean;
  settled: boolean;
}
