/**
 * Standing helpers: a ledger agent whose task starts with "standing helper" (or "[helper]") is a long-lived helper the session reaches by
 * SendMessage (the backlog clerk), not work to finish. It never has a card, in Waiting, Done or anywhere else; the page
 * shows it in a row at the bottom, like the listeners, for as long as its session lives and it has been heard from.
 */
import { lastActivity, type LedgerAgent } from '../../ledger/ledger.ts';
import type { BoardHelper, BoardSession } from '@once-upon-a-diff/protocol/types';
import type { LiveSession } from '../../../adapters/claude-sessions/registry.ts';

/** A helper with no ledger line this long is left off the row (its session may be live, but nobody has asked it anything). */
export const HELPER_IDLE_MS = 8 * 3600 * 1000;

/** The marker: the task text starts with "standing helper" (or "standing-helper"), or with a "[helper]" tag. A mention further in does not count. */
const MARKER = /^\s*(?:standing[\s-]helper\b|\[helper\])/i;

export const isStandingHelper = (
  agent: Pick<LedgerAgent, 'task'> & Partial<Pick<LedgerAgent, 'source' | 'kind'>>,
): boolean => (agent.source === 'events' ? agent.kind === 'helper' : MARKER.test(agent.task ?? ''));

/**
 * The helpers to show: marked agents that are running or waiting (a done, failed or stopped one is over), whose launching
 * session is still live, with a ledger line inside `HELPER_IDLE_MS`. Name order.
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
