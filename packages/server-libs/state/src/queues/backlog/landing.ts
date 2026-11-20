/**
 * Which backlog cards a deploy landed: by the commit each card's agent recorded, never by a branch name. The agent
 * registry's finish events carry `result.commit` (and `result.card`); the card's tip is the newest such commit. A card has
 * landed when its tip is in the deployed range, as the commit itself (a fast-forward), as a picked sha (a batch deploy's
 * cherry-picks), or as the same patch (a rebase, or a pick whose sha changed). A card whose tip matched nothing stays open and
 * is reported, so a person closes it by id (`backlog done ID`). A held card is never closed here.
 */
import { authorStamp, commitOf, commitsInRange, patchId } from '@once-upon-a-diff/adapters/git';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { STALE_MS, movesWith, runIsOpen, type AgentEvent } from '../../records/agents/events.ts';
import { lastActivity, type LedgerAgent } from '../../records/agents/ledger.ts';
import type { BacklogItem } from './types.ts';
import { isWorkRun, runsOf } from './phase.ts';

/**
 * Each card's tip from the raw finish events (the folded registry keeps only a run's last result, and a rerun hides the
 * runs before it): a finish names its card, else it is the card of its own run's `start`. A run moved to another card (a
 * `card` event, `backlog drop --into`) takes its commit along, by the fold's rule: its start card is re-pointed, and a
 * finish that named the old card now names the new one. The newest commit wins, and a finish with no commit does not clear
 * an earlier one. The shas are as recorded (often short).
 */
export function recordedTips(events: AgentEvent[]): Map<string, string> {
  const runCard = new Map<string, string>();
  const finishes: Finish[] = [];
  for (const event of events) {
    const key = event.run ? `${event.id}/${event.run}` : null;
    if (event.op === 'start' && key && event.card) {
      runCard.set(key, event.card);
    } else if (event.op === 'card' && key && event.card) {
      moveRun(runCard, finishes, key, event.card);
    } else if (event.op === 'finish' && event.result?.commit) {
      finishes.push({
        key,
        named: event.result.card ?? undefined,
        sha: event.result.commit,
        when: Date.parse(event.at),
      });
    }
  }
  return newestTips(finishes, runCard);
}

/** Each card's newest finish commit: a finish names its card, else it is the card of its own run's start. */
function newestTips(finishes: Finish[], runCard: Map<string, string>): Map<string, string> {
  const tips = new Map<string, { sha: string; when: number }>();
  for (const { key, named, sha, when } of finishes) {
    const card = named ?? (key ? runCard.get(key) : undefined);
    if (card && when >= (tips.get(card)?.when ?? -Infinity)) {
      tips.set(card, { sha, when });
    }
  }
  return new Map([...tips].map(([card, tip]) => [card, tip.sha]));
}

interface Finish {
  key: string | null;
  named: string | undefined;
  sha: string;
  when: number;
}

/** A run moved to another card: a finish that named its old card now names the new one, and its start card is the new one. */
function moveRun(runCard: Map<string, string>, finishes: Finish[], key: string, card: string) {
  const from = runCard.get(key);
  for (const one of finishes) {
    if (one.key === key && movesWith(one.named, from)) {
      one.named = card;
    }
  }
  runCard.set(key, card);
}

/**
 * Whether a work run of the card is still going: an open run (a fix round included) that is not stale (no event for STALE_MS,
 * the rule the registry and the board use), so a crashed agent does not hold its card forever.
 */
function claimInProgress(item: BacklogItem, agents: LedgerAgent[], nowMs: number): boolean {
  return runsOf(item, agents)
    .filter(isWorkRun)
    .some((run) => runIsOpen(run) && nowMs - (lastActivity(run)?.getTime() ?? nowMs) <= STALE_MS);
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
 * What a deploy range lands, as a lookup from a card's tip to the commit that went live (null when the tip is not in the range):
 * the tip itself (a fast-forward), the same patch (a rebase, or a pick whose sha changed) or a picked sha (a batch deploy's
 * cherry-picks).
 */
function shaLandedBy(repo: string, range: LandRange): (tip: string) => string | null {
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
  return (tip) => {
    if (reachable.has(tip)) {
      return tip;
    }
    const own = patchId(repo, tip);
    if (own && patches.has(own)) {
      return patches.get(own) ?? null;
    }
    // the pick's context changed, so its patch differs: the commit that went live is the one that kept the tip's
    // author, date and message, else (nothing found) the tip as given
    return picked.has(tip) ? (pickOf(tip) ?? tip) : null;
  };
}

/** A card whose tip went live: landed, unless it is held (a held card is never closed here). */
function landOrHold(result: LandResult, item: BacklogItem, sha: string): void {
  if (item.hold) {
    result.held.push(item);
  } else {
    result.landed.push({ item, sha });
  }
}

/** Whether a card that did not land is still work to report: of this repo (one with no repo counts), not held, and claimed or started. */
function holdsWork(item: BacklogItem, repoName: string | null): boolean {
  const mine = !item.repo || !repoName || sameRepo(item.repo, repoName);
  return mine && !item.hold && !!(item.claim || item.state === 'started');
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
  const landedSha = shaLandedBy(repo, range);
  const result: LandResult = { landed: [], held: [], open: [] };
  for (const item of items) {
    if (item.state === 'dropped' || item.landed_at) {
      continue;
    }
    const recorded = tips.get(item.id);
    const tip = recorded ? commitOf(repo, recorded) : null;
    const sha = tip ? landedSha(tip) : null;
    if (sha) {
      landOrHold(result, item, sha);
    } else if (holdsWork(item, repoName)) {
      result.open.push({
        item,
        why: whyOpen(recorded, tip, claimInProgress(item, agents, nowMs)),
      });
    }
  }
  return result;
}
