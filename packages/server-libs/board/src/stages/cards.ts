/** The cards: a session that is not on a branch of its own, a work (PR or branch), and where each sits in the columns. */
import { branchKey, canonicalRepo } from '@once-upon-a-diff/terms/ids';
import { hasRepoAndBranch } from '@once-upon-a-diff/terms/repo-branch';
import { isAutoDone } from '@once-upon-a-diff/core/features/review/story-lists';
import { findTree, type WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import { requestFor } from '@once-upon-a-diff/state/queues/requests/progress';
import { columnOf } from '../columns.ts';
import type {
  BoardCard,
  BoardSession,
  InboxLocalStory,
  InboxStory,
  PrInfo,
} from '@once-upon-a-diff/contracts/types';
import { gateText, plural, shortSha } from '@once-upon-a-diff/terms/text';
import type { Moved } from './moved.ts';
import type { LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { laneOf } from './lanes.ts';
import { MERGED_HOURS } from './works.ts';
import { NO_PARENT } from './agents.ts';
import type { BuildContext, SessionView, StoryFacts, Work } from './types.ts';
import type { Launched } from './dispatching.ts';
import { prUrl } from '@once-upon-a-diff/terms/github-urls';

/**
 * A card for a session that is not on a branch of its own. `placed` is the repo and branch its runs' card is on, when they
 * name one: the card sits there (so that card's started item and runs ride on it) while the session's view keeps its checkout.
 */
export function sessionCard(
  session: LiveSession,
  view: SessionView,
  repo: string | null,
  placed?: { repo: string | null; branch: string },
): BoardCard {
  const where = placed ?? { repo, branch: view.card.branch };
  return {
    id: session.session,
    kind: 'session',
    title: view.card.title,
    repo: where.repo,
    branch: where.branch,
    lane: laneOf(session.cwd, where.repo),
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
  /** the newest local story's checkout for each repo and branch, for a PR card's commits-ahead count */
  localCheckouts: Map<string, { story: string; checkout: string }>;
  /** the local stories by id, for the story an ahead card shows */
  localById: Map<string, InboxLocalStory>;
  /** the worktrees the scanner knows, for the commits-ahead count of a branch with no local story */
  trees: WorktreeFacts[];
}

/**
 * A PR card's commits ahead of origin: as the checkout of a local story of its branch has them, else (no local story: a PR
 * story only, or an author's commit before any story) the worktree on the branch, when the scanner counts commits it has not
 * pushed. The scanner's count is only the gate and the answer until the look at origin comes back (Lookups.aheadFor).
 */
function aheadFor(
  ctx: BuildContext,
  facts: CardFacts,
  repo: string,
  branch: string,
): BoardCard['ahead'] {
  const found = facts.localCheckouts.get(branchKey(repo, branch));
  if (found) {
    return ctx.lookups.aheadFor(found, branch);
  }
  const tree = findTree(facts.trees, repo, branch);
  return tree?.unpushed
    ? ctx.lookups.aheadFor({ story: null, checkout: tree.path, count: tree.unpushed }, branch)
    : null;
}

/** How old GitHub's last answer about a PR can be before its card says so (5 x the watcher's 3 minute cache). */
export const UNCONFIRMED_MS = 15 * 60 * 1000;

/** The PR a work shows from what GitHub last said, a stub while it has not answered, or null for a work with no PR. */
function prOf(ctx: BuildContext, work: Work): PrInfo | null {
  if (!work.repo || !work.number) {
    return null;
  }
  const { nowMs } = ctx;
  // a merged PR past MERGED_HOURS is dropped below, so GitHub is not asked about it again
  const mergedMs = work.mergedAt ? Date.parse(work.mergedAt) : NaN;
  const cached = ctx.review.info(work.repo, work.number);
  if (cached?.state !== 'closed' && !(nowMs - mergedMs > MERGED_HOURS * 3600 * 1000)) {
    ctx.review.kickInfo(work.repo, work.number, nowMs);
  }
  const known = ctx.review.info(work.repo, work.number);
  if (known) {
    return known;
  }
  if (work.mergedAt) {
    return {
      ...stubPr(work.repo, work.number, work.title || '', work.branch),
      state: 'merged',
      merged_at: work.mergedAt,
    };
  }
  return stubPr(work.repo, work.number, work.title || `${work.repo}#${work.number}`, work.branch);
}

/** Whether a PR is closed, or merged longer ago than MERGED_HOURS: nothing of it is shown. */
function isOver(pr: PrInfo, nowMs: number): boolean {
  if (pr.state === 'closed') {
    return true;
  }
  if (pr.state !== 'merged') {
    return false;
  }
  const mergedMs = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
  return Number.isNaN(mergedMs) || nowMs - mergedMs > MERGED_HOURS * 3600 * 1000;
}

/** What a session is doing for the work's story: building, rebuilding or fixing for it (claimed), or a skeleton still being written. */
function buildingOf(
  ctx: BuildContext,
  work: Work,
  story: InboxStory | InboxLocalStory | null,
): BoardCard['building'] {
  // a session is building, rebuilding or fixing for it (claimed): the PR sits in Working, whatever the sessions' branches
  const request =
    work.repo && work.number
      ? requestFor(ctx.home, ctx.builds, {
          repo: work.repo,
          number: work.number,
          story: work.story?.id ?? null,
        })
      : null;
  if (request?.state === 'building') {
    return { kind: request.kind, since: request.claimed_at, by: request.claimed_by };
  }
  // a story published as a skeleton is still being written: it is not built until every chapter has its text
  if (story && (story.unwritten ?? 0) > 0) {
    return { kind: 'write', since: story.built_at, by: null };
  }
  return null;
}

/** A local story alone (no session, no PR) is a card only while there is something to review in it. */
function localToReview(
  facts: CardFacts,
  work: Work,
  story: InboxStory | InboxLocalStory | null,
): boolean {
  if (!story || story !== work.local) {
    return false;
  }
  return (
    !story.reviewed_at ||
    unreadOf(story) ||
    !!(story as InboxLocalStory).approved_at ||
    !!facts.unreadById.get(story.id)
  );
}

/** The card's view of its story. */
function storyView(
  story: InboxStory | InboxLocalStory | null,
  facts: CardFacts,
): BoardCard['story'] {
  if (!story) {
    return null;
  }
  return {
    id: story.id,
    kind: 'number' in story ? ('pr' as const) : ('local' as const),
    url: 'number' in story ? story.url : null,
    reviewed: !!story.reviewed_at,
    // built after you last opened or reviewed it (never opened: it is ready for review, not back to you)
    unread: unreadOf(story),
    unread_answers: facts.unreadById.get(story.id) ?? 0,
    approved_at: 'number' in story ? null : story.approved_at,
    ...(isStorylessReview(story) ? { storyless: true as const } : {}),
  };
}

/** Whether the card's PR is old: GitHub never answered about it, or hasn't lately (a loaded answer is judged by its own age). */
function isUnconfirmed(ctx: BuildContext, work: Work, pr: PrInfo | null): boolean {
  if (pr?.state !== 'open' || !work.repo || !work.number) {
    return false;
  }
  const answeredAt = ctx.review.infoAt(work.repo, work.number);
  return (
    answeredAt !== undefined && (answeredAt === null || ctx.nowMs - answeredAt > UNCONFIRMED_MS)
  );
}

/** An open PR's commits ahead of origin, from the checkout of a local story of its branch or the worktree on it. */
function openPrAhead(
  ctx: BuildContext,
  facts: CardFacts,
  work: Work,
  pr: PrInfo | null,
  branch: string | null | undefined,
): BoardCard['ahead'] {
  if (pr?.state !== 'open' || !branch || !work.repo) {
    return null;
  }
  return aheadFor(ctx, facts, work.repo, branch);
}

/** While your own PR's branch is ahead, the local story of that branch stands for the card: it is the one to review and approve. */
function aheadStoryOf(
  facts: CardFacts,
  ahead: BoardCard['ahead'],
  pr: PrInfo | null,
): InboxLocalStory | undefined {
  return ahead?.story && pr?.mine ? facts.localById.get(ahead.story) : undefined;
}

/** A card for a work, or null when there is nothing left to show on it (a PR closed, or merged long ago, with no session). */
function workCard(ctx: BuildContext, facts: CardFacts, work: Work): BoardCard | null {
  let pr = prOf(ctx, work);
  let story: InboxStory | InboxLocalStory | null = work.story ?? work.local;
  if (pr && isOver(pr, ctx.nowMs)) {
    pr = null;
    story = null;
  }
  const building = buildingOf(ctx, work, story);
  if (pr && !isShown(pr, { story: !!story || work.built, building: !!building })) {
    // someone else's PR with nothing for you in it: not on the board, though a session of yours on its branch still is
    pr = null;
    story = null;
  }
  const branch = work.branch ?? pr?.branch;
  const ahead = openPrAhead(ctx, facts, work, pr, branch);
  story = aheadStoryOf(facts, ahead, pr) ?? story;
  const known =
    (!!pr && (pr.mine || pr.review_requested || !!story || work.built || !!building)) ||
    localToReview(facts, work, story);
  if (!work.sessions.length && !known) {
    return null;
  }
  const sessions = work.sessions.map((view) => view.card);
  const repo = work.repo;
  return {
    id: work.key,
    kind: 'work',
    title: pr?.title || story?.title || work.branch || work.key,
    repo,
    branch: branch ?? null,
    lane: canonicalRepo(repo) ?? NO_PARENT,
    column: 'idle',
    detail: null,
    since: null,
    pr,
    ...(isUnconfirmed(ctx, work, pr) ? { pr_unconfirmed: true as const } : {}),
    ahead,
    story: storyView(story, facts),
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

/** A local story that is a storyless review (a by-folder local story): Build story still tells one. */
export function isStorylessReview(story: InboxLocalStory | InboxStory | null): boolean {
  return !!story && !('number' in story) && !!story.storyless;
}

/** A storyless review's card's branch and checkout, so Review can re-pin it when no session is on the branch. */
function storylessCheckout(
  facts: CardFacts,
  story: InboxLocalStory | InboxStory | null,
  pr: PrInfo | null,
  repo: string | null,
  branch: string | null,
): { review: { branch: string; path: string } } | null {
  const where = { repo, branch };
  if (!isStorylessReview(story) || pr || !hasRepoAndBranch(where)) {
    return null;
  }
  const local = facts.localCheckouts.get(branchKey(where.repo, where.branch));
  return local ? { review: { branch: where.branch, path: local.checkout } } : null;
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

/** What a card's column is worked out from (columns.ts columnOf). */
function columnInputOf(
  card: BoardCard,
  built: StoryFacts | undefined,
  moved: Moved | undefined,
  launched: Launched | undefined,
): Parameters<typeof columnOf>[0] {
  // an auto-mark carries the time the bridge noticed, so only a mark by hand counts as your activity
  const manual =
    built?.reviewed_at && built.reviewed_by === 'manual' ? Date.parse(built.reviewed_at) : null;
  return {
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
          landed: !!card.landed,
        }
      : null,
    building: !!card.building,
    moved: !!moved,
    ahead: !!card.ahead && card.pr?.state === 'open' && card.pr.mine,
    launched: launched && { running: launched.running.length },
  };
}

/** What a card in Waiting says: the session's question, from when it started waiting. */
function placeWaiting(card: BoardCard): void {
  const asking = card.sessions.find((session) => session.status === 'waiting');
  const waitingAgent = card.agents.find((agent) => agent.state === 'waiting' && !agent.review);
  card.detail = asking?.detail || null;
  card.since = earliest([
    ...card.sessions.filter((one) => one.status === 'waiting').map((one) => one.since),
    waitingAgent?.ended_at,
  ]);
}

/** A failed agent on the card says which one and since when; a session-only error keeps the session's own line. */
function placeError(card: BoardCard): void {
  const failedAgent = card.agents.find((agent) => agent.state === 'failed');
  card.detail = failedAgent ? `${failedAgent.name} failed` : card.sessions[0]?.detail || null;
  card.since = failedAgent ? failedAgent.ended_at : (card.sessions[0]?.since ?? null);
}

/** A card in Checks names its gates. */
function placeChecks(card: BoardCard): void {
  const gated = card.agents.filter((agent) => agent.gate);
  card.detail = gated.map(gateText).join(', ');
  card.since = earliest(
    gated.map((agent) =>
      agent.gate?.kind === 'review' || agent.gate?.kind === 'story'
        ? agent.started_at
        : agent.ended_at,
    ),
  );
}

/** A card in Working says what is going on: a build, a session's line, the move past its story, or the agents it launched. */
function placeWorking(
  card: BoardCard,
  moved: Moved | undefined,
  launched: Launched | undefined,
): void {
  const busy = card.sessions.find((session) => session.status === 'working');
  card.detail = card.building
    ? BUILDING_TEXT[card.building.kind]
    : busy?.detail || (moved ? movedText(moved) : null) || launchedText(launched);
  card.since = earliest([
    card.building?.since,
    ...(launched?.running ?? []).map((one) => one.started?.toISOString()),
    ...card.sessions.filter((one) => one.status === 'working').map((one) => one.since),
    ...card.agents.filter((one) => one.state === 'running').map((one) => one.started_at),
  ]);
}

/** A card in Ready only because an agent says [review] (no story on it yet) says so, from the agent's line. */
function placeReady(card: BoardCard, built: StoryFacts | undefined): void {
  const parked = card.agents.find((agent) => agent.review);
  card.since = built?.built_at ?? parked?.ended_at ?? null;
  if (!built && parked) {
    card.detail = parked.outcome;
  }
}

/** Sets a session or work card's column, detail and `since`, once its agents are on it. */
function placeCard(
  card: BoardCard,
  byStory: Map<string, StoryFacts>,
  moved: Moved | undefined,
  launched: Launched | undefined,
): void {
  const built = card.story ? byStory.get(card.story.id) : undefined;
  card.column = columnOf(columnInputOf(card, built, moved, launched));
  switch (card.column) {
    case 'waiting':
      placeWaiting(card);
      break;
    case 'error':
      placeError(card);
      break;
    case 'checks':
      placeChecks(card);
      break;
    case 'working':
      placeWorking(card, moved, launched);
      break;
    case 'done':
    case 'ship':
      card.since = card.landed?.at ?? card.pr?.merged_at ?? card.story?.approved_at ?? null;
      break;
    case 'back':
      card.since = card.pr?.others_at ?? null;
      break;
    case 'ready':
      placeReady(card, built);
      break;
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

/** What a session's card says when it is Working only because agents it launched run: how many, and the first few by name. */
function launchedText(launched: Launched | undefined): string | null {
  const running = launched?.running ?? [];
  if (!running.length) {
    return null;
  }
  const names = running.slice(0, 3).map((one) => one.name);
  return `${plural(running.length, 'agent')} running: ${names.join(', ')}${running.length > 3 ? ', …' : ''}`;
}

/** What a card says when it is Working only because its branch moved past its story (stages/moved.ts). */
const MOVED_TEXT = 'branch moved past its story';
const OUTSIDE_TEXT = 'changed outside a run';

/** The detail of a moved card: no run behind the tip, a finished fixer behind it (the story needs retelling), or a run still going. */
const movedText = ({ covering }: Moved): string => {
  if (!covering) {
    return OUTSIDE_TEXT;
  }
  return covering.state === 'done' && covering.result?.commit
    ? `fixed in ${shortSha(covering.result.commit)}, story not retold`
    : MOVED_TEXT;
};

/**
 * Sets each session or work card's column, detail and `since`, once its agents are on it. `moved` holds the cards whose branch
 * moved past their story's told commit (stages/moved.ts); `launched` the agents each session launched (stages/dispatching.ts).
 */
export function placeCards(
  cards: BoardCard[],
  byStory: Map<string, StoryFacts>,
  moved: Map<BoardCard, Moved> = new Map(),
  launched: Map<string, Launched> = new Map(),
): void {
  for (const card of cards) {
    if (card.kind !== 'agent') {
      const move = moved.get(card);
      // only a session's own card counts the agents it launched: a work card has its agents nested in it already
      placeCard(
        card,
        byStory,
        move,
        card.kind === 'session' ? launched.get(card.id.slice(0, 8)) : undefined,
      );
      if (move && !move.covering && card.column === 'working' && card.repo && card.branch) {
        card.outside = { sha: move.tip, branch: card.branch, repo: card.repo, path: move.path };
      }
    }
  }
}
