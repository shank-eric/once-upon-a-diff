/*
 * A parent session's own runs (`agent start --self`, named `self-XXXXXX`) and what the board does with them. A session that has
 * registered one is a registered session: the board no longer guesses its card from its branch (it sits on no landed or
 * ready card), shows it Thinking while it is busy with no run open, and shows a run whose session is gone as stopped. A busy
 * session of any kind with no author or fixer run open under its id is Thinking too, unless it sits on a work card (sessions.ts). Pure.
 */
import { isSelfName } from '@once-upon-a-diff/terms/ids';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import { lastActivity, type LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';

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

/** Where a session's work is: the card its runs name, and that card's repo and branch. */
export interface SessionHome {
  card: string;
  repo: string | null;
  branch: string;
}

/** The cards each session's runs name: the ones its open runs name, and every carded run with when it last showed life. */
function cardsBySession(agents: LedgerAgent[]): {
  open: Map<string, Set<string>>;
  latest: Map<string, { card: string; time: number }[]>;
} {
  const open = new Map<string, Set<string>>();
  const latest = new Map<string, { card: string; time: number }[]>();
  for (const agent of agents) {
    if (agent.card && runIsOpen(agent)) {
      open.set(agent.sid, (open.get(agent.sid) ?? new Set()).add(agent.card));
    }
    for (const run of [...(agent.earlier ?? []), agent]) {
      if (run.card) {
        const time = lastActivity(run)?.getTime() ?? 0;
        latest.set(run.sid, [...(latest.get(run.sid) ?? []), { card: run.card, time }]);
      }
    }
  }
  return { open, latest };
}

/**
 * Where each session (first 8 of the id) does its work, by the cards its runs name, so a session in a checkout on the default
 * branch (or on a branch with no work) is placed with its card's branch instead of its own. The card is the one the session's
 * open runs name (any kind, a parked one too: every carded run counts, and an uncarded one is ignored); with none open, the one
 * its most recent carded run named, while that run's last sign of life is within `cutoffMs` (runs are seconds long, so a session
 * between them has none open). Open runs on two cards that give a place give no entry, and the session keeps its own branch; a card that is
 * dropped, landed, or has no branch gives no place and is not counted. A card no stored item names gives no place (`card backfill` stores the ones older runs made). Pure.
 */
export function sessionHomes(
  agents: LedgerAgent[],
  items: BacklogItem[],
  nowMs: number,
  cutoffMs: number,
): Map<string, SessionHome> {
  const { open, latest } = cardsBySession(agents);
  const stored = new Map(items.map((item) => [item.id, item]));
  const placeOf = (card: string): SessionHome | null => {
    const item = stored.get(card);
    return !item || item.state === 'dropped' || item.landed_at || !item.branch
      ? null
      : { card, repo: item.repo, branch: item.branch };
  };
  const homeOf = (sid: string): SessionHome | null => {
    // only a card that gives a place counts: a branchless helper's implicit card, or a dropped one, is no second card
    const placed = [...(open.get(sid) ?? [])].map(placeOf).filter((home) => home !== null);
    if (placed.length > 0) {
      return placed.length === 1 ? placed[0] : null;
    }
    let newest: { home: SessionHome; time: number } | undefined;
    for (const { card, time } of latest.get(sid) ?? []) {
      const home = placeOf(card);
      if (home && time > (newest?.time ?? -1)) {
        newest = { home, time };
      }
    }
    return newest && newest.time + cutoffMs > nowMs ? newest.home : null;
  };
  const homes = new Map<string, SessionHome>();
  for (const sid of new Set([...open.keys(), ...latest.keys()])) {
    const home = homeOf(sid);
    if (home) {
      homes.set(sid, home);
    }
  }
  return homes;
}
