/*
 * A no-card start in a session that already has a recent no-card run on the same repo: the two are likely one piece of work,
 * and each got its own card (ADR-29). `relatedRuns` finds the earlier ones so `agent start` can say how to make it one card.
 * Pure: it reads the runs and cards it is given and writes nothing.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { lastActivity, type LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';

/** How long an earlier no-card run of the session counts as recent, from its last sign of life (fixed: no setting). */
export const RELATED_RUN_HOURS = 4;
/** The most earlier cards a hint names, newest first. */
const RELATED_MAX = 3;

export interface RelatedRun {
  run: string;
  card: string;
  title: string;
  minutesAgo: number;
}

type Item = ReturnType<BacklogStore['items']>[number];

export interface RelatedQuery {
  /** the runs as they stood before this start's sweep, which stamps a stopped run's end at now and so hides when it last did anything */
  agents: LedgerAgent[];
  items: Item[];
  /** this start's own name, sid, repo and branch */
  name: string;
  sid: string;
  repo: string | null;
  branch: string | null;
  now: Date;
}

/** A card an agent made that nobody adopted, dropped or landed: what a no-card start leaves behind. */
const isOpenImplicit = (item: Item | undefined): item is Item =>
  !!item && item.source === 'agent' && item.state !== 'dropped' && !item.landed_at;

/** Both repos name the same repo, or neither names one. */
const sameOrBothNone = (first: string | null, second: string | null): boolean =>
  first || second ? sameRepo(first, second) : true;

/** The branches do not tell the two apart: either has none, or they are the same. */
const branchesAgree = (first: string | null, second: string | null): boolean =>
  !first || !second || first === second;

/** The run made this card itself (its name is the card's `by`, as `makeCard` stores it), so it started with no --card. */
const madeCard = (agent: LedgerAgent, item: Item): boolean =>
  item.added_by === agent.name.slice(0, 40);

/** The run is another no-card run of this session, on a card it made and nobody adopted. */
const isEarlierNoCardRun = (agent: LedgerAgent, query: RelatedQuery, item?: Item): item is Item =>
  agent.sid === query.sid &&
  agent.name !== query.name &&
  !isSelfName(agent.name) &&
  !agent.standing &&
  agent.kind !== 'editor' &&
  isOpenImplicit(item) &&
  madeCard(agent, item);

/** The earlier run's card is on this start's repo and branch. */
const isSameWork = (item: Item, query: RelatedQuery): boolean =>
  sameOrBothNone(item.repo ?? null, query.repo) && branchesAgree(item.branch ?? null, query.branch);

/** When the run last did anything, in ms; 0 for a run with no time. */
const activityMs = (agent: LedgerAgent): number => lastActivity(agent)?.getTime() ?? 0;

const relatedOf = (agent: LedgerAgent, item: Item, activeAt: number, now: Date) => ({
  run: agent.name,
  card: item.id,
  title: item.title,
  minutesAgo: Math.max(0, Math.round((now.getTime() - activeAt) / 60_000)),
  at: activeAt,
});

export function relatedRuns(query: RelatedQuery): RelatedRun[] {
  const byId = new Map(query.items.map((item) => [item.id, item]));
  const since = query.now.getTime() - RELATED_RUN_HOURS * 3_600_000;
  const found = new Map<string, RelatedRun & { at: number }>();
  for (const agent of query.agents) {
    const item = agent.card ? byId.get(agent.card) : undefined;
    const activeAt = activityMs(agent);
    if (!isEarlierNoCardRun(agent, query, item) || activeAt < since || !isSameWork(item, query)) {
      continue;
    }
    if ((found.get(item.id)?.at ?? 0) < activeAt) {
      found.set(item.id, relatedOf(agent, item, activeAt, query.now));
    }
  }
  return [...found.values()]
    .sort((first, second) => second.at - first.at)
    .slice(0, RELATED_MAX)
    .map(({ at: _sort, ...rest }) => rest);
}
