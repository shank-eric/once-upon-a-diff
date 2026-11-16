/*
 * What a run does on a card (`--role`) and the kind the board and the registry know it as (ADR-25). A fixer is an author's
 * kind with its own role, kept on the start row.
 */
import { canonicalKind } from '@once-upon-a-diff/state/records/agents/events';

export const ROLE_KIND: Record<string, string> = {
  author: 'author',
  fixer: 'author',
  critic: 'critic',
  storyteller: 'storyteller',
  helper: 'helper',
  research: 'research',
};

/** The kind a role runs as, after checking the role is one and a typed kind does not disagree with it. */
export function roleKind(role: string | null, kind: string | null): string | null {
  if (role && !Object.hasOwn(ROLE_KIND, role)) {
    throw new Error(`the role must be one of ${Object.keys(ROLE_KIND).join(', ')}`);
  }
  if (role && kind && ROLE_KIND[role] !== canonicalKind(kind)) {
    throw new Error('--role and --kind disagree: pass --role alone');
  }
  return (role ? ROLE_KIND[role] : kind) ?? null;
}
