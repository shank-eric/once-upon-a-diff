/**
 * The board's other half of "who may be typed into": which sessions Start listening and Build story may use, the prompts they
 * type, and a card's Build story and Review. What listeners there are and the Listeners lane are features/listeners/board-view.ts.
 */
import path from 'node:path';
import { sameRepo } from '../../foundation/repos.ts';
import { DEFAULT_BRANCHES } from '../../foundation/settings.ts';
import type {
  BoardBuild,
  BoardCard,
  BoardListenerRepo,
  BoardReview,
  BoardSession,
} from '@once-upon-a-diff/contracts/types';
import { prUrl } from '@once-upon-a-diff/domain/github-urls';

export interface ListeningInput {
  home: string;
  now: number;
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** every live session on the board, the voice session too, by id */
  sessions: Map<string, BoardSession>;
  /** each live session's repo (owner/name), for picking one to start a listener in */
  repoOf: Map<string, string | null>;
  /** sessions that may be typed into: not busy, not waiting on you */
  idle: Set<string>;
  /** the listener sessions that are busy (a turn, a request being handled, other tasks): the lane says so */
  busy: ReadonlySet<string>;
  /** sessions that take no new job (Start listening): the voice session and any that already listens */
  apart: ReadonlySet<string>;
}

/**
 * The sessions Start listening may type into for a repo, on the board, the panel, the PR pages and the local page alike: idle
 * (at its prompt), in a checkout of the repo, with an iTerm tab the board can find, and not the voice session or one that
 * already listens (`input.apart`, the same set Assign leaves out). Freshest first. `skip` leaves out more.
 */
export function listenCandidates(
  repo: string,
  input: ListeningInput,
  skip: ReadonlySet<string> = new Set(),
): BoardListenerRepo['candidates'] {
  return candidatesWhere(input, skip, (id) => {
    const owner = input.repoOf.get(id);
    return !!owner && sameRepo(owner, repo);
  });
}

/** Whether `dir` is `root` or inside it. */
export const withinDir = (dir: string, root: string): boolean =>
  dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * The same rule for a story whose repo is unknown (a local story of a checkout with no origin): the sessions that are in
 * the story's own checkout folder.
 */
export function listenCandidatesIn(
  dir: string,
  input: ListeningInput,
  skip: ReadonlySet<string> = new Set(),
): BoardListenerRepo['candidates'] {
  return candidatesWhere(input, skip, (id) => {
    const cwd = input.sessions.get(id)?.cwd;
    return !!cwd && withinDir(cwd, dir);
  });
}

function candidatesWhere(
  input: ListeningInput,
  skip: ReadonlySet<string>,
  match: (id: string) => boolean,
): BoardListenerRepo['candidates'] {
  return [...input.idle]
    .filter(
      (id) => !skip.has(id) && !input.apart.has(id) && match(id) && input.sessions.get(id)?.focus,
    )
    .map((id) => {
      const view = input.sessions.get(id);
      return {
        id,
        title: view?.title ?? id,
        status: view?.status === 'done' ? ('done' as const) : ('idle' as const),
        since: view?.since ?? null,
      };
    })
    .sort(
      (first, second) =>
        (Date.parse(second.since || '') || 0) - (Date.parse(first.since || '') || 0),
    );
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
/**
 * A folder that can be typed, quoted in backticks, in a sentence: absolute, and nothing that could end the line or the
 * quote: no control characters (C0 or C1), no whitespace but a plain space (tabs, line and paragraph separators, no-break
 * spaces), no backtick.
 */
const safePath = (dir: string): boolean =>
  dir.startsWith('/') &&
  dir.length <= 500 &&
  [...dir].every((char) => {
    const code = char.codePointAt(0) as number;
    if (code < 32 || (code >= 127 && code <= 159) || char === '`') {
      return false;
    }
    return char === ' ' || !/\s/u.test(char);
  });

/**
 * What Build story types into a session for a card, or null when the card has no use for it: a card with a session and a
 * PR or branch, and no story yet (a storyless review counts as none). The line is the once-upon skill's own command:
 * `/once-upon <PR url>`, or for commits with no PR a plain sentence naming the branch (the skill's "local commits" path).
 * A finished author's commit in Ready for your review (an agent card with `review`) goes to the session that launched
 * it, as a plain request naming the branch and its worktree, never the slash command: that session decides who runs the
 * skill (a dispatcher hands it to an agent).
 */
export function buildFor(card: BoardCard, idle: Set<string>): BoardBuild | null {
  if (card.kind === 'agent') {
    return authorBuild(card, idle);
  }
  if (
    card.kind !== 'work' ||
    (card.story && !card.story.storyless) ||
    !card.sessions.length ||
    !card.repo
  ) {
    return null;
  }
  const number = card.pr?.number;
  let prompt: string | null = null;
  if (number) {
    prompt = `/once-upon ${prUrl(card.repo, number)}`;
  } else if (card.branch && SAFE_BRANCH.test(card.branch)) {
    prompt = `/once-upon tell the story of the unpushed commits on branch ${card.branch}`;
  }
  if (!prompt) {
    return null;
  }
  const mapped = card.sessions.filter((session) => session.focus);
  const free = mapped.find((session) => idle.has(session.id));
  if (free) {
    return { session: free.id, prompt, blocked: null };
  }
  return { session: null, prompt, blocked: mapped.length ? 'session busy' : 'no iTerm tab' };
}

/** Build story on a finished author's own card: typed into its launching session (`focus_session`) when that is idle. */
function authorBuild(card: BoardCard, idle: Set<string>): BoardBuild | null {
  const review = card.review;
  if (!review || !SAFE_BRANCH.test(review.branch) || !safePath(review.path)) {
    return null;
  }
  const prompt = `Build the Once Upon story of the unpushed commits on branch ${review.branch} in \`${review.path}\``;
  const launcher = card.focus_session;
  if (!launcher) {
    return { session: null, prompt, blocked: 'its session has ended' };
  }
  if (!card.can_focus) {
    return { session: null, prompt, blocked: 'no iTerm tab' };
  }
  return idle.has(launcher)
    ? { session: launcher, prompt, blocked: null }
    : { session: null, prompt, blocked: 'session busy' };
}

/**
 * Review on a work or session card, or null: a branch (not a default one) with no PR and no story, or only a storyless
 * review (Review again re-pins it to the branch's tip), whose work has not shipped (`shipped`: its PR merged, or the
 * scanner says it is merged or superseded), in the checkout of a session on that branch (a session alone on such a branch
 * is a session card), else the storyless review's own checkout (`card.review`, set with the card: stages/cards.ts). An
 * agent card's review is set where it is placed (stages/agents.ts).
 */
export function reviewFor(
  card: BoardCard,
  shipped: (repo: string, branch: string) => boolean = () => false,
): BoardReview | null {
  if (
    (card.kind !== 'work' && card.kind !== 'session') ||
    (card.story && !card.story.storyless) ||
    card.pr ||
    !card.repo ||
    !card.branch ||
    DEFAULT_BRANCHES.has(card.branch) ||
    shipped(card.repo, card.branch)
  ) {
    return null;
  }
  const there = card.sessions.find((session) => session.branch === card.branch);
  const path = there?.cwd ?? (card.story && card.review?.path) ?? null;
  return path ? { branch: card.branch, path } : null;
}

/** The listen prompt Start listening types (the status API's `prompt`, shown too for typing by hand). */
export const listenPromptFor = (repo: string): string => `/once-upon-listen ${repo}`;

/** The one-story form (listenPrompt({story}).prompt). */
export const listenStoryPromptFor = (story: string): string => `/once-upon-listen --story ${story}`;
