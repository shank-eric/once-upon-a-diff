/**
 * Listeners on the board. `once-upon wait` writes a heartbeat (records/listeners/listeners.ts) naming its repo or story and its
 * own pid. The Claude Code session that runs it is an ancestor of that process, so walking the parent chain until a pid that
 * the session registry knows says which session listens. From that the board shows a "listening" mark on a story's card, and a
 * Listeners lane with a row per repo: who listens for it, since when, the last request it was handed, or when it last had a
 * listener (listener-history.json, the last week), with Start and Stop.
 *
 * The lane reads only what `LaneInput` names, so the board's own ListeningInput (features/sessions/listening.ts) is passed as
 * it is, with `candidatesFor` added, and neither folder imports the other.
 */
import { canonicalRepo, repoKey } from '@once-upon-a-diff/domain/ids';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { readFixes } from '@once-upon-a-diff/state/queues/requests/fixes';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { readHanded } from '@once-upon-a-diff/state/queues/requests/conversation';
import type { Listener } from '@once-upon-a-diff/state/records/listeners/listeners';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { SourceStatus } from '@once-upon-a-diff/adapters/status-source';
import type { LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import {
  noteListener,
  readHistory,
  type History,
} from '@once-upon-a-diff/state/records/listeners/history';
import { run } from '@once-upon-a-diff/adapters/os';
import type {
  BoardListenerRepo,
  BoardListening,
  BoardSession,
} from '@once-upon-a-diff/contracts/types';

/** What a story card's listening mark needs of the board's listening input (a ListeningInput has all of it). */
export interface MarkInput {
  home: string;
  now: number;
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** every live session on the board, by id */
  sessions: Map<string, BoardSession>;
  /** the listener sessions that are busy (a turn, a request being handled, other tasks): the lane says so */
  busy: ReadonlySet<string>;
}

/** What the Listeners lane needs besides that. */
export interface LaneInput extends MarkInput {
  /** the sessions Start listening may type into for a repo (features/sessions/listening.ts listenCandidates) */
  candidatesFor(repo: string): BoardListenerRepo['candidates'];
}

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

function listeningOf(listener: Listener, input: MarkInput): BoardListening {
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
  input: MarkInput,
): BoardListening | null {
  const found = live.find((listener) => listener.story === storyId);
  return found ? listeningOf(found, input) : null;
}

/** The Listeners lane: a row per repo with a live listener, then those that had one in the last week. */
export function listenersLane(live: Listener[], input: LaneInput): BoardListenerRepo[] {
  const repoListeners = live.filter((listener) => listener.repo && !listener.story);
  for (const listener of repoListeners) {
    noteListener(input.home, listener.repo as string, listener.consumer, input.now);
  }
  // a history entry written under a named typo of a repo (ids.ts) is read as that repo's: the newest of the two
  const history: History = {};
  for (const [key, entry] of Object.entries(readHistory(input.home, input.now))) {
    const same = history[repoKey(key)];
    if (!same || Date.parse(same.last_seen) < Date.parse(entry.last_seen)) {
      history[repoKey(key)] = { ...entry, repo: canonicalRepo(entry.repo) };
    }
  }
  const repos = new Map<string, string>();
  for (const listener of repoListeners) {
    repos.set(repoKey(listener.repo), canonicalRepo(listener.repo as string));
  }
  for (const [key, entry] of Object.entries(history)) {
    repos.set(key, repos.get(key) ?? entry.repo);
  }
  return [...repos.values()]
    .map((repo): BoardListenerRepo => {
      const active = repoListeners.find(
        (listener) => listener.repo && sameRepo(listener.repo, repo),
      );
      const entry = history[repoKey(repo)];
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
        candidates: input.candidatesFor(repo),
      };
    })
    .sort((first, second) => {
      if (!!first.active !== !!second.active) {
        return first.active ? -1 : 1;
      }
      return first.repo.localeCompare(second.repo);
    });
}
