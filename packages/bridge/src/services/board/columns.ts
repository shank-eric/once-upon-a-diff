/**
 * Which column a card goes in: the work moves left to right to merge. The first that fits:
 *
 *   waiting   a session or agent on it is blocked on a question (an agent parked on your story review is not: see ready), or
 *             an agent on it failed (after merged: a failure on a merged card is not news)
 *   checks    an agent on it is at an automated gate (a plan to check, a critic running, findings being fixed): the
 *             launching session is the next actor, not you. Above working, because the session is busy exactly while it
 *             checks the plan or fixes the findings, and a running critic is a running agent
 *   working   a session or agent on it is busy, or a session is building, rebuilding or fixing its story
 *   done      the PR merged (the board drops it an hour later)
 *   ship      a local story you approved for its current head: ready to ship, with no PR yet and still on this Mac (a new
 *             commit clears the approval; the board drops it after APPROVED_DAYS)
 *   back      something is on you: its PR story has a version you haven't opened since it was built (a rebuild, say), or
 *             an unread answer to a question you asked in the story of your own PR, or
 *             someone asked something of you on the PR after your last activity (on your own PR: changes requested, or
 *             an open thread whose last comment is theirs; on someone else's: a reply in an open thread you are in),
 *             or GitHub is waiting on your review
 *   ready     its story is built, it has no PR yet, and you haven't reviewed it, or an agent on it says `[review]` ("done" is not done until you've seen
 *             it), or (set by stages/agents.ts on an agent's own card) a finished author's commit is on a branch with no PR
 *             that is not merged. It is the Mac's side: a card with a PR, whoever wrote it and whatever story it has, is on GitHub's
 *             (back or pr_open). A rebuild of a local story since you opened it is a chip on its card
 *   pr_open   pushed with a PR, and nothing waits on you
 *   research  a finished research agent with no card to sit in and no result (set by stages/agents.ts on an agent's own card,
 *             never by this function: a work card is never in it)
 *   error     a session whose tab says error
 *   idle      nothing is happening and there is no PR: a session at its prompt (a lane along the bottom of the page)
 *
 * A card in Back to you clears when you mark its story reviewed, open it (the panel records where you stopped and what
 * you read), submit your review on GitHub, or the auto-review rules fire.
 */
import type {
  BoardAgent,
  BoardColumn,
  BoardSession,
  PrInfo,
} from '@once-upon-a-diff/protocol/types';

export interface ColumnInput {
  sessions: Pick<BoardSession, 'status'>[];
  agents: (Pick<BoardAgent, 'status' | 'state'> & {
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
  } | null;
  /** a session is building, rebuilding or fixing for it */
  building?: boolean;
}

/** When you last acted on the PR (ms): on GitHub, or by marking its story reviewed by hand. null when there is no sign. */
export function baselineOf({ pr, story }: Pick<ColumnInput, 'pr' | 'story'>): number | null {
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

export function columnOf(input: ColumnInput): BoardColumn {
  const { sessions, agents, pr, story, building } = input;
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
    sessions.some((session) => session.status === 'working') ||
    agents.some((agent) => agent.state === 'running')
  ) {
    return 'working';
  }
  if (pr?.state === 'merged') {
    return 'done';
  }
  // a failed agent on the card (nested by its branch, PR or card, or the claimed author) needs a look, as its own card
  // would in Waiting (finishedColumn); it is Waiting, not Error, which is the session's tab, and it stays a line on the card
  if (agents.some((agent) => agent.state === 'failed')) {
    return 'waiting';
  }
  if (story?.local && story.approved && !pr) {
    return 'ship';
  }
  // an answer to a question you asked, unread: back to you on the GitHub side for your own PR, in Ready while there is
  // no PR. On someone else's PR the answer is a chip on the card, not a reason to leave PR open (you asked about their
  // code while reviewing it; the ball is theirs unless GitHub requests you or its story has a new version)
  // a stub PR (before GitHub says who wrote it) has author null: treat it as yours until it fills in
  if (story?.answered && (!pr || pr.mine || pr.author === null)) {
    return pr ? 'back' : 'ready';
  }
  // a story you have marked reviewed takes the card out of Ready even while the agent's [review] line stands
  if (!pr && !story?.reviewed && agents.some((agent) => agent.review)) {
    return 'ready';
  }
  // Ready for your review is the Mac's side: a story whose work has no PR. Once a PR exists (even with a local story
  // of its branch, or a PR story you haven't opened), the card follows the PR's rules on the GitHub side
  if (story?.unread) {
    if (!pr) {
      return 'ready';
    }
    if (!story.local) {
      return 'back';
    }
  }
  if (story && !story.reviewed && !pr) {
    return 'ready';
  }
  if (pr) {
    return isBackToYou(input) || pr.review_requested ? 'back' : 'pr_open';
  }
  if (sessions.some((session) => session.status === 'error')) {
    return 'error';
  }
  return 'idle';
}
