/**
 * Which column a card goes in: the work moves left to right to merge. The first that fits:
 *
 *   waiting   a session or agent on it is blocked on a question
 *   checks    an agent on it is at an automated gate (a plan to check, a reviewer running, findings being fixed): the
 *             launching session is the next actor, not you. Above working, because the session is busy exactly while it
 *             checks the plan or fixes the findings, and a running reviewer is a running agent
 *   working   a session or agent on it is busy, or a session is building, rebuilding or fixing its story
 *   done      the PR merged (the board drops it a day later)
 *   back      something is on you: its story has a version you haven't opened since it was built (a rebuild, say), or
 *             someone asked something of you on the PR after your last activity (on your own PR: changes requested, or
 *             an open thread whose last comment is theirs; on someone else's: a reply in an open thread you are in),
 *             or GitHub is waiting on your review
 *   ready     its PR story is built and you haven't reviewed it ("done" is not done until you've seen it)
 *   pr_open   pushed with a PR, and nothing waits on you
 *   error     a failed agent, or a session whose tab says error
 *   idle      nothing is happening and there is no PR: a session at its prompt (a lane along the bottom of the page)
 *
 * A card in Back to you clears when you mark its story reviewed, open it (the panel records where you stopped and what
 * you read), submit your review on GitHub, or the auto-review rules fire.
 */
import type { BoardAgent, BoardColumn, BoardSession, PrInfo } from '@once-upon-a-diff/shared/types';

export interface ColumnInput {
  sessions: Pick<BoardSession, 'status'>[];
  agents: (Pick<BoardAgent, 'status' | 'state'> & { gate?: BoardAgent['gate'] })[];
  pr: PrInfo | null;
  /**
   * The built PR story: whether you have reviewed it, when you marked it by hand (ms; an auto-mark carries the time the
   * bridge noticed, so it doesn't count as your activity), and whether it was built after you last opened or reviewed
   * it (`unread`: false when you have never opened it, which is "ready for your review", not "back to you").
   */
  story: { reviewed: boolean; manualReviewedAt: number | null; unread: boolean } | null;
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
    agents.some((agent) => agent.state === 'waiting')
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
  if (story?.unread) {
    return 'back';
  }
  if (story && !story.reviewed) {
    return 'ready';
  }
  if (pr) {
    return isBackToYou(input) || pr.review_requested ? 'back' : 'pr_open';
  }
  if (
    sessions.some((session) => session.status === 'error') ||
    agents.some((agent) => agent.state === 'failed')
  ) {
    return 'error';
  }
  return 'idle';
}
