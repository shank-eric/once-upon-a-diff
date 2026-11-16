/*
 * Ends a run, with the card checks: a critic on a card finishes with a findings count (a null would read as a pass).
 * The CLI's `agent finish` and the board's Finish both come here.
 */
import type { FinishInput } from '@once-upon-a-diff/state/records/agents/registry';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { runRegistry, type Mirror } from './registry.ts';

export function finishRun(
  home: string,
  name: string,
  input: FinishInput = {},
  options: { mirror?: Mirror; warn?: (line: string) => void } = {},
): LedgerAgent {
  return runRegistry(home, options.mirror).finish(name, input, options.warn);
}
