/**
 * An editor's slots in use: the one function the board's editor strip and `once-upon editor slots` both call, so the two
 * cannot disagree. An author is the editor's when the editor's session claimed its card (the claim's `session`, claims.ts) or,
 * with no claim naming an editor, when it was launched from the editor's session (its registered sid): one owner each. A slot is held by an author that is working: running,
 * at its plan check, or fixing findings. One at a question or a story review has handed back its slot, a critic, storyteller
 * or helper never held one, and an author silent for STALE_MS is dead. Per editor: two editors on one repo have a pool each.
 * Pure: the caller gathers the agents and the cards.
 */
import { STALE_MS } from '../../records/agents/events.ts';
import { lastActivity, type LedgerAgent } from '../../records/agents/ledger.ts';
import { DEFAULT_SLOTS } from '../../records/agents/registry.ts';
import { OPEN } from './claims.ts';
import type { BacklogItem } from './types.ts';

export { DEFAULT_SLOTS };

/** The states in which an author holds a slot. */
export const SLOT_STATES: LedgerAgent['state'][] = ['running', 'plan', 'fixing'];

/** The full session that claimed the card an agent's run names, or null (an old claim, no claim, or no card). */
export const claimSessionOf = (
  agent: Pick<LedgerAgent, 'card'>,
  items: Pick<BacklogItem, 'id' | 'claim'>[],
): string | null =>
  (agent.card ? items.find((item) => item.id === agent.card)?.claim?.session : null) ?? null;

/**
 * The editor that controls an author, or null: the open editor whose session claimed the author's card, else the open editor
 * its launching session is (its registered sid). One owner, so an author fills one pool: the claim wins when it names an
 * editor, and a claim by any other session (the main session acting as one, say) leaves the launcher the owner.
 */
function ownerOf(
  agent: Pick<LedgerAgent, 'sid' | 'card'>,
  editors: Pick<LedgerAgent, 'sid' | 'session'>[],
  items: Pick<BacklogItem, 'id' | 'claim'>[],
): Pick<LedgerAgent, 'sid' | 'session'> | null {
  const claimed = claimSessionOf(agent, items);
  return (
    (claimed ? editors.find((one) => one.session === claimed) : undefined) ??
    editors.find((one) => one.sid === agent.sid) ??
    null
  );
}

/**
 * The editor's open authors, oldest first: not stale, running, waiting, at a plan or fixing (a finished one is no one's
 * to count). Not all of them hold a slot (`slotsInUse`).
 */
export function editorAuthors(
  editor: Pick<LedgerAgent, 'sid' | 'session'>,
  agents: LedgerAgent[],
  items: Pick<BacklogItem, 'id' | 'claim'>[],
  nowMs: number,
): LedgerAgent[] {
  // the open editors, this one among them (a caller may hand over one the registry no longer lists as open)
  const editors: Pick<LedgerAgent, 'sid' | 'session'>[] = [
    editor,
    ...agents.filter(
      (one) =>
        one.kind === 'editor' &&
        OPEN.includes(one.state) &&
        !(one.sid === editor.sid && one.session === editor.session),
    ),
  ];
  return agents
    .filter((agent) => {
      if (
        agent.kind !== 'author' ||
        !OPEN.includes(agent.state) ||
        nowMs - (lastActivity(agent) ?? agent.started ?? new Date(nowMs)).getTime() > STALE_MS
      ) {
        return false;
      }
      const owner = ownerOf(agent, editors, items);
      return owner?.sid === editor.sid && owner?.session === editor.session;
    })
    .sort((first, second) => (first.started?.getTime() ?? 0) - (second.started?.getTime() ?? 0));
}

export interface Slots {
  slots: number;
  in_use: number;
  free: number;
  /** the editor's open authors, those holding a slot or not */
  authors: LedgerAgent[];
}

/** How many of an editor's slots its authors hold. */
export function slotsInUse(
  editor: Pick<LedgerAgent, 'sid' | 'session' | 'slots'>,
  agents: LedgerAgent[],
  items: Pick<BacklogItem, 'id' | 'claim'>[],
  nowMs: number,
): Slots {
  const authors = editorAuthors(editor, agents, items, nowMs);
  const slots = editor.slots ?? DEFAULT_SLOTS;
  const inUse = authors.filter((agent) => SLOT_STATES.includes(agent.state)).length;
  return { slots, in_use: inUse, free: Math.max(0, slots - inUse), authors };
}
