/*
 * The one place a registry is built for starting, moving or finishing a run: with the card lookup, so every ADR-25 check
 * (the card exists and is open, one author per card, a carded critic finishes with a findings count) applies to whoever
 * calls. A registry built without the lookup only records, and a caller that did that skipped the checks.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';

/** Which logs an event also writes its line to: the ledger and the progress file the settings name, the ledger only, or neither. */
export type Mirror = 'both' | 'ledger' | 'none';

export function runRegistry(home: string, mirror: Mirror = 'both'): AgentRegistry {
  const board = readSettings(home).board;
  return new AgentRegistry(
    home,
    {
      ledger: mirror === 'none' ? null : board.ledgerFile,
      progress: mirror === 'both' ? board.progressFile : null,
    },
    cardLookup(new BacklogStore(home)),
  );
}
