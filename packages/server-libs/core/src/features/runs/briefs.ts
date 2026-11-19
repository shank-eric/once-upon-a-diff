/*
 * The prompt an editor hands a launched agent, as a pure function of facts (`once-upon dispatch` fills them in). What is the same for
 * every run of a role (the rules: no push, no stash, probes under a timeout, line ranges, the soft cap) lives in agents/*.md; this
 * file holds what differs per run: the name, the card, the paths, the success check and the exact beat, heavy and handback lines.
 */

/** A brief's shape: an author's run on a card, a planner (stops at its plan), the fresh build from a plan, a fixer, and the rest. */
export type Shape =
  | 'author'
  | 'plan'
  | 'build'
  | 'fixer'
  | 'critic'
  | 'storyteller'
  | 'helper'
  | 'writer'
  | 'finisher';

export interface BriefFacts {
  shape: Shape;
  name: string;
  /** the launching session's first 8: the run is found under it, so the brief names it on the handback line */
  sid: string;
  card: string;
  title: string;
  note?: string | null;
  checkout: string;
  worktree: string;
  notes: string;
  branch: string;
  base: string;
  check?: string;
  task?: string;
  /** a critic's findings file */
  out?: string;
  /** a fixer's checked findings file */
  findingsFrom?: string;
  /** a build author's planner notes file */
  fromNotes?: string;
  fanOut?: boolean;
  /** the repo ships by pull request: a storyteller or finisher drafts the PR text */
  prDraft?: boolean;
  /** the repo's deploy runs the full gate (config.json `repos.<repo>.deploy_gate`): an author or fixer brief carries the GATE line */
  deployGate?: boolean;
  /** a story's folder, and a writer's chapter key, the story id and the keys a finisher writes itself */
  dir?: string;
  key?: string;
  story?: string;
  failed?: string;
  /** the role's agent-type body, for a general-purpose launch (a lean type carries it itself) */
  rules?: string | null;
  /** text appended last (<home>/editor/brief-extra.md) */
  extra?: string | null;
}

/** What `dispatch` launches each shape as: the lean type, the model and the effort. */
export const LAUNCH: Record<Shape, { type: string; model: string; effort: string }> = {
  author: { type: 'once-upon-author', model: 'sonnet', effort: 'high' },
  plan: { type: 'once-upon-author', model: 'sonnet', effort: 'high' },
  build: { type: 'once-upon-author', model: 'sonnet', effort: 'high' },
  fixer: { type: 'once-upon-author', model: 'sonnet', effort: 'high' },
  critic: { type: 'once-upon-critic', model: 'opus', effort: 'high' },
  storyteller: { type: 'once-upon-storyteller', model: 'sonnet', effort: 'high' },
  helper: { type: 'once-upon-helper', model: 'sonnet', effort: 'medium' },
  writer: { type: 'once-upon-helper', model: 'sonnet', effort: 'medium' },
  finisher: { type: 'once-upon-storyteller', model: 'sonnet', effort: 'high' },
};

/** The steps an agent of each shape posts beats for (its M is their count). */
const STEPS: Record<Shape, string[]> = {
  author: ['read', 'plan', 'code', 'tests', 'green', 'done'],
  plan: ['read', 'plan'],
  build: ['read', 'code', 'tests', 'green', 'done'],
  fixer: ['read', 'fix', 'tests', 'green', 'done'],
  critic: ['read', 'review', 'done'],
  storyteller: ['read', 'plan', 'write', 'publish', 'done'],
  helper: ['read', 'work', 'done'],
  writer: ['read', 'write', 'done'],
  finisher: ['read', 'write', 'publish', 'done'],
};

const ROLE_WORD: Record<Shape, string> = {
  author: 'an author',
  plan: 'an author (plan only)',
  build: 'an author',
  fixer: 'a fixer',
  critic: 'a critic',
  storyteller: 'a storyteller',
  helper: 'a helper',
  writer: 'a chapter writer',
  finisher: 'a story finisher',
};

const beatLine = (facts: BriefFacts): string => {
  const steps = STEPS[facts.shape];
  const list = steps.map((step, place) => `${place + 1} ${step}`).join(', ');
  return (
    `Beats (M=${steps.length}): ${list}: fnm exec --using=24 once-upon beat ${facts.name} <N>/${steps.length} <step> "<few words>" ` +
    '(plain `once-upon beat` where your shell is on Node 24; a failing beat means Node 24 was not found: say so).'
  );
};

const heavyLine = (name: string): string =>
  `Heavy commands (the checkout's AGENTS.md lists them): ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy ${name} <command> ` +
  '(plain `once-upon heavy ' +
  `${name} <command>\` where your shell is on Node 24), with run_in_background, then wait for the notice.`;

/** The author gate (one line, so a rebase over a brief rewrite stays small); the shared-layer rule's wording is the same in AGENTS.md and agents/once-upon-author.md. */
const GATE =
  'Gate before you hand back: the targeted tests for the files you changed (bare), eslint on the changed files, yarn format:check, yarn workspace <pkg> typecheck for each changed workspace. Not yet: the full yarn test and the whole-repo typecheck, which the deploy gate runs; run them (heavy) only if the diff (git diff --name-only <base>...HEAD) touches packages/domain/, packages/server-libs/foundation/, configs/ or a tsconfig*.json at the repo root. test:extension, test:expand and the pixel shots only for client changes. A Success check that names a command wins.';

const handbackCommand = (facts: BriefFacts, tail: string): string =>
  `fnm exec --using=24 once-upon handback ${facts.name} --sid ${facts.sid} ${tail}`;

const PR_DRAFT =
  "This repo ships by pull request: as the last step, after the final publish, draft the PR text (skills/once-upon/SKILL.md step 6) and run `once-upon pr-draft` so the story page's Create pull request button holds it; redo it after every rebuild or update. Never push or run gh pr create.";

const STUCK =
  'Stuck or capped: the same command with --state waiting --outcome "<question, or capped; notes hold the rest>".';

/** The lines every brief builds from: the facts, said once. */
interface Parts {
  check: string | null;
  task: string | null;
  note: string | null;
  checkout: string;
  /** the notes file */
  home: string;
}

/** The lines of a brief, in order; a null is left out. */
type Body = (facts: BriefFacts, parts: Parts) => Array<string | null>;

/** An author's run, a plan that stops, and a build from a plan: one branch, one worktree, a commit at the end (or a plan). */
const authorBody: Body = (facts, { check, task, note, checkout, home }) => {
  const planOnly = facts.shape === 'plan';
  return [
    checkout,
    `Branch ${facts.branch}, worktree ${facts.worktree} (create it: git worktree add -b ${facts.branch} ${facts.worktree} ${facts.base}). ${home}`,
    planOnly
      ? 'Plan only: read the code, write your plan (files and lines, steps, tests, risks, questions) to the notes file, post beat 2/2 and stop. Write no code and make no worktree.'
      : null,
    facts.shape === 'build'
      ? `Build from ${facts.fromNotes}: the plan, and its "Plan check" corrections (the corrections win). Append your notes under "## Build".`
      : null,
    check,
    task,
    note,
    beatLine(facts),
    planOnly ? null : heavyLine(facts.name),
    planOnly || !facts.deployGate ? null : GATE,
    planOnly
      ? `When the plan is written, finish with: ${handbackCommand(facts, '--plan')}`
      : `When the commit is in, finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
    STUCK,
  ];
};

const fixerBody: Body = (facts, { check, task, note, home }) => [
  `Checkout: ${facts.worktree}, branch ${facts.branch}, base ${facts.base} (read ${facts.checkout}/AGENTS.md first). ${home}`,
  facts.findingsFrom
    ? `Fix only the checked findings in ${facts.findingsFrom}. Amend the branch’s one commit, never add a second.`
    : 'Amend the branch’s one commit, never add a second.',
  check,
  task,
  note,
  beatLine(facts),
  heavyLine(facts.name),
  facts.deployGate ? GATE : null,
  `When the amended commit is in, finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
  STUCK,
];

const criticBody: Body = (facts) => [
  `Checkout: ${facts.worktree} (read ${facts.checkout}/AGENTS.md first).`,
  `Review: git diff ${facts.base}...HEAD (the branch's own change, not the base's newer commits) in that worktree. Intent: ${facts.note ? `\n${facts.note}` : 'see the card'}${facts.task ? `\n${facts.task}` : ''}`,
  `Write findings (file:line, failure, confidence) to ${facts.out}; write nothing else.`,
  beatLine(facts),
  `Finish with: ${handbackCommand(facts, '--findings <N> --outcome "<count and file>"')}`,
];

const storytellerBody: Body = (facts, { task, note, home }) => {
  const parked = handbackCommand(facts, '--state review --outcome "<story id>"');
  const fanOutPark = handbackCommand(
    facts,
    '--state plan --outcome "fanout <story id>: skeleton up, <N> chapters to write, <D> keys=k1,k2,..."',
  );
  return [
    `Checkout: ${facts.worktree} (read ${facts.checkout}/AGENTS.md first). Tell the local story of branch ${facts.branch} over ${facts.base} with the once-upon skill. ${home}`,
    facts.fanOut ? 'Fan-out: yes' : null,
    task,
    note,
    beatLine(facts),
    facts.prDraft && !facts.fanOut ? PR_DRAFT : null,
    facts.fanOut
      ? `Publish the skeleton without --agent and park for the editor (SKILL.md step 3d): ${fanOutPark}. Otherwise publish with --agent ${facts.name} and, when the story is parked for review, finish with: ${parked}`
      : `Publish with --agent ${facts.name}. When the story is parked for review, finish with: ${parked}`,
    STUCK,
  ];
};

const helperBody: Body = (facts, { check, task, note, checkout, home }) => [
  checkout,
  home,
  check,
  task,
  note,
  beatLine(facts),
  heavyLine(facts.name),
  `Finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
  STUCK,
];

const writerBody: Body = (facts, { task, checkout }) => [
  checkout,
  `You write chapter ${facts.key} of the story for branch ${facts.branch}: read the once-upon skill's chapter-writer.md (skills/once-upon/chapter-writer.md in the once-upon repo, linked at ~/.claude/skills/once-upon/chapter-writer.md): its rules are yours.`,
  `Story folder: ${facts.dir}. Read ${facts.dir}/fanout.json and run its \`slice\` command with your key (${facts.key}) at the end: the base, house-rules and drafts-state paths are in it. Write ${facts.dir}/fragments/${facts.key}.json.`,
  task,
  beatLine(facts),
  `Finish with: ${handbackCommand(facts, '--state done --outcome "<one line>"')} (--state stopped if you give up: never failed).`,
];

const finisherBody: Body = (facts, { task }) => [
  `Checkout: ${facts.worktree}, branch ${facts.branch} (read ${facts.checkout}/AGENTS.md first). Finish a fanned-out story: story ${facts.story}, folder ${facts.dir}. Read skills/once-upon/SKILL.md step 3d.`,
  `Keys to write yourself: ${facts.failed || 'none'}.`,
  task,
  beatLine(facts),
  facts.prDraft ? PR_DRAFT : null,
  `Publish with --agent ${facts.name}; end your report with the line saying the story's questions are yours. When it is parked for review, finish with: ${handbackCommand(facts, '--state review --outcome "<story id>"')}`,
  STUCK,
];

/** What differs per shape: the lines after the opening one. */
const BODIES: Record<Shape, Body> = {
  author: authorBody,
  plan: authorBody,
  build: authorBody,
  fixer: fixerBody,
  critic: criticBody,
  storyteller: storytellerBody,
  helper: helperBody,
  writer: writerBody,
  finisher: finisherBody,
};

/** The brief for a run, as the prompt of its Agent call. */
export function renderBrief(facts: BriefFacts): string {
  const parts: Parts = {
    check: facts.check ? `Success check (work until it passes): ${facts.check}` : null,
    task: facts.task ? `Task: ${facts.task}` : null,
    note: facts.note ? `Card note:\n${facts.note}` : null,
    checkout: `Checkout: ${facts.checkout} (read its AGENTS.md first).`,
    home: `Notes file: ${facts.notes}.`,
  };
  const rules = facts.rules
    ? `Standing rules for your role (you were launched as a general-purpose agent, so they are repeated here):\n${facts.rules.trim()}`
    : null;
  const lines = [
    `You are ${facts.name}, ${ROLE_WORD[facts.shape]}. Card ${facts.card}: ${facts.title}.`,
    ...BODIES[facts.shape](facts, parts),
    rules,
    facts.extra?.trim() || null,
  ];
  return lines.filter((line): line is string => !!line).join('\n') + '\n';
}

/** The first line `dispatch` prints: the arguments of the Agent call, which the editor copies. */
export function agentCall(call: {
  subagentType: string;
  name: string;
  model: string;
  effort: string;
  description: string;
}): string {
  return `AGENT-CALL subagent_type=${call.subagentType} name=${call.name} model=${call.model} effort=${call.effort} run_in_background=true description="${call.description}"`;
}
