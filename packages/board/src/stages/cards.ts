/** The cards: a session that is not on a branch of its own, a work (PR or branch), and where each sits in the columns. */
import { isAutoDone } from '@once-upon-a-diff/core/features/review/story-lists';
import { requestFor } from '@once-upon-a-diff/state/queues/requests/progress';
import { columnOf } from '../columns.ts';
import type {
  BoardCard,
  BoardSession,
  InboxLocalStory,
  InboxStory,
  PrInfo,
  ShipMode,
} from '@once-upon-a-diff/contracts/types';
import { gateText } from '@once-upon-a-diff/domain/text';
import type { LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { laneOf } from './lanes.ts';
import { MERGED_HOURS } from './works.ts';
import { NO_PARENT } from './agents.ts';
import type { BuildContext, SessionView, StoryFacts, Work } from './types.ts';
import { prUrl } from '@once-upon-a-diff/domain/github-urls';

/** A card for a session that is not on a branch of its own. */
export function sessionCard(
  session: LiveSession,
  view: SessionView,
  repo: string | null,
): BoardCard {
  return {
    id: session.session,
    kind: 'session',
    title: view.card.title,
    repo,
    branch: view.card.branch,
    lane: laneOf(session.cwd, repo),
    column: 'idle',
    detail: null,
    since: null,
    pr: null,
    story: null,
    building: null,
    sessions: [view.card],
    agents: [],
    parent: null,
    focus_session: view.card.id,
    can_focus: view.card.focus,
    listening: null,
    build: null,
  };
}

/**
 * Whose PRs the board shows: the ones you authored (the signed-in gh user's), and other people's only when something is
 * for you in them: a story built for you, a review GitHub is waiting on you for, or a session of yours building for
 * them. Someone else's draft is never shown, whatever else is for you in it: it is not ready for anyone's review, and it
 * comes back when it is marked ready (a session of yours on its branch keeps its own card). A PR GitHub hasn't described
 * yet has no author and is let through, so a session's card doesn't flicker; with no session on it, it waits for its
 * author (workCard). The one place to change what the board covers.
 */
const isShown = (pr: PrInfo, forYou: { story: boolean; building: boolean }): boolean =>
  pr.author === null ||
  pr.mine ||
  (!pr.draft && (pr.review_requested || forYou.story || forYou.building));

/** Built after you last opened or reviewed it (never opened: it is ready for review, not back to you). */
const isUnread = (story: Pick<InboxStory, 'built_at' | 'seen_at'>): boolean =>
  !!story.seen_at && Date.parse(story.built_at) > Date.parse(story.seen_at);

/**
 * Whether a story was built after you last opened it. A local story marked done by a check (its branch has a PR, it is in
 * the default branch, or it went idle) stays done through a rebuild: its work has left, or nobody is looking.
 */
const unreadOf = (story: InboxStory | InboxLocalStory): boolean =>
  isUnread(story) && ('number' in story || !isAutoDone(story));

/** What GitHub hasn't told yet about an open PR: just its number, so the card can sit in the PR open column. */
const stubPr = (repo: string, number: number, title: string, branch: string | null): PrInfo => ({
  number,
  url: prUrl(repo, number),
  title,
  state: 'open',
  draft: false,
  branch,
  author: null,
  mine: false,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
});

const earliest = (times: (string | null | undefined)[]): string | null =>
  times.filter((time): time is string => !!time).sort()[0] ?? null;

/** What the cards read of the stories, worked out once per build (works.ts reads the stories, the inbox the answers). */
export interface CardFacts {
  /** each story's questions whose answer you haven't read */
  unreadById: Map<string, number>;
  /** how each approved local story ships */
  shipById: Map<string, ShipMode>;
  /** the newest local story's checkout for each repo and branch, for a PR card's commits-ahead count */
  localCheckouts: Map<string, { story: string; checkout: string }>;
}

/** A PR card's commits ahead of origin, as the checkout of a local story of its branch has them: null when the branch has no local story. */
function aheadFor(
  ctx: BuildContext,
  localCheckouts: CardFacts['localCheckouts'],
  repo: string,
  branch: string,
): BoardCard['ahead'] {
  const found = localCheckouts.get(`${repo.toLowerCase()}@${branch}`);
  return found ? ctx.lookups.aheadFor(found, branch) : null;
}

/** A card for a work, or null when there is nothing left to show on it (a PR closed, or merged long ago, with no session). */
export function workCard(ctx: BuildContext, facts: CardFacts, work: Work): BoardCard | null {
  const { nowMs } = ctx;
  let pr: PrInfo | null = null;
  let story: InboxStory | InboxLocalStory | null = work.story ?? work.local;
  if (work.repo && work.number) {
    // a merged PR past MERGED_HOURS is dropped below, so GitHub is not asked about it again
    const mergedMs = work.mergedAt ? Date.parse(work.mergedAt) : NaN;
    if (!(nowMs - mergedMs > MERGED_HOURS * 3600 * 1000)) {
      ctx.review.kickInfo(work.repo, work.number, nowMs);
    }
    pr =
      ctx.review.info(work.repo, work.number) ||
      (work.mergedAt
        ? {
            ...stubPr(work.repo, work.number, work.title || '', work.branch),
            state: 'merged',
            merged_at: work.mergedAt,
          }
        : stubPr(work.repo, work.number, work.title || `${work.repo}#${work.number}`, work.branch));
  }
  if (pr?.state === 'merged') {
    const mergedMs = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
    if (Number.isNaN(mergedMs) || nowMs - mergedMs > MERGED_HOURS * 3600 * 1000) {
      pr = null;
      story = null;
    }
  } else if (pr?.state === 'closed') {
    pr = null;
    story = null;
  }
  // a session is building, rebuilding or fixing for it (claimed): the PR sits in Working, whatever the sessions' branches
  const request =
    work.repo && work.number
      ? requestFor(ctx.home, ctx.builds, {
          repo: work.repo,
          number: work.number,
          story: work.story?.id ?? null,
        })
      : null;
  const claimed = request?.state === 'building' ? request : null;
  // a story published as a skeleton is still being written: it is not built until every chapter has its text
  let building: BoardCard['building'] = null;
  if (claimed) {
    building = { kind: claimed.kind, since: claimed.claimed_at, by: claimed.claimed_by };
  } else if (story && (story.unwritten ?? 0) > 0) {
    building = { kind: 'write', since: story.built_at, by: null };
  }
  if (pr && !isShown(pr, { story: !!story || work.built, building: !!building })) {
    // someone else's PR with nothing for you in it: not on the board, though a session of yours on its branch still is
    pr = null;
    story = null;
  }
  // a local story alone (no session, no PR) is a card only while there is something to review in it
  const localToReview =
    !!story &&
    story === work.local &&
    (!story.reviewed_at ||
      unreadOf(story) ||
      !!(story as InboxLocalStory).approved_at ||
      !!facts.unreadById.get(story.id));
  const known =
    (!!pr && (pr.mine || pr.review_requested || !!story || work.built || !!building)) ||
    localToReview;
  if (!work.sessions.length && !known) {
    return null;
  }
  const sessions = work.sessions.map((view) => view.card);
  const repo = work.repo;
  const lane = repo ?? NO_PARENT;
  return {
    id: work.key,
    kind: 'work',
    title: pr?.title || story?.title || work.branch || work.key,
    repo,
    branch: work.branch ?? pr?.branch ?? null,
    lane,
    column: 'idle',
    detail: null,
    since: null,
    pr,
    ahead:
      pr?.state === 'open' && (work.branch ?? pr.branch) && work.repo
        ? aheadFor(ctx, facts.localCheckouts, work.repo, (work.branch ?? pr.branch) as string)
        : null,
    story: story
      ? {
          id: story.id,
          kind: 'number' in story ? ('pr' as const) : ('local' as const),
          url: 'number' in story ? story.url : null,
          reviewed: !!story.reviewed_at,
          // built after you last opened or reviewed it (never opened: it is ready for review, not back to you)
          unread: unreadOf(story),
          unread_answers: facts.unreadById.get(story.id) ?? 0,
          approved_at: 'number' in story ? null : story.approved_at,
          ship: 'number' in story ? null : (facts.shipById.get(story.id) ?? null),
          ...(!('number' in story) && story.storyless ? { storyless: true as const } : {}),
        }
      : null,
    building,
    sessions,
    agents: [],
    parent: null,
    ...focusOf(sessions),
    listening: null,
    build: null,
    // a storyless review's checkout, for Review again (listeners.ts reviewFor keeps it while it applies)
    ...(storylessCheckout(facts, story, pr, repo, work.branch) ?? {}),
  };
}

/** A storyless review's card's branch and checkout, so Review can re-pin it when no session is on the branch. */
function storylessCheckout(
  facts: CardFacts,
  story: InboxLocalStory | InboxStory | null,
  pr: PrInfo | null,
  repo: string | null,
  branch: string | null,
): { review: { branch: string; path: string } } | null {
  if (!story || 'number' in story || !story.storyless || pr || !repo || !branch) {
    return null;
  }
  const local = facts.localCheckouts.get(`${repo.toLowerCase()}@${branch}`);
  return local ? { review: { branch, path: local.checkout } } : null;
}

/** What the card says while a session works on the PR's story. */
const BUILDING_TEXT = {
  build: 'building story',
  update: 'updating story',
  rebuild: 'rebuilding story',
  fix: 'fixing the code',
  write: 'writing story',
} as const;

/** The session a click on a card brings to the front: one waiting on you, else a busy one, else the first. */
function focusOf(sessions: BoardSession[]): { focus_session: string | null; can_focus: boolean } {
  const pick =
    sessions.find((session) => session.status === 'waiting') ||
    sessions.find((session) => session.status === 'working') ||
    sessions.find((session) => session.focus) ||
    sessions[0];
  return { focus_session: pick?.id ?? null, can_focus: pick?.focus ?? false };
}

/** Sets a session or work card's column, detail and `since`, once its agents are on it. */
function placeCard(card: BoardCard, byStory: Map<string, StoryFacts>): void {
  const built = card.story ? byStory.get(card.story.id) : undefined;
  // an auto-mark carries the time the bridge noticed, so only a mark by hand counts as your activity
  const manual =
    built?.reviewed_at && built.reviewed_by === 'manual' ? Date.parse(built.reviewed_at) : null;
  card.column = columnOf({
    sessions: card.sessions,
    agents: card.agents,
    pr: card.pr,
    story: card.story
      ? {
          reviewed: card.story.reviewed,
          manualReviewedAt: manual,
          unread: card.story.unread,
          answered: card.story.unread_answers,
          local: card.story.kind === 'local',
          approved: !!card.story.approved_at,
        }
      : null,
    building: !!card.building,
  });
  const asking = card.sessions.find((session) => session.status === 'waiting');
  const waitingAgent = card.agents.find((agent) => agent.state === 'waiting' && !agent.review);
  const failedAgent = card.agents.find((agent) => agent.state === 'failed');
  const busy = card.sessions.find((session) => session.status === 'working');
  switch (card.column) {
    case 'waiting':
      card.detail =
        asking?.detail || (!waitingAgent && failedAgent ? `${failedAgent.name} failed` : null);
      card.since = earliest([
        ...card.sessions.filter((one) => one.status === 'waiting').map((one) => one.since),
        waitingAgent?.ended_at,
        ...(asking || waitingAgent || !failedAgent ? [] : [failedAgent.ended_at]),
      ]);
      break;
    case 'checks': {
      const gated = card.agents.filter((agent) => agent.gate);
      card.detail = gated.map(gateText).join(', ');
      card.since = earliest(
        gated.map((agent) => (agent.gate?.kind === 'review' ? agent.started_at : agent.ended_at)),
      );
      break;
    }
    case 'working':
      card.detail = card.building ? BUILDING_TEXT[card.building.kind] : busy?.detail || null;
      card.since = earliest([
        card.building?.since,
        ...card.sessions.filter((one) => one.status === 'working').map((one) => one.since),
        ...card.agents.filter((one) => one.state === 'running').map((one) => one.started_at),
      ]);
      break;
    case 'done':
    case 'ship':
      card.since = card.pr?.merged_at ?? card.story?.approved_at ?? null;
      break;
    case 'back':
      card.since = card.pr?.others_at ?? null;
      break;
    case 'ready': {
      // a card in Ready only because an agent says [review] (no story on it yet) says so, from the agent's line
      const parked = card.agents.find((agent) => agent.review);
      card.since = built?.built_at ?? parked?.ended_at ?? null;
      if (!built && parked) {
        card.detail = parked.outcome;
      }
      break;
    }
    default:
      card.detail = card.sessions[0]?.detail || null;
      card.since = card.sessions[0]?.since ?? null;
  }
}

/** The cards of the works, after the sessions' own: PR details from what GitHub last said. A work with nothing left to show has none. */
export function buildCards(
  ctx: BuildContext,
  facts: CardFacts,
  works: Map<string, Work>,
  sessionCards: BoardCard[],
): BoardCard[] {
  const cards: BoardCard[] = [...sessionCards];
  for (const work of works.values()) {
    const card = workCard(ctx, facts, work);
    if (card) {
      cards.push(card);
    }
  }
  return cards;
}

/** Sets each session or work card's column, detail and `since`, once its agents are on it. */
export function placeCards(cards: BoardCard[], byStory: Map<string, StoryFacts>): void {
  for (const card of cards) {
    if (card.kind !== 'agent') {
      placeCard(card, byStory);
    }
  }
}
