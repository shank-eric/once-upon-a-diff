/*
 * Launches an agent for a card in one call: the preflight, the claim (an author's or a fixer's), the run's start and the brief
 * the editor hands to its Agent call (`once-upon dispatch`). The registry keeps its own refusals (one open author per card, a
 * critic needs a branch...): they are not copied here. The claim has to be written before the registry will start an author or
 * a fixer, so a start it refuses puts the card's earlier claim back (a card that had none keeps this claim, which the same
 * launcher may replace). No CLI types, and nothing written but the backlog and agents events: the author makes its own worktree.
 */
import { readLogText } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { claimWorktreeProblem } from '@once-upon-a-diff/state/queues/backlog/claim-worktree';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { liveClaim } from '@once-upon-a-diff/state/queues/backlog/claims';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import path from 'node:path';
import { LAUNCH, agentCall, renderBrief, type Shape } from './briefs.ts';
import { defaultBranch, flat, mainCheckout, workPaths } from './checkout.ts';
import { runRegistry } from './registry.ts';
import { startRun, type RunIo } from './start-run.ts';

/** The roles `dispatch` takes: a run's own roles, and the fan-out chapter writer and finisher (runs of the storyteller role). */
export const DISPATCH_ROLES = [
  'author',
  'fixer',
  'critic',
  'storyteller',
  'helper',
  'writer',
  'finisher',
] as const;
export type DispatchRole = (typeof DISPATCH_ROLES)[number];

export interface DispatchInput {
  card: string;
  role: DispatchRole;
  /** the folder dispatch runs in: any checkout or worktree of the repo */
  cwd: string;
  /** the launching (editor's) session, and its first 8 unless `sid` says */
  session?: string | null;
  sid?: string | null;
  name?: string | null;
  /** for a card with no branch: the branch it is stamped with */
  branch?: string | null;
  task?: string | null;
  check?: string | null;
  /** an author that only plans, or builds from a planner's notes file */
  plan?: boolean;
  fromNotes?: string | null;
  base?: string | null;
  findingsFrom?: string | null;
  /** a critic's findings file */
  out?: string | null;
  fanOut?: boolean;
  /** launch as general-purpose (the lean type is not installed, or the profile wants it): the brief carries the type's standing rules */
  general?: boolean;
  dir?: string | null;
  key?: string | null;
  story?: string | null;
  failed?: string | null;
  by?: string | null;
}

export interface Dispatched {
  name: string;
  role: DispatchRole;
  subagentType: string;
  model: string;
  effort: string;
  description: string;
  prompt: string;
  run: string;
  claimed: boolean;
}

/** The standing rules of a lean agent type: its definition's body, in this checkout's agents/ folder (the once-upon repo's). */
const AGENTS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'agents');
function agentRules(type: string): string | null {
  const file = readLogText(path.join(AGENTS_DIR, `${type}.md`));
  const body = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(file)?.[1] ?? '';
  return body.trim() || null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The run's role on the board: a writer and a finisher are storytellers. */
const runRole = (role: DispatchRole): string =>
  role === 'writer' || role === 'finisher' ? 'storyteller' : role;

const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export async function dispatchRun(
  home: string,
  input: DispatchInput,
  options: RunIo & { now?: Date } = {},
): Promise<Dispatched> {
  const role = input.role;
  if (!DISPATCH_ROLES.includes(role)) {
    throw new Error(`the role must be one of ${DISPATCH_ROLES.join(', ')}`);
  }
  if (input.plan && input.fromNotes) {
    throw new Error('--plan and --from-notes are two shapes of an author: pass one');
  }
  if ((input.plan || input.fromNotes) && role !== 'author') {
    throw new Error('--plan and --from-notes are for --role author');
  }
  const store = new BacklogStore(home);
  const item = store.items().find((one) => one.id === input.card);
  if (!item) {
    throw new Error(`no backlog item ${input.card}`);
  }
  if (item.state === 'dropped') {
    throw new Error(`${item.id} was dropped`);
  }
  if (item.landed_at) {
    throw new Error(`${item.id} already landed (done)`);
  }
  if (role === 'author' && item.hold) {
    throw new Error(
      `${item.id} is held (it lands by hand): release it with once-upon backlog hold ${item.id} --off to launch an author`,
    );
  }
  const branch = item.branch ?? text(input.branch);
  if (!branch) {
    throw new Error(`${item.id} has no branch: pass --branch NAME (the branch the work is on)`);
  }
  const needsCheck = role === 'author' ? !input.plan : role === 'fixer';
  if (needsCheck && !text(input.check)) {
    throw new Error(
      `a${role === 'author' ? 'n' : ''} ${role} needs --check TEXT, its success check`,
    );
  }
  let shape: Shape = role;
  if (role === 'author' && input.plan) {
    shape = 'plan';
  } else if (role === 'author' && input.fromNotes) {
    shape = 'build';
  }
  const name =
    text(input.name) ??
    (shape === 'build'
      ? `${flat(branch)}-build`
      : {
          author: flat(branch),
          plan: flat(branch),
          build: flat(branch),
          fixer: `fix-${flat(branch)}`,
          critic: `review-${flat(branch)}`,
          storyteller: `story-${flat(branch)}`,
          helper: `check-${flat(branch)}`,
          writer: `fw-${flat(branch)}-${text(input.key) ?? 'x'}`,
          finisher: `finish-${flat(branch)}`,
        }[shape]);
  if (role === 'writer' && (!text(input.key) || !text(input.dir))) {
    throw new Error('a chapter writer needs --key KEY and --dir DIR (the story folder)');
  }
  if (role === 'finisher' && (!text(input.story) || !text(input.dir))) {
    throw new Error('a finisher needs --story ID and --dir DIR (the story folder)');
  }
  const sid = text(input.sid) ?? input.session?.slice(0, 8) ?? '';
  const registry = runRegistry(home, options.mirror);
  const claims = role === 'author' || role === 'fixer';
  // the claim is the one write the registry cannot refuse: a card another agent is working is never taken over
  if (claims && item.claim && item.claim.agent !== name) {
    const theirs = registry.agents().filter((one) => one.name === item.claim?.agent);
    // a claim with no run of its own, made by this same launcher, is its own refused start: it is replaced, not waited out
    const ownRefused = !theirs.length && !!input.session && item.claim.session === input.session;
    const live = theirs.length
      ? theirs.some(runIsOpen)
      : !ownRefused && !!liveClaim(item, null, (options.now ?? new Date()).getTime());
    if (live) {
      throw new Error(
        `${item.id} is claimed by ${item.claim.agent}, whose run is still going: finish it first (once-upon handback ${item.claim.agent})`,
      );
    }
  }
  const main = mainCheckout(input.cwd);
  const { worktree, notes } = workPaths(main, branch);
  if (role === 'fixer') {
    const problem = claimWorktreeProblem(worktree, { repo: item.repo, branch });
    if (problem) {
      throw new Error(`${problem}: recreate the worktree before a fixer starts`);
    }
  }
  const base = text(input.base) ?? defaultBranch(main);
  const extra = text(readLogText(path.join(home, 'editor', 'brief-extra.md')).trim());
  const launch = LAUNCH[shape];
  // a general-purpose agent gets none of agents/*.md, so its prompt carries them; the user's relay line asks for it too
  const general = !!input.general || !!extra;
  const out =
    text(input.out) ??
    path.join(
      home,
      'reviews',
      `${localDate(options.now ?? new Date())}-${flat(branch)}-agent-review.md`,
    );
  const prompt = renderBrief({
    shape,
    name,
    sid,
    card: item.id,
    title: item.title,
    note: item.note,
    checkout: main,
    worktree,
    notes,
    branch,
    base,
    check: text(input.check) ?? undefined,
    task: text(input.task) ?? undefined,
    out,
    findingsFrom: text(input.findingsFrom) ?? undefined,
    fromNotes: text(input.fromNotes) ?? undefined,
    fanOut: !!input.fanOut,
    dir: text(input.dir) ?? undefined,
    key: text(input.key) ?? undefined,
    story: text(input.story) ?? undefined,
    failed: text(input.failed) ?? undefined,
    rules: general ? agentRules(launch.type) : null,
    extra,
  });
  const earlier = item.claim;
  if (claims) {
    store.claim(item.id, {
      agent: name,
      sid,
      session: input.session,
      worktree: role === 'fixer' ? worktree : null,
      by: text(input.by) ?? name,
    });
  }
  let started;
  try {
    started = await startRun(
      home,
      {
        name,
        sid,
        session: input.session,
        role: runRole(role),
        task: (text(input.task) ?? `${role} of ${item.title}`).split('\n')[0].slice(0, 200),
        model: launch.model,
        effort: launch.effort,
        cwd: main,
        card: item.id,
        branch: item.branch ? null : branch,
        notes,
        by: text(input.by),
      },
      options,
    );
  } catch (err) {
    if (!claims) {
      throw err;
    }
    // the claim named a run that never existed: put the earlier one back
    if (earlier && earlier.agent !== name) {
      store.claim(item.id, {
        agent: earlier.agent,
        sid: earlier.sid,
        session: earlier.session,
        worktree: earlier.worktree,
        by: earlier.by,
      });
      throw new Error(
        `${(err as Error).message} (${item.id} is claimed by ${earlier.agent} again)`,
      );
    }
    throw new Error(
      `${(err as Error).message} (${item.id} stays claimed by ${name}, which has no run: dispatch again, under any name, from this session)`,
    );
  }
  // a general-purpose agent carries the relay line the user's brief-extra asks for: the lean types have no SendMessage
  const subagentType = general ? 'general-purpose' : launch.type;
  const description = `${name}: ${role} for ${item.id}`;
  return {
    name,
    role,
    subagentType,
    model: launch.model,
    effort: launch.effort,
    description,
    prompt,
    run: started.run,
    claimed: claims,
  };
}

/** The first line of a dispatch's output: the Agent call's arguments. */
export const callLine = (done: Dispatched): string =>
  agentCall({
    subagentType: done.subagentType,
    name: done.name,
    model: done.model,
    effort: done.effort,
    description: done.description,
  });
