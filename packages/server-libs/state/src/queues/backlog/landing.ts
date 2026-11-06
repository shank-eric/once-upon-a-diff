/**
 * Which backlog cards a deploy landed: by the commit each card's agent recorded, never by a branch name. The agent
 * registry's finish events carry `result.commit` (and `result.card`); the card's tip is the newest such commit. A card has
 * landed when its tip is in the deployed range, as the commit itself (a fast-forward), as a picked sha (a batch deploy's
 * cherry-picks), or as the same patch (a rebase, or a pick whose sha changed). A card whose tip matched nothing stays open and
 * is reported, so a person closes it by id (`backlog done ID`). A held card is never closed here.
 */
import { authorStamp, commitOf, commitsInRange, patchId } from '@once-upon-a-diff/adapters/git';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { STALE_MS, runIsOpen, type AgentEvent } from '../../records/agents/events.ts';
import { lastActivity, type LedgerAgent } from '../../records/agents/ledger.ts';
import type { BacklogItem } from './types.ts';
import { claimedRun } from './claims.ts';
import { isWorkRun, namedByRuns, runsOf } from './phase.ts';

/**
 * Each card's tip from the raw finish events (the folded registry keeps only a run's last result, and a rerun hides the
 * runs before it): a finish names its card, else it is the card of its own run's `start`. The newest commit wins, and a
 * finish with no commit does not clear an earlier one. The shas are as recorded (often short).
 */
export function recordedTips(events: AgentEvent[]): Map<string, string> {
  const startCard = new Map<string, string>();
  const tips = new Map<string, { sha: string; when: number }>();
  for (const event of events) {
    if (event.op === 'start' && event.run && event.card) {
      startCard.set(`${event.id}/${event.run}`, event.card);
    }
    const sha = event.op === 'finish' ? event.result?.commit : null;
    if (!sha) {
      continue;
    }
    const card =
      event.result?.card ?? (event.run ? startCard.get(`${event.id}/${event.run}`) : undefined);
    const when = Date.parse(event.at);
    if (card && when >= (tips.get(card)?.when ?? -Infinity)) {
      tips.set(card, { sha, when });
    }
  }
  return new Map([...tips].map(([card, tip]) => [card, tip.sha]));
}

/**
 * Whether the run that holds the item's claim is still going: that run (not a later run of the same name), open, and not
 * stale (no event for STALE_MS, the rule the registry and the board use), so a crashed agent does not hold its card forever.
 */
function claimInProgress(item: BacklogItem, agents: LedgerAgent[], nowMs: number): boolean {
  // a card its work runs name is read by them: any open, live run of the card (a fix round included) is in progress
  if (namedByRuns(item, agents)) {
    return runsOf(item, agents)
      .filter(isWorkRun)
      .some((run) => runIsOpen(run) && nowMs - (lastActivity(run)?.getTime() ?? nowMs) <= STALE_MS);
  }
  const held = claimedRun(item, agents);
  return (
    !!held?.current &&
    runIsOpen(held.agent) &&
    nowMs - (lastActivity(held.agent)?.getTime() ?? nowMs) <= STALE_MS
  );
}

/** Why a card with work on it did not land. */
function whyOpen(recorded: string | undefined, tip: string | null, running: boolean): string {
  if (running) {
    return 'still in progress (its agent has a run going)';
  }
  if (!recorded) {
    return 'no recorded tip (no finished run named it with --commit and --card)';
  }
  return tip
    ? `tip ${recorded} is not in this deploy`
    : `tip ${recorded} is not a commit of this repo`;
}

export interface LandRange {
  from: string;
  to: string;
  /** a batch deploy's picked shas: a card whose tip is one of them landed, whatever its patch looks like now */
  picked?: string[];
}

/** What `landItems` found. `open` is the cards still open that an agent holds or work started on, with why. */
export interface LandResult {
  landed: { item: BacklogItem; sha: string }[];
  held: BacklogItem[];
  open: { item: BacklogItem; why: string }[];
}

/**
 * The cards this deploy landed, in the checkout `repo`. Pure of writes: the caller marks each landed card done. Only a
 * card of this repo is reported as open (a card with no repo counts); a card's tip that is not a commit of this repo is
 * skipped for landing.
 */
export function landItems(
  repo: string,
  repoName: string | null,
  items: BacklogItem[],
  tips: Map<string, string>,
  range: LandRange,
  agents: LedgerAgent[] = [],
  nowMs = Date.now(),
): LandResult {
  const reachable = new Set(commitsInRange(repo, range.from, range.to));
  const patches = new Map<string, string>();
  for (const sha of commitsInRange(repo, range.from, range.to, { merges: false })) {
    const id = patchId(repo, sha);
    if (id && !patches.has(id)) {
      patches.set(id, sha);
    }
  }
  const picked = new Set(
    (range.picked ?? []).flatMap((sha) => {
      const full = commitOf(repo, sha);
      return full ? [full] : [];
    }),
  );
  let stamps: Map<string, string> | null = null;
  const pickOf = (tip: string): string | null => {
    stamps ??= new Map(
      commitsInRange(repo, range.from, range.to, { merges: false }).flatMap((sha) => {
        const stamp = authorStamp(repo, sha);
        return stamp ? [[stamp, sha] as [string, string]] : [];
      }),
    );
    const stamp = authorStamp(repo, tip);
    return (stamp && stamps.get(stamp)) || null;
  };
  const result: LandResult = { landed: [], held: [], open: [] };
  for (const item of items) {
    if (item.state === 'dropped' || item.landed_at) {
      continue;
    }
    const recorded = tips.get(item.id);
    const tip = recorded ? commitOf(repo, recorded) : null;
    let sha: string | null = null;
    if (tip) {
      const own = patchId(repo, tip);
      if (reachable.has(tip)) {
        sha = tip;
      } else if (own && patches.has(own)) {
        sha = patches.get(own) ?? null;
      } else if (picked.has(tip)) {
        // the pick's context changed, so its patch differs: the commit that went live is the one that kept the tip's
        // author, date and message, else (nothing found) the tip as given
        sha = pickOf(tip) ?? tip;
      }
    }
    if (sha) {
      if (item.hold) {
        result.held.push(item);
      } else {
        result.landed.push({ item, sha });
      }
      continue;
    }
    const mine = !item.repo || !repoName || sameRepo(item.repo, repoName);
    if (mine && !item.hold && (item.claim || item.state === 'started')) {
      result.open.push({
        item,
        why: whyOpen(recorded, tip, claimInProgress(item, agents, nowMs)),
      });
    }
  }
  return result;
}
