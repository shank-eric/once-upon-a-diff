/*
 * The runs `once-upon compact` moved out of agents.jsonl (`<home>/archive/agents-YYYY-MM.jsonl`), folded like the log. The board never
 * reads them; `card status` does, for a card whose runs are old.
 */
import { readArchive } from '@once-upon-a-diff/adapters/stores/fs/archive';
import { foldAgentEvents, parseAgentEvents } from './events.ts';
import type { LedgerAgent } from './ledger.ts';

/** The archived runs (none when nothing was archived). */
export function archivedAgents(home: string): LedgerAgent[] {
  return foldAgentEvents(parseAgentEvents(readArchive(home, 'agents')));
}
