/**
 * Listeners on the board. `once-upon wait` writes a heartbeat (listeners.ts) naming its repo or story and its own pid. The
 * Claude Code session that runs it is an ancestor of that process, so walking the parent chain until a pid that the
 * session registry knows says which session listens. From that the board shows a "listening" mark on a story's card,
 * and a Listeners lane with a row per repo: who listens for it, since when, the last request it was handed, or when it
 * last had a listener (listener-history.json, the last week), with Start and Stop.
 */
import path from 'node:path';
import { sameRepo } from '../config/repos.ts';
import { readFixes } from '../inbox/fixes.ts';
import { Builds } from '../inbox/builds.ts';
import { readHanded } from '../inbox/conversation.ts';
import type { Listener } from '../listeners/listeners.ts';
import type { LedgerAgent } from '../ledger/ledger.ts';
import type { SourceStatus } from '../../adapters/status-source.ts';
import type { LiveSession } from '../../adapters/claude-sessions/live-sessions.ts';
import { noteListener, readHistory } from '../listeners/history.ts';
import { run } from '../../adapters/os.ts';
import { DEFAULT_BRANCHES } from '../config/settings.ts';
import type {
  BoardBuild,
  BoardCard,
  BoardListenerRepo,
  BoardListening,
  BoardReview,
  BoardSession,
} from '@once-upon-a-diff/protocol/types';

/** {pid: parent pid} for every process, from one `ps`. Empty when ps can't say. */
export async function parentMap(): Promise<Map<number, number>> {
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  const parents = new Map<number, number>();
  for (const line of (out || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) {
      parents.set(Number(match[1]), Number(match[2]));
    }
  }
  return parents;
}

/** The session whose Claude Code process is this pid or one of its ancestors, else null. */
export function sessionOfPid(
  pid: number,
  parents: Map<number, number>,
  sessionByPid: Map<number, string>,
): string | null {
  let current: number | undefined = pid;
  for (let step = 0; current && step < 32; step++) {
    const session = sessionByPid.get(current);
    if (session) {
      return session;
    }
    current = parents.get(current);
  }
  return null;
}

/**
 * Lets a handling listener find its session after its wait has exited. A wait that hands a request over writes its
 * handling beat and ends, so its pid is gone from `ps` and the parent chain no longer leads to a session. While the wait
 * ran, `memory` was told which session it was (after a bridge restart the beat's own `session`, when it names a live one, says so), so a handling beat whose
 * pid leads nowhere is hooked to that session's process in `parents`. `memory` ({consumer: session}) keeps what it learned
 * and forgets sessions that are gone. `parents` is changed.
 */
export function adoptHandlers(
  waits: Listener[],
  live: LiveSession[],
  parents: Map<number, number>,
  sessionByPid: Map<number, string>,
  memory: Map<string, string>,
): void {
  const pidOf = new Map(live.map((one) => [one.session, one.pid]));
  for (const wait of waits) {
    const found = sessionOfPid(wait.pid, parents, sessionByPid);
    if (found) {
      memory.set(wait.consumer, found);
      continue;
    }
    const named = wait.session && pidOf.has(wait.session) ? wait.session : undefined;
    const remembered = memory.get(wait.consumer) ?? named;
    const pid = remembered ? pidOf.get(remembered) : undefined;
    if (wait.state === 'handling' && pid) {
      parents.set(wait.pid, pid);
    }
  }
  for (const [consumer, session] of [...memory]) {
    if (!pidOf.has(session)) {
      memory.delete(consumer);
    }
  }
}

/**
 * The sessions whose listener is theirs to show: the board shows them in the Listeners lane and nowhere else, and the
 * answer says which of them are busy (a turn running, a request being handled, or tasks besides the wait), which the
 * lane marks. The wait is a background task, so the terminal calls a session working while it waits; that is not work,
 * and a listener that is answering a question is still the listener. A session counts when it has a live wait (waiting or
 * handling a request it was handed) and nothing that is plainly other work: no running, waiting, plan or fixing ledger
 * agent, and the tab is not waiting on you or in error. Those make it an ordinary card.
 */
export function listeningOnly(
  live: LiveSession[],
  known: Map<string, SourceStatus>,
  waits: Listener[],
  parents: Map<number, number>,
  sessionByPid: Map<number, string>,
  agents: LedgerAgent[],
): Map<string, boolean> {
  const quiet = new Map<string, boolean>();
  for (const session of live) {
    const mine = waits.filter(
      (wait) => sessionOfPid(wait.pid, parents, sessionByPid) === session.session,
    );
    if (!mine.length) {
      continue;
    }
    if (
      agents.some(
        (agent) =>
          session.session.startsWith(agent.sid) &&
          (agent.state === 'running' ||
            agent.state === 'waiting' ||
            agent.state === 'plan' ||
            agent.state === 'fixing'),
      )
    ) {
      continue;
    }
    const status = known.get(session.session)?.status;
    if (status === 'waiting' || status === 'error') {
      continue;
    }
    // "1 background task running" is the wait itself; more tasks than waits is something besides listening
    const tasks = known.get(session.session)?.tasks ?? null;
    const waiting = mine.filter((wait) => wait.state === 'waiting').length;
    quiet.set(
      session.session,
      session.status === 'busy' ||
        mine.some((wait) => wait.state === 'handling') ||
        (tasks !== null && tasks > waiting),
    );
  }
  return quiet;
}

/** The latest time a request was handed to this consumer: a question, or a build or fix request it claimed. */
export function lastHandled(home: string, consumer: string): string | null {
  const times = [
    ...Object.values(readHanded(home))
      .filter((handed) => handed.consumer === consumer)
      .map((handed) => handed.at),
    ...Object.values(new Builds(home).all())
      .filter((build) => build.claimed_by === consumer)
      .map((build) => build.claimed_at),
    ...Object.values(readFixes(home))
      .filter((fix) => fix.claimed_by === consumer)
      .map((fix) => fix.claimed_at),
  ].filter((time): time is string => !!time && !Number.isNaN(Date.parse(time)));
  return times.sort((first, second) => Date.parse(second) - Date.parse(first))[0] ?? null;
}

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

function listeningOf(listener: Listener, input: ListeningInput): BoardListening {
  const session = sessionOfPid(listener.pid, input.parents, input.sessionByPid);
  const view = session ? input.sessions.get(session) : undefined;
  return {
    consumer: listener.consumer,
    session,
    title: view?.title ?? null,
    can_focus: view?.focus ?? false,
  };
}

/** The live listener attached to a story, as the card shows it. */
export function storyListening(
  storyId: string,
  live: Listener[],
  input: ListeningInput,
): BoardListening | null {
  const found = live.find((listener) => listener.story === storyId);
  return found ? listeningOf(found, input) : null;
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

/** The Listeners lane: a row per repo with a live listener, then those that had one in the last week. */
export function listenersLane(live: Listener[], input: ListeningInput): BoardListenerRepo[] {
  const repoListeners = live.filter((listener) => listener.repo && !listener.story);
  for (const listener of repoListeners) {
    noteListener(input.home, listener.repo as string, listener.consumer, input.now);
  }
  const history = readHistory(input.home, input.now);
  const repos = new Map<string, string>();
  for (const listener of repoListeners) {
    repos.set((listener.repo as string).toLowerCase(), listener.repo as string);
  }
  for (const [key, entry] of Object.entries(history)) {
    repos.set(key, repos.get(key) ?? entry.repo);
  }
  return [...repos.values()]
    .map((repo): BoardListenerRepo => {
      const active = repoListeners.find(
        (listener) => listener.repo && sameRepo(listener.repo, repo),
      );
      const entry = history[repo.toLowerCase()];
      const found = active ? listeningOf(active, input) : null;
      return {
        repo,
        active:
          active && found
            ? {
                ...found,
                state: active.state,
                busy:
                  active.state === 'handling' || (!!found.session && input.busy.has(found.session)),
                since: entry?.started_at ?? null,
                last_handled_at: lastHandled(input.home, active.consumer),
              }
            : null,
        last_seen: entry?.last_seen ?? null,
        candidates: listenCandidates(repo, input),
      };
    })
    .sort((first, second) => {
      if (!!first.active !== !!second.active) {
        return first.active ? -1 : 1;
      }
      return first.repo.localeCompare(second.repo);
    });
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
    prompt = `/once-upon https://github.com/${card.repo}/pull/${number}`;
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
