/**
 * Which column a card goes in: the work moves left to right to merge. The first that fits:
 *
 *   waiting   a session or agent on it is blocked on a question (an agent parked on your story review is not: see ready), or
 *             an agent on it failed (after merged: a failure on a merged card is not news)
 *   checks    an agent on it is at an automated gate (a plan to check, a critic running, a storyteller writing the story,
 *             findings being fixed): the
 *             launching session is the next actor, not you. Above working, because the session is busy exactly while it
 *             checks the plan or fixes the findings, and a running critic is a running agent
 *   working   a session or agent on it is busy, or a session is building, rebuilding or fixing its story, or (a session's own
 *             card) an agent it launched is running, wherever that agent sits
 *   done      the PR merged, or its card landed (`once-upon backlog done`) with no PR: a local story whose work reached the
 *             default branch some other way than a merge you can see (a cherry-pick). The board drops it an hour later
 *   ship      a local story you approved for its current head: ready to ship, with no PR yet and still on this Mac (a new
 *             commit clears the approval; the board drops it after APPROVED_DAYS). Also, with no approval needed (set by
 *             stages/agents.ts and cardPhase, not here): finished work on a branch that is pushed, with GitHub saying it has no PR
 *   back      something is on you: its PR story has a version you haven't opened since it was built (a rebuild, say), or
 *             an unread answer to a question you asked in the story of your own PR, or
 *             someone asked something of you on the PR after your last activity (on your own PR: changes requested, or
 *             an open thread whose last comment is theirs; on someone else's: a reply in an open thread you are in),
 *             or GitHub is waiting on your review
 *   ready     its story is built, it has no PR yet, and you haven't reviewed it, or an agent on it says `[review]` ("done" is not done until you've seen
 *             it), or (set by stages/agents.ts on an agent's own card) a finished author's commit is on a branch with no PR
 *             that is not merged and not pushed yet (pushed with no PR is ship, ready.ts). It is the Mac's side: a card with a PR, whoever wrote it and whatever story it has, is on GitHub's
 *             (back or pr_open). A rebuild of a local story since you opened it is a chip on its card
 *   pr_open   pushed with a PR, and nothing waits on you
 *   thinking  a research agent still running with no card to sit in (set by stages/agents.ts on an agent's own card), or a busy
 *             session with no author or fixer run open under its id that is not on a work card (its `thinking` flag, set where the sessions are
 *             placed: a registered one (`agent start --self`) joins no work's card, and one on a branch's work stays on it, so a
 *             work card is never in it)
 *   research  a finished research agent with no card to sit in and no result (set by stages/agents.ts on an agent's own card;
 *             a work card is never in it), or a session that was Thinking and went idle within the finished-agent timer (its
 *             `researched` flag, set where the sessions are placed; never one that launched agents)
 *   error     a session whose tab says error
 *   idle      nothing is happening and there is no PR: a session at its prompt (a lane along the bottom of the page)
 *
 * A card that would be in ready, but whose branch has moved past the commit its story was told over (a new commit or an
 * amend, not a pure rebase: stages/moved.ts) is in working instead: someone is still changing what you were to review. The
 * story's told commit is back in step after a retell, which puts the card back in ready.
 *
 * A card in Back to you clears when you mark its story reviewed, open it (the panel records where you stopped and what
 * you read), submit your review on GitHub, or the auto-review rules fire.
 */
import { hasRepoAndBranch } from '@once-upon-a-diff/terms/repo-branch';
import type {
  BoardAgent,
  BoardCard,
  BoardColumn,
  BoardSession,
  PrInfo,
} from '@once-upon-a-diff/contracts/types';

export interface ColumnInput {
  sessions: Pick<BoardSession, 'status' | 'thinking' | 'researched'>[];
  agents: (Pick<BoardAgent, 'status' | 'state'> & {
    kind?: BoardAgent['kind'];
    stale?: boolean;
    gate?: BoardAgent['gate'];
    review?: boolean;
  })[];
  pr: PrInfo | null;
  /**
   * The built PR story: whether you have reviewed it, when you marked it by hand (ms; an auto-mark carries the time the
   * bridge noticed, so it doesn't count as your activity), and whether it was built after you last opened or reviewed
   * it (`unread`: false when you have never opened it, which is "ready for your review", not "back to you").
   */
  story: {
    reviewed: boolean;
    manualReviewedAt: number | null;
    unread: boolean;
    /** a local story (no PR): it waits in Ready for your review, never in Back to you, which is the GitHub side's */
    local?: boolean;
    /** a local story approved for its current head (Approve on its page): ready to ship, so Ready to ship while it has no PR */
    approved?: boolean;
    /** questions you asked in the story whose answers you haven't read: Claude handed something back, so Back to you on your own PR (Ready with no PR); on someone else's PR it is only a chip */
    answered?: number;
    /** its card landed (`backlog done`): a local story with no PR is Done, approved or not */
    landed?: boolean;
  } | null;
  /** a session is building, rebuilding or fixing for it */
  building?: boolean;
  /** a session's own card: how many agents it launched are running now (stages/dispatching.ts), which keep it Working below a question or a gate */
  launched?: { running: number };
  /** the branch has moved past the commit the story was told over (stages/moved.ts): a card that would be Ready is Working */
  moved?: boolean;
}

/** When you last acted on the PR (ms): on GitHub, or by marking its story reviewed by hand. null when there is no sign. */
function baselineOf({ pr, story }: Pick<ColumnInput, 'pr' | 'story'>): number | null {
  const times = [
    pr?.viewer_at ? Date.parse(pr.viewer_at) : null,
    story?.manualReviewedAt ?? null,
  ].filter((time): time is number => time !== null && !Number.isNaN(time));
  return times.length ? Math.max(...times) : null;
}

/** Whether someone asked something of you since your last activity (needs a sign of that activity to compare with). */
export function isBackToYou(input: Pick<ColumnInput, 'pr' | 'story'>): boolean {
  const baseline = baselineOf(input);
  const others = input.pr?.others_at ? Date.parse(input.pr.others_at) : NaN;
  return baseline !== null && !Number.isNaN(others) && others > baseline;
}

/** A card's story that is a local one (no PR story). */
type LocalStory = NonNullable<BoardCard['story']> & { kind: 'local' };

/**
 * A card with a local story and no PR: the Mac's side, before GitHub has the work. Whether it is Ready, Ready to ship or Done
 * is `columnOf`'s call; this is only the shape they share.
 */
export function isLocalStoryCard<T extends Pick<BoardCard, 'story' | 'pr'>>(
  card: T,
): card is T & { story: LocalStory; pr: null } {
  return card.story?.kind === 'local' && !card.pr;
}

/**
 * A card that could be Ready, which is the cards whose branch can have moved past what you were to review (stages/moved.ts): a
 * work or session card with a local story and no PR, on a repo and branch, not landed, not approved (that is Ready to ship), and
 * not reviewed (or reviewed with an answer still unread). `columnOf` has other ways into Ready (an agent's `[review]`, a story
 * that is unread though reviewed) that are not about a moving branch, so this is the narrower rule, not a copy of it.
 */
export function couldBeReady(
  card: BoardCard,
): card is BoardCard & { story: LocalStory; pr: null; repo: string; branch: string } {
  return (
    card.kind !== 'agent' &&
    isLocalStoryCard(card) &&
    !card.landed &&
    !card.story.approved_at &&
    (!card.story.reviewed || !!card.story.unread_answers) &&
    hasRepoAndBranch(card)
  );
}

/** A local story whose card landed (`backlog done`) with no PR: Done, approved or not. */
export function isLandedLocal({ story, pr }: Pick<ColumnInput, 'story' | 'pr'>): boolean {
  return !!story?.local && !!story.landed && !pr;
}

/** A local story approved for its current head, with no PR yet: ready to ship. */
export function isApprovedLocal({ story, pr }: Pick<ColumnInput, 'story' | 'pr'>): boolean {
  return !!story?.local && !!story.approved && !pr;
}

/** The column of a card that is being worked on or waits on an answer: Waiting, Checks, Working or Thinking, else null. */
function inProgressColumn({
  sessions,
  agents,
  building,
  launched,
}: ColumnInput): BoardColumn | null {
  if (
    sessions.some((session) => session.status === 'waiting') ||
    agents.some((agent) => agent.state === 'waiting' && !agent.review)
  ) {
    return 'waiting';
  }
  if (agents.some((agent) => agent.gate)) {
    return 'checks';
  }
  if (
    building ||
    (launched?.running ?? 0) > 0 ||
    sessions.some((session) => session.status === 'working' && !session.thinking) ||
    // a storyteller silent for an hour is dead: it is not working, and holds no gate (stages/agents.ts)
    agents.some(
      (agent) => agent.state === 'running' && !(agent.kind === 'storyteller' && agent.stale),
    )
  ) {
    return 'working';
  }
  if (sessions.some((session) => session.status === 'working' && session.thinking)) {
    return 'thinking';
  }
  return null;
}

/** The column a story puts its card in (Ready, or back to you) while its work has no PR or the PR is yours, else null. */
function storyColumn(input: ColumnInput): BoardColumn | null {
  const { agents, pr, story, moved } = input;
  const ready = moved ? 'working' : 'ready';
  // an answer to a question you asked, unread: back to you on the GitHub side for your own PR, in Ready while there is
  // no PR. On someone else's PR the answer is a chip on the card, not a reason to leave PR open (you asked about their
  // code while reviewing it; the ball is theirs unless GitHub requests you or its story has a new version)
  // a stub PR (before GitHub says who wrote it) is not known to be yours: it stays in PR open, marked unconfirmed, until it fills in
  if (story?.answered && (!pr || pr.mine)) {
    return pr ? 'back' : ready;
  }
  // a story you have marked reviewed takes the card out of Ready even while the agent's [review] line stands
  if (!pr && !story?.reviewed && agents.some((agent) => agent.review)) {
    return ready;
  }
  // Ready for your review is the Mac's side: a story whose work has no PR. Once a PR exists (even with a local story
  // of its branch, or a PR story you haven't opened), the card follows the PR's rules on the GitHub side
  if (story?.unread) {
    if (!pr) {
      return ready;
    }
    if (!story.local) {
      return 'back';
    }
  }
  if (story && !story.reviewed && !pr) {
    return ready;
  }
  return null;
}

export function columnOf(input: ColumnInput): BoardColumn {
  const { sessions, agents, pr } = input;
  const active = inProgressColumn(input);
  if (active) {
    return active;
  }
  if (pr?.state === 'merged' || isLandedLocal(input)) {
    return 'done';
  }
  // a failed agent on the card (nested by its branch, PR or card, or the author on the card) is Error, as its own card is
  // (finishedColumn); an acknowledged one is no line on the card (runViews), so it never gets here
  if (agents.some((agent) => agent.state === 'failed')) {
    return 'error';
  }
  if (isApprovedLocal(input)) {
    return 'ship';
  }
  const fromStory = storyColumn(input);
  if (fromStory) {
    return fromStory;
  }
  if (pr) {
    return isBackToYou(input) || pr.review_requested ? 'back' : 'pr_open';
  }
  if (sessions.some((session) => session.status === 'error')) {
    return 'error';
  }
  // a side-tab session that finished a thinking turn is a finished research for a while (the Research timer)
  if (sessions.some((session) => session.researched)) {
    return 'research';
  }
  return 'idle';
}
