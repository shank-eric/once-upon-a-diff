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

const handbackCommand = (facts: BriefFacts, tail: string): string =>
  `fnm exec --using=24 once-upon handback ${facts.name} --sid ${facts.sid} ${tail}`;

const PR_DRAFT =
  "This repo ships by pull request: as the last step, after the final publish, draft the PR text (skills/once-upon/SKILL.md step 6) and run `once-upon pr-draft` so the story page's Create pull request button holds it; redo it after every rebuild or update. Never push or run gh pr create.";

const STUCK =
  'Stuck or capped: the same command with --state waiting --outcome "<question, or capped; notes hold the rest>".';

/** The brief for a run, as the prompt of its Agent call. */
export function renderBrief(facts: BriefFacts): string {
  const { shape, name, card, title } = facts;
  const lines: Array<string | null> = [
    `You are ${name}, ${ROLE_WORD[shape]}. Card ${card}: ${title}.`,
  ];
  const check = facts.check ? `Success check (work until it passes): ${facts.check}` : null;
  const task = facts.task ? `Task: ${facts.task}` : null;
  const note = facts.note ? `Card note:\n${facts.note}` : null;
  const checkout = `Checkout: ${facts.checkout} (read its AGENTS.md first).`;
  const home = `Notes file: ${facts.notes}.`;
  switch (shape) {
    case 'author':
    case 'plan':
    case 'build':
      lines.push(
        checkout,
        `Branch ${facts.branch}, worktree ${facts.worktree} (create it: git worktree add -b ${facts.branch} ${facts.worktree} ${facts.base}). ${home}`,
      );
      if (shape === 'plan') {
        lines.push(
          'Plan only: read the code, write your plan (files and lines, steps, tests, risks, questions) to the notes file, post beat 2/2 and stop. Write no code and make no worktree.',
        );
      }
      if (shape === 'build') {
        lines.push(
          `Build from ${facts.fromNotes}: the plan, and its "Plan check" corrections (the corrections win). Append your notes under "## Build".`,
        );
      }
      lines.push(check, task, note, beatLine(facts));
      if (shape !== 'plan') {
        lines.push(heavyLine(name));
      }
      lines.push(
        shape === 'plan'
          ? `When the plan is written, finish with: ${handbackCommand(facts, '--plan')}`
          : `When the commit is in, finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
        STUCK,
      );
      break;
    case 'fixer':
      lines.push(
        `Checkout: ${facts.worktree}, branch ${facts.branch}, base ${facts.base} (read ${facts.checkout}/AGENTS.md first). ${home}`,
        facts.findingsFrom
          ? `Fix only the checked findings in ${facts.findingsFrom}. Amend the branch’s one commit, never add a second.`
          : 'Amend the branch’s one commit, never add a second.',
        check,
        task,
        note,
        beatLine(facts),
        heavyLine(name),
        `When the amended commit is in, finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
        STUCK,
      );
      break;
    case 'critic':
      lines.push(
        `Checkout: ${facts.worktree} (read ${facts.checkout}/AGENTS.md first).`,
        `Review: git diff ${facts.base}...HEAD (the branch's own change, not the base's newer commits) in that worktree. Intent: ${facts.note ? `\n${facts.note}` : 'see the card'}${facts.task ? `\n${facts.task}` : ''}`,
        `Write findings (file:line, failure, confidence) to ${facts.out}; write nothing else.`,
        beatLine(facts),
        `Finish with: ${handbackCommand(facts, '--findings <N> --outcome "<count and file>"')}`,
      );
      break;
    case 'storyteller':
      lines.push(
        `Checkout: ${facts.worktree} (read ${facts.checkout}/AGENTS.md first). Tell the local story of branch ${facts.branch} over ${facts.base} with the once-upon skill. ${home}`,
        facts.fanOut ? 'Fan-out: yes' : null,
        task,
        note,
        beatLine(facts),
        facts.prDraft && !facts.fanOut ? PR_DRAFT : null,
        facts.fanOut
          ? `Publish the skeleton without --agent and park for the editor (SKILL.md step 3d): ${handbackCommand(facts, '--state plan --outcome "fanout <story id>: skeleton up, <N> chapters to write, <D> keys=k1,k2,..."')}. Otherwise publish with --agent ${name} and, when the story is parked for review, finish with: ${handbackCommand(facts, '--state review --outcome "<story id>"')}`
          : `Publish with --agent ${name}. When the story is parked for review, finish with: ${handbackCommand(facts, '--state review --outcome "<story id>"')}`,
        STUCK,
      );
      break;
    case 'helper':
      lines.push(
        checkout,
        home,
        check,
        task,
        note,
        beatLine(facts),
        heavyLine(name),
        `Finish with: ${handbackCommand(facts, '--outcome "<one line>"')}`,
        STUCK,
      );
      break;
    case 'writer':
      lines.push(
        checkout,
        `You write chapter ${facts.key} of the story for branch ${facts.branch}: read the once-upon skill's chapter-writer.md (skills/once-upon/chapter-writer.md in the once-upon repo, linked at ~/.claude/skills/once-upon/chapter-writer.md): its rules are yours.`,
        `Story folder: ${facts.dir}. Read ${facts.dir}/fanout.json and run its \`slice\` command with your key (${facts.key}) at the end: the base, house-rules and drafts-state paths are in it. Write ${facts.dir}/fragments/${facts.key}.json.`,
        task,
        beatLine(facts),
        `Finish with: ${handbackCommand(facts, '--state done --outcome "<one line>"')} (--state stopped if you give up: never failed).`,
      );
      break;
    case 'finisher':
      lines.push(
        `Checkout: ${facts.worktree}, branch ${facts.branch} (read ${facts.checkout}/AGENTS.md first). Finish a fanned-out story: story ${facts.story}, folder ${facts.dir}. Read skills/once-upon/SKILL.md step 3d.`,
        `Keys to write yourself: ${facts.failed || 'none'}.`,
        task,
        beatLine(facts),
        facts.prDraft ? PR_DRAFT : null,
        `Publish with --agent ${name}; end your report with the line saying the story's questions are yours. When it is parked for review, finish with: ${handbackCommand(facts, '--state review --outcome "<story id>"')}`,
        STUCK,
      );
      break;
  }
  if (facts.rules) {
    lines.push(
      `Standing rules for your role (you were launched as a general-purpose agent, so they are repeated here):\n${facts.rules.trim()}`,
    );
  }
  lines.push(facts.extra?.trim() || null);
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
