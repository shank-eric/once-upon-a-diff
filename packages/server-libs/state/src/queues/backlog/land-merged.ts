/**
 * Landing by merged PR: a card whose work has begun (started, claimed or named by a run) and whose branch has a PR merged
 * into the repo's default branch is done at the merge commit (a repo with no deploy-local.sh never runs `backlog land`). The board's snapshot kicks it (board.ts) and never
 * waits for it. A deploy matches a card by its recorded commit (landing.ts); this matches by the card's branch, so a squash,
 * an amend or a card with no author run lands the same, with these guards: the PR is from the card's own repo, into the
 * default branch (merged-pr.ts), and merged at or after the card's work began (so a branch name used before is not the work).
 */
import { canonicalRepo, repoKey } from '@once-upon-a-diff/terms/ids';
import type { LedgerAgent } from '../../records/agents/ledger.ts';
import type { MergedCheck } from '../../records/github/merged-pr.ts';
import type { BacklogStore } from './backlog.ts';
import { runsOf } from './phase.ts';
import type { BacklogItem } from './types.ts';

/** A card is not asked about again for this long after its last ask, answered or not (so a gh outage or a PR still open costs one ask per window). */
const WINDOW_MS = 10 * 60000;
/** The most cards one kick asks about, one at a time. */
const MAX_ASKS = 20;
/** An ask that takes longer than this is given up on (gh's own timeout is 30 s). */
const ASK_MS = 40000;

/**
 * When the card's work began, in ms: the earliest of its start, its claim and the first run that names it (a card added with a
 * branch and claimed or run without `--branch` is never `started`), or null when none of them exists.
 */
function workBeganAt(item: BacklogItem, agents: LedgerAgent[]): number | null {
  const times = [
    item.started_at,
    item.claim?.at,
    ...runsOf(item, agents).map((run) => run.started?.toISOString()),
  ]
    .map((stamp) => (stamp ? Date.parse(stamp) : NaN))
    .filter((time) => !Number.isNaN(time));
  return times.length ? Math.min(...times) : null;
}

/** Whether a card may land by its PR: not landed, dropped, held or someday, with a branch and repo, and its work begun (a card only added with a branch is not). */
function landable(
  item: BacklogItem,
  agents: LedgerAgent[],
): item is BacklogItem & { repo: string; branch: string } {
  return (
    item.state !== 'dropped' &&
    !item.landed_at &&
    !item.hold &&
    !item.someday &&
    !!item.repo &&
    !!item.branch &&
    workBeganAt(item, agents) !== null
  );
}

export class MergeLander {
  private running: Promise<number> | null = null;
  private asked = new Map<string, number>();
  private store: BacklogStore;
  private check: MergedCheck;
  private now: () => number;
  private askMs: number;
  private agents: () => LedgerAgent[];

  /** `agents` reads the registry's runs, which say a card's work began when it was never started (the board passes its own read). */
  constructor(
    store: BacklogStore,
    check: MergedCheck,
    now: () => number,
    askMs = ASK_MS,
    agents: () => LedgerAgent[] = () => [],
  ) {
    this.agents = agents;
    this.store = store;
    this.check = check;
    this.now = now;
    this.askMs = askMs;
  }

  /** Asks about the cards that may land and writes `done` for those whose PR merged; answers how many it wrote. One run at a time: a kick while one is going shares it. */
  kick(): Promise<number> {
    if (!this.running) {
      const running = this.run().finally(() => {
        if (this.running === running) {
          this.running = null;
        }
      });
      this.running = running;
    }
    return this.running;
  }

  private async run(): Promise<number> {
    let wrote = 0;
    let asks = 0;
    const runs = this.agents();
    for (const item of this.store.listed().filter((one) => landable(one, runs))) {
      const key = `${repoKey(item.repo)}@${item.branch}`;
      const nowMs = this.now();
      if (asks >= MAX_ASKS || nowMs - (this.asked.get(key) ?? -Infinity) < WINDOW_MS) {
        continue;
      }
      asks += 1;
      // stamped before the ask, so it holds when the ask fails or never answers
      this.asked.set(key, nowMs);
      const pr = await this.ask(item.repo, item.branch);
      if (!pr || !(Date.parse(pr.merged_at) >= (workBeganAt(item, runs) as number))) {
        continue;
      }
      // read again with no await before the write: a deploy or the CLI may have landed or held it during the ask (the window
      // that is left is the file's, microseconds; a second `done` on a landed card would only reset its sha)
      const fresh = this.store.items().find((one) => one.id === item.id);
      if (fresh && landable(fresh, runs) && fresh.branch === item.branch) {
        this.store.done(item.id, { sha: pr.merge_oid, mergedAt: pr.merged_at, by: 'merged-pr' });
        wrote += 1;
      }
    }
    return wrote;
  }

  /** The card's merged PR, or null when it has none or GitHub could not be asked in time. */
  private async ask(repo: string, branch: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.check(canonicalRepo(repo), branch)),
        new Promise<null>((resolve) => {
          timer = setTimeout(resolve, this.askMs, null);
          timer.unref();
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
