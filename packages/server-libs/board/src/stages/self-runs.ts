/*
 * A parent session's own runs (`agent start --self`, named `self-XXXXXX`) and what the board does with them. A session that has
 * registered one is a registered session: the board no longer guesses its card from its branch (it sits on no landed or
 * ready card), shows it Thinking while it is busy with no run open, and shows a run whose session is gone as stopped. A busy
 * session of any kind with no author or fixer run open under its id is Thinking too, unless it sits on a work card (sessions.ts). Pure.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';

/** The sessions (first 8 of the id) that have registered a run of their own, and those with one open now. */
export function selfSessions(agents: LedgerAgent[]): {
  registered: Set<string>;
  open: Set<string>;
} {
  const registered = new Set<string>();
  const open = new Set<string>();
  for (const agent of agents) {
    if (isSelfName(agent.name)) {
      registered.add(agent.sid);
      if (runIsOpen(agent)) {
        open.add(agent.sid);
      }
    }
  }
  return { registered, open };
}

/**
 * The sessions (first 8 of the id) with a work run open now: an author or a fixer (kind author), work on a card. A subagent
 * shares its parent's sid, so a research or helper run (or a critic or storyteller) under it is no work of the session's own.
 */
export function openSessions(agents: LedgerAgent[]): Set<string> {
  return new Set(
    agents
      .filter(
        (agent) =>
          runIsOpen(agent) &&
          (agent.kind === 'author' || agent.role === 'author' || agent.role === 'fixer'),
      )
      .map((agent) => agent.sid),
  );
}

/**
 * The agents with each open run of a session that is gone shown stopped, at its last sign of life (the board never writes, so a
 * session that comes back, the same id, simply has its run open again). `liveSids` is the first 8 of each live session's id;
 * an empty list is a scan that found nothing, not proof that every session left, so it changes nothing.
 */
export function endGoneSelfRuns(agents: LedgerAgent[], liveSids: string[]): LedgerAgent[] {
  if (!liveSids.length) {
    return agents;
  }
  const live = new Set(liveSids);
  return agents.map((agent) =>
    isSelfName(agent.name) && runIsOpen(agent) && !live.has(agent.sid)
      ? {
          ...agent,
          state: 'stopped',
          review: false,
          ended: agent.lastEvent ?? agent.started,
          outcome: agent.outcome ?? 'its session ended',
        }
      : agent,
  );
}
