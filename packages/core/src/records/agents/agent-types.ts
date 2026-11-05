/* The agent kinds and what a finished run made, kept apart so events.ts and ledger.ts both read them without importing each other. */

/**
 * What an agent is. `editor` is not an agent but a session that runs a repo's build queue (`/once-upon-editor`): it
 * registers itself so the board can show it with the authors it controls (the ones launched under its session id).
 */
export const AGENT_KINDS = ['author', 'critic', 'helper', 'research', 'editor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** What a finished run made: each part optional. */
export interface AgentResult {
  commit?: string;
  pr?: number;
  branch?: string;
  card?: string;
}
