/**
 * Standing helpers: an agent registered with `once-upon agent start --standing` is a long-lived helper the session reaches by
 * SendMessage (the backlog clerk), not work to finish. It never has a card, in Waiting, Done or anywhere else; the page
 * shows it in a row at the bottom, like the listeners, for as long as its session lives and it has been heard from.
 * Only the registered field says so: not the name, the kind or the task text.
 */
import { lastActivity, type LedgerAgent } from '../../../records/agents/ledger.ts';
import type { BoardHelper, BoardSession } from '@once-upon-a-diff/contracts/types';
import type { LiveSession } from '../../../adapters/claude-sessions/live-sessions.ts';

/** A helper with no event this long is left off the row (its session may be live, but nobody has asked it anything). */
export const HELPER_IDLE_MS = 8 * 3600 * 1000;

export const isStandingHelper = (agent: Pick<LedgerAgent, 'standing'>): boolean =>
  agent.standing === true;

/**
 * The helpers to show: marked agents that are running or waiting (a done, failed or stopped one is over), whose launching
 * session is still live, with an event inside `HELPER_IDLE_MS`. Name order.
 */
export function standingHelpers(
  agents: LedgerAgent[],
  live: LiveSession[],
  sessionViews: Map<string, BoardSession>,
  nowMs: number,
): BoardHelper[] {
  const helpers: BoardHelper[] = [];
  for (const agent of agents) {
    const last = lastActivity(agent);
    if (
      !isStandingHelper(agent) ||
      agent.state === 'done' ||
      agent.state === 'failed' ||
      agent.state === 'stopped' ||
      !last ||
      nowMs - last.getTime() > HELPER_IDLE_MS
    ) {
      continue;
    }
    const session = live.find((one) => one.session.startsWith(agent.sid));
    if (!session) {
      continue;
    }
    const view = sessionViews.get(session.session);
    helpers.push({
      name: agent.name,
      state: agent.state === 'waiting' ? 'waiting' : 'handling',
      session: session.session,
      title: view?.title ?? null,
      can_focus: view?.focus ?? false,
      last_request_at: last.toISOString(),
    });
  }
  return helpers.sort((first, second) => first.name.localeCompare(second.name));
}
