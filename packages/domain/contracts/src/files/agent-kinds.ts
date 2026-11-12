/* The kinds and roles of a registered run, for agents.jsonl's events (schemas.ts). */

/** What an agent is. `storyteller` writes a card's local story (old rows say `helper`). `editor` is a session, not an agent. */
export const AGENT_KINDS = [
  'author',
  'critic',
  'helper',
  'research',
  'storyteller',
  'editor',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** What a run does on a card (`agent start --role`). A fixer has an author's kind and a rule of its own, so the role is kept on the start row. */
export const AGENT_ROLES = [
  'author',
  'fixer',
  'critic',
  'storyteller',
  'helper',
  'research',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** Old names for a kind, still read from old agents.jsonl lines and still accepted by `agent start --kind`. */
export const KIND_ALIASES = { builder: 'author', reviewer: 'critic' } as const;
