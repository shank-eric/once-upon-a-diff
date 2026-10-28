/**
 * Listeners on the board. `once-upon wait` writes a heartbeat (listeners.ts) naming its repo or story and its own pid. The
 * Claude Code session that runs it is an ancestor of that process, so walking the parent chain until a pid that the
 * session registry knows says which session listens. From that the board shows a "listening" mark on a story's card,
 * and a Listeners lane with a row per repo: who listens for it, since when, the last request it was handed, or when it
 * last had a listener (listener-history.json, the last week), with Start and Stop.
 */
import { sameRepo } from '../config/repos.ts';
import { readFixes } from '../inbox/fixes.ts';
import { Builds } from '../inbox/builds.ts';
import { readHanded } from '../inbox/conversation.ts';
import type { Listener } from '../listeners/listeners.ts';
import type { LedgerAgent } from './ledger.ts';
import type { LiveSession, SourceStatus } from './sources.ts';
import { noteListener, readHistory } from '../listeners/history.ts';
import { run } from './sources.ts';
import type {
  BoardAssign,
  BoardBuild,
  BoardCard,
  BoardListenerRepo,
  BoardListening,
  BoardSession,
} from '@once-upon-a-diff/shared/types';

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
 * The sessions whose only activity is a listener's wait, which the board shows in the Listeners lane and nowhere else. The
 * wait is a background task, so the terminal calls the session working while it waits; that is not work. A session counts
 * when it has a live wait that is waiting (not one that has handed something over: that session is at work), the
 * registry says it is not in a turn, the tab's background tasks are no more than its waits, and it has no running, waiting,
 * plan or fixing ledger agent. Anything else (a build, an answer, another tool running) makes it an ordinary card.
 */
export function listeningOnly(
  live: LiveSession[],
  known: Map<string, SourceStatus>,
  waits: Listener[],
  parents: Map<number, number>,
  sessionByPid: Map<number, string>,
  agents: LedgerAgent[],
): Set<string> {
  const quiet = new Set<string>();
  for (const session of live) {
    if (session.status === 'busy') {
      continue;
    }
    const mine = waits.filter(
      (wait) => sessionOfPid(wait.pid, parents, sessionByPid) === session.session,
    );
    if (!mine.length || mine.some((wait) => wait.state !== 'waiting')) {
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
    // "1 background task running" is the wait itself; a session with more tasks than waits is doing something besides
    const tasks = /^(\d+) background tasks? running$/.exec(
      known.get(session.session)?.detail ?? '',
    );
    const status = known.get(session.session)?.status;
    if (status === 'waiting' || status === 'error' || (tasks && Number(tasks[1]) > mine.length)) {
      continue;
    }
    quiet.add(session.session);
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
      return {
        repo,
        active: active
          ? {
              ...listeningOf(active, input),
              state: active.state,
              since: entry?.started_at ?? null,
              last_handled_at: lastHandled(input.home, active.consumer),
            }
          : null,
        last_seen: entry?.last_seen ?? null,
        candidates: [...input.idle]
          .filter((id) => {
            const owner = input.repoOf.get(id);
            return !!owner && sameRepo(owner, repo) && input.sessions.get(id)?.focus;
          })
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
          ),
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
 * What Build story types into a session for a card, or null when the card has no use for it: a card with a session and a
 * PR or branch, and no story yet. The line is the once-upon skill's own command: `/once-upon <PR url>`, or for commits
 * with no PR a plain sentence naming the branch (the skill's "local commits" path).
 */
export function buildFor(card: BoardCard, idle: Set<string>): BoardBuild | null {
  if (card.kind !== 'work' || card.story || !card.sessions.length || !card.repo) {
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

/**
 * The sessions Assign may hand a backlog item to: at the prompt, with an iTerm tab, in the item's repo (any repo for an item
 * with none), and not the voice session, one that listens, or one already holding a live assignment. Blank sessions (no
 * prompt yet) first, then the rest freshest first.
 */
export function assignCandidates(
  repo: string | null,
  input: ListeningInput,
  skip: Set<string>,
  blank: Set<string>,
): BoardAssign['candidates'] {
  return [...input.idle]
    .filter((id) => {
      const view = input.sessions.get(id);
      if (!view?.focus || skip.has(id)) {
        return false;
      }
      const owner = input.repoOf.get(id);
      return repo ? !!owner && sameRepo(owner, repo) : true;
    })
    .map((id) => {
      const view = input.sessions.get(id) as BoardSession;
      return {
        id,
        title: view.title ?? id,
        status: view.status === 'done' ? ('done' as const) : ('idle' as const),
        since: view.since ?? null,
        branch: view.branch ?? null,
        repo: input.repoOf.get(id) ?? null,
        blank: blank.has(id),
      };
    })
    .sort(
      (first, second) =>
        Number(second.blank) - Number(first.blank) ||
        (Date.parse(second.since || '') || 0) - (Date.parse(first.since || '') || 0),
    );
}

/** The listen prompt Start listening types, the one the panel's Copy prompt for Claude copies. */
export const listenPromptFor = (repo: string): string => `/once-upon-listen ${repo}`;
