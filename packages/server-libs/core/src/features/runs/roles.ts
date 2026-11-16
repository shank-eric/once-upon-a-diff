/*
 * What a run does on a card (`--role`) and the kind the board and the registry know it as (ADR-25). A fixer is an author's
 * kind with its own role, kept on the start row.
 */
import { canonicalKind, runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { isSelfName } from '@once-upon-a-diff/terms/ids';

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

/** The roles a parent session's own run (`agent start --self`) takes: a fixer, a critic or a storyteller is a subagent's. */
export const SELF_ROLES = ['author', 'research', 'helper'];

/** The flags `--self` takes none of: it registers this session as itself, with a name of its own. */
const SELF_REFUSES: Array<[string, (input: SelfFlags) => boolean]> = [
  ['NAME', (input) => !!input.name],
  ['--sid', (input) => !!input.sid],
  ['--kind', (input) => input.kind != null],
  ['--standing', (input) => input.standing !== undefined],
  ['--replaces', (input) => !!input.replaces],
];

interface SelfFlags {
  name?: string | null;
  sid?: string | null;
  kind?: string | null;
  standing?: boolean;
  replaces?: string | null;
  role?: string | null;
  session?: string | null;
}

/** Why a `--self` start is refused, or null: checked before anything is written. */
export function selfProblem(input: SelfFlags): string | null {
  const typed = SELF_REFUSES.filter(([, typedIt]) => typedIt(input)).map(([flag]) => flag);
  if (typed.length) {
    return `--self registers this session under a run name of its own: it takes no ${typed.join(', ')}`;
  }
  if (!input.session) {
    return '--self needs a Claude session (CLAUDE_CODE_SESSION_ID is not set)';
  }
  if (!input.role || !SELF_ROLES.includes(input.role)) {
    return '--self is the session’s own work: pass --role author, research or helper (a fixer, a critic and a storyteller are subagents’ roles)';
  }
  return null;
}

/** The newest open run of a session's own (`--self`): the one `state`, `beat` and `finish --self` are for. `run` picks one by its id. */
export function openSelfRun(
  agents: LedgerAgent[],
  sid: string,
  run: string | null = null,
): LedgerAgent | null {
  const open = agents.filter(
    (one) => one.sid === sid && isSelfName(one.name) && runIsOpen(one) && (!run || one.run === run),
  );
  return (
    open.sort(
      (first, second) => (second.started?.getTime() ?? 0) - (first.started?.getTime() ?? 0),
    )[0] ?? null
  );
}
