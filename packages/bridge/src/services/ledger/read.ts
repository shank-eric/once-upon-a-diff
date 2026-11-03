/**
 * The board's agents: the registered ones (agents.jsonl, events.ts) first, then the ledger file's agents that no event
 * covers. A key (`sid:name`) with events is told by its events alone: hand-written ledger lines for it, and the lines the
 * registry mirrored into the ledger, are ignored. The beats map is the progress file's, by name, for ledger agents only
 * (beatOf, events.ts).
 */
import path from 'node:path';
import type { BoardBeat } from '@once-upon-a-diff/protocol/types';
import { readAgentsFile } from '../../adapters/stores/agents-file.ts';
import { tailOf } from '../../adapters/stores/notes.ts';
import { foldAgentEvents, parseAgentEvents } from './events.ts';
import { parseLedger, parseProgress, type LedgerAgent } from './ledger.ts';

const LEDGER_TAIL = 1024 * 1024;
const PROGRESS_TAIL = 256 * 1024;

/** The registry's file in a bridge home. */
export const agentsFile = (home: string) => path.join(home, 'agents.jsonl');

/** The agents and beats for the home and the files the settings name (a missing file or setting gives none). */
export function readAgents(
  files: { home: string; ledger: string | null; progress: string | null },
  now: Date,
  zone?: string,
): { agents: LedgerAgent[]; beats: Map<string, BoardBeat> } {
  const registered = foldAgentEvents(parseAgentEvents(readAgentsFile(agentsFile(files.home))));
  const keys = new Set(registered.map((agent) => `${agent.sid}:${agent.name}`));
  const fromLedger = files.ledger
    ? parseLedger(tailOf(files.ledger, LEDGER_TAIL), now, zone).filter(
        (agent) => !keys.has(`${agent.sid}:${agent.name}`),
      )
    : [];
  // the progress file knows names, not sessions: a name a registered agent has is its (the registry mirrors its beats there), so a
  // ledger agent of the same name under another session gets none rather than the registered one's
  const beats = files.progress ? parseProgress(tailOf(files.progress, PROGRESS_TAIL)) : new Map();
  for (const agent of registered) {
    beats.delete(agent.name);
  }
  return { agents: [...registered, ...fromLedger], beats };
}
