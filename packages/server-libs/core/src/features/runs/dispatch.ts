/*
 * Launches an agent for a card in one call: the preflight, the run's start and the brief the editor hands to its Agent call
 * (`once-upon dispatch`). The run is what takes the card (ADR-29): the registry keeps its own refusals (one open author per
 * card, a critic needs a branch...) and they are not copied here, so a refused start writes nothing. No CLI types, and nothing
 * written but the backlog and agents events: the author makes its own worktree.
 */
import { readLogText } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { worktreeProblem } from '@once-upon-a-diff/state/queues/backlog/worktree-check';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { readSettings, repoSettings, shipsByPr } from '@once-upon-a-diff/foundation/settings';
import path from 'node:path';
import { LAUNCH, agentCall, renderBrief, type Shape } from './briefs.ts';
import { defaultBranch, flat, mainCheckout, workPaths } from './checkout.ts';
import { roundBaseOf, type RoundBase } from './round.ts';
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
  /** the base the critic's diff and the story run from; a critic or storyteller of a card's later round defaults to `origin/<branch>` (its sha), else the default branch */
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
  /** a critic or storyteller of the card's second round or later: the pushed tip it starts from, unless `base` was typed */
  round: RoundBase | null;
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

type Item = ReturnType<BacklogStore['listed']>[number];
type RunStart = Parameters<typeof startRun>[1];

/** A text that is there, or undefined: what the brief takes for an optional part. */
const optional = (value: unknown): string | undefined => text(value) ?? undefined;

/** The shape of a launch: its role and the author's two shapes, a plan and a build. */
function refuseBadShape(input: DispatchInput): void {
  if (!DISPATCH_ROLES.includes(input.role)) {
    throw new Error(`the role must be one of ${DISPATCH_ROLES.join(', ')}`);
  }
  if (input.plan && input.fromNotes) {
    throw new Error('--plan and --from-notes are two shapes of an author: pass one');
  }
  if ((input.plan || input.fromNotes) && input.role !== 'author') {
    throw new Error('--plan and --from-notes are for --role author');
  }
}

/** The card, when a run can be launched for it: one that is there and neither dropped, landed, nor (for an author) held. */
function launchableCard(store: BacklogStore, input: DispatchInput): Item {
  const item = store.listed().find((one) => one.id === input.card);
  if (!item) {
    throw new Error(`no backlog item ${input.card}`);
  }
  if (item.state === 'dropped') {
    throw new Error(`${item.id} was dropped`);
  }
  if (item.landed_at) {
    throw new Error(`${item.id} already landed (done)`);
  }
  if (input.role === 'author' && item.hold) {
    throw new Error(
      `${item.id} is held (it lands by hand): release it with once-upon backlog hold ${item.id} --off to launch an author`,
    );
  }
  return item;
}

/** The branch the work is on: the card's, or the one typed for a card with none. */
function branchOf(item: Item, input: DispatchInput): string {
  const branch = item.branch ?? text(input.branch);
  if (!branch) {
    throw new Error(`${item.id} has no branch: pass --branch NAME (the branch the work is on)`);
  }
  return branch;
}

/** The author's plan has no success check; an author that builds and a fixer have one. */
function refuseNoCheck(input: DispatchInput): void {
  const { role } = input;
  const needsCheck = role === 'author' ? !input.plan : role === 'fixer';
  if (needsCheck && !text(input.check)) {
    throw new Error(
      `a${role === 'author' ? 'n' : ''} ${role} needs --check TEXT, its success check`,
    );
  }
}

/** A chapter writer and a finisher read a story folder, which they are told by flags. */
function refuseNoStory(input: DispatchInput): void {
  if (input.role === 'writer' && (!text(input.key) || !text(input.dir))) {
    throw new Error('a chapter writer needs --key KEY and --dir DIR (the story folder)');
  }
  if (input.role === 'finisher' && (!text(input.story) || !text(input.dir))) {
    throw new Error('a finisher needs --story ID and --dir DIR (the story folder)');
  }
}

/** An author's plan and build are shapes of the author role; every other role is its own shape. */
function shapeOf(input: DispatchInput): Shape {
  if (input.role !== 'author') {
    return input.role;
  }
  if (input.plan) {
    return 'plan';
  }
  return input.fromNotes ? 'build' : 'author';
}

/** The run's name: the branch's, with the prefix its shape gives it. */
function nameOf(input: DispatchInput, shape: Shape, branch: string): string {
  const flatBranch = flat(branch);
  const names: Record<Shape, string> = {
    author: flatBranch,
    plan: flatBranch,
    build: `${flatBranch}-build`,
    fixer: `fix-${flatBranch}`,
    critic: `review-${flatBranch}`,
    storyteller: `story-${flatBranch}`,
    helper: `check-${flatBranch}`,
    writer: `fw-${flatBranch}-${text(input.key) ?? 'x'}`,
    finisher: `finish-${flatBranch}`,
  };
  return text(input.name) ?? names[shape];
}

/** The brief's facts that a launch settles: the card's, the paths, and the names. */
interface Launching {
  item: Item;
  shape: Shape;
  name: string;
  sid: string;
  branch: string;
  main: string;
  worktree: string;
  notes: string;
  /** the user's own lines for a general-purpose brief (`<home>/editor/brief-extra.md`) */
  extra: string | null;
  /** launched as general-purpose, so the brief carries the lean type's standing rules */
  general: boolean;
  /** the base the brief's diff and story run from */
  base: string;
}

/** The brief the editor hands to the Agent call. */
function briefOf(home: string, input: DispatchInput, launching: Launching, now: Date): string {
  const { item, shape, branch } = launching;
  const reviewFile = path.join(
    home,
    'reviews',
    `${localDate(now)}-${flat(branch)}-agent-review.md`,
  );
  return renderBrief({
    shape,
    name: launching.name,
    sid: launching.sid,
    card: item.id,
    title: item.title,
    note: item.note,
    checkout: launching.main,
    worktree: launching.worktree,
    notes: launching.notes,
    branch,
    base: launching.base,
    check: optional(input.check),
    task: optional(input.task),
    out: text(input.out) ?? reviewFile,
    findingsFrom: optional(input.findingsFrom),
    fromNotes: optional(input.fromNotes),
    fanOut: !!input.fanOut,
    prDraft: shipsByPr(repoSettings(readSettings(home), item.repo)),
    deployGate: !!repoSettings(readSettings(home), item.repo).deploy_gate,
    dir: optional(input.dir),
    key: optional(input.key),
    story: optional(input.story),
    failed: optional(input.failed),
    // a general-purpose agent gets none of agents/*.md, so its prompt carries them
    rules: launching.general ? agentRules(LAUNCH[shape].type) : null,
    extra: launching.extra,
  });
}

/** The round a critic or storyteller starts from when the card's branch has new commits on top of a push (null for every other role, which read no base of this kind). */
function roundOf(
  home: string,
  item: Item,
  branch: string,
  role: DispatchRole,
  main: string,
): RoundBase | null {
  if (role !== 'critic' && role !== 'storyteller') {
    return null;
  }
  return roundBaseOf({ branch, pr: item.pr }, runsOf(item, readAgents(home).agents), main);
}

/** The run's start: a run of the card, on its branch, with the model and effort its shape launches with. */
function startOf(input: DispatchInput, launching: Launching): RunStart {
  const { item, branch } = launching;
  const launch = LAUNCH[launching.shape];
  return {
    name: launching.name,
    sid: launching.sid,
    session: input.session,
    role: runRole(input.role),
    task: (text(input.task) ?? `${input.role} of ${item.title}`).split('\n')[0].slice(0, 200),
    model: launch.model,
    effort: launch.effort,
    cwd: launching.main,
    card: item.id,
    branch: item.branch ? null : branch,
    notes: launching.notes,
    by: text(input.by),
  };
}

export async function dispatchRun(
  home: string,
  input: DispatchInput,
  options: RunIo & { now?: Date } = {},
): Promise<Dispatched> {
  const { role } = input;
  const now = options.now ?? new Date();
  refuseBadShape(input);
  const store = new BacklogStore(home);
  const item = launchableCard(store, input);
  const branch = branchOf(item, input);
  refuseNoCheck(input);
  const shape = shapeOf(input);
  const name = nameOf(input, shape, branch);
  refuseNoStory(input);
  const sid = text(input.sid) ?? input.session?.slice(0, 8) ?? '';
  const main = mainCheckout(input.cwd);
  const { worktree, notes } = workPaths(main, branch);
  if (role === 'fixer') {
    const problem = worktreeProblem(worktree, { repo: item.repo, branch });
    if (problem) {
      throw new Error(`${problem}: recreate the worktree before a fixer starts`);
    }
  }
  // only --general (or a missing lean type) launches general-purpose: a brief-extra.md never switches the type
  const general = !!input.general;
  const extra = general
    ? text(readLogText(path.join(home, 'editor', 'brief-extra.md')).trim())
    : null;
  const round = text(input.base) ? null : roundOf(home, item, branch, role, main);
  const launching: Launching = {
    item,
    base: text(input.base) ?? round?.sha ?? defaultBranch(main),
    shape,
    name,
    sid,
    branch,
    main,
    worktree,
    notes,
    extra,
    general,
  };
  const prompt = briefOf(home, input, launching, now);
  const launch = LAUNCH[shape];
  const started = await startRun(home, startOf(input, launching), options);
  // a fixer's worktree is where the card's work is (ADR-29); the start was accepted, so nothing is written for a refusal
  if (role === 'fixer') {
    store.link(item.id, { worktree, by: text(input.by) ?? name });
  }
  return {
    name,
    role,
    subagentType: general ? 'general-purpose' : launch.type,
    model: launch.model,
    effort: launch.effort,
    description: `${name}: ${role} for ${item.id}`,
    prompt,
    run: started.run,
    round,
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
