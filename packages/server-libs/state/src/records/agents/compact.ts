/*
 * What `once-upon doctor --fix` keeps of agents.jsonl. The log only grows, so a run that is over for good goes, and a run that
 * stays keeps one beat. It plans from the lines and returns lines, never new ones: the format and the fold are untouched,
 * and what the fold tells about every run that stays is what it told before.
 *
 * A run goes, with every event it has (its start, state, branch, card and finish lines, found by the `run` they name, and by
 * its place after the id's latest start for a line that names none), when it is over, it ended before the cutoff (the end of its latest finish: the agent's own replaces the SubagentStop hook's), it did not
 * fail or its failure was acknowledged (`agent ack`: an unacked failed run stays, it is what the board shows as failed), and its card is done, dropped or none (and so is every card its finishes
 * named): a run on an open or started card, or on a card the backlog does not know (an implicit `ic_` card: it never lands, and
 * its runs are all there is of it), is the card's history, and a deploy matches a card to the commit its finish recorded. A run that stays keeps
 * only the last `beat` the fold applied (a beat is the only event that overwrites the one before it, and a beat after the run
 * ended, or one for a run a newer start replaced, changes nothing). A line that is not an event stays as it is.
 *
 * Pure: the caller reads the cards and the clock, and writes (adapters' `replaceLog`).
 */
import { readAgentEvent, type AgentEvent } from '@once-upon-a-diff/contracts/files/schemas';

export type CardState = 'open' | 'closed';

interface Run {
  /** the run id its start named, when it did */
  runId: string | null;
  card: string | null;
  /** the cards its finishes named (`result.card`): a deploy gives the commit to one of them */
  named: Set<string>;
  open: boolean;
  /** how it ended (`stopped` for a run the next start replaced), when it did */
  endState: string | null;
  endedAt: number | null;
  /** its end was the SubagentStop hook's: the agent's own finish or state replaces it */
  hooked: boolean;
  /** a failed run acknowledged (`agent ack`) */
  acked: boolean;
  lastBeat: number;
  events: number[];
}

const isOpenState = (state: string | undefined) =>
  state === 'running' ||
  state === 'waiting' ||
  state === 'plan' ||
  state === 'fixing' ||
  state === 'review';

/** The runs the events tell: all of them, an id's latest, `id/run` to the run it names, and a line to its run. */
interface Runs {
  all: Run[];
  latest: Map<string, Run>;
  byName: Map<string, Run>;
  group: Map<number, Run>;
}

function startRun(runs: Runs, event: AgentEvent, index: number, when: number): void {
  const current = runs.latest.get(event.id);
  if (current?.open) {
    current.open = false;
    current.endState = 'stopped';
    current.endedAt = when;
  }
  const run: Run = {
    runId: event.run ?? null,
    card: event.card ?? null,
    named: new Set(),
    open: true,
    endState: null,
    endedAt: null,
    hooked: false,
    acked: false,
    lastBeat: -1,
    events: [index],
  };
  runs.all.push(run);
  runs.latest.set(event.id, run);
  if (event.run) {
    runs.byName.set(`${event.id}/${event.run}`, run);
  }
  runs.group.set(index, run);
}

/** A state or a finish the run takes: running again or ending, and what the hook's end and its ack become. */
function endOrResume(run: Run, event: AgentEvent, when: number): void {
  const state = event.state ?? '';
  if (event.op === 'state') {
    run.hooked = false;
    run.acked = false; // a state after the hook's end: the stop was not the end, and its ack goes
  } else {
    run.hooked = event.by === 'auto-finish';
  }
  run.open = event.op === 'state' && isOpenState(state);
  if (!run.open) {
    run.endState = state;
    run.endedAt = when;
  }
}

/** Whether the fold applies the event to the run: the latest, open (or its hook's end being replaced), and the event names it or none. */
function foldTakes(run: Run, current: Run | undefined, event: AgentEvent): boolean {
  // the agent's own finish or state after the hook's end replaces it
  const replaces =
    (event.op === 'finish' || event.op === 'state') && run.hooked && event.by !== 'auto-finish';
  const mine = !event.run || !run.runId || event.run === run.runId;
  return (run.open || replaces) && run === current && mine;
}

function noteEvent(runs: Runs, event: AgentEvent, index: number, when: number): void {
  const current = runs.latest.get(event.id);
  const named = event.run ? runs.byName.get(`${event.id}/${event.run}`) : undefined;
  const run = named ?? current;
  if (!run) {
    return; // before any start of its id: not a run's, stays
  }
  runs.group.set(index, run);
  run.events.push(index);
  if (event.op === 'finish' && event.result?.card) {
    run.named.add(event.result.card);
  }
  if (event.op === 'card') {
    if (named && event.card) {
      run.card = event.card;
    }
  } else if (event.op === 'ack') {
    // an ack marks a run that is over, by the run it names, whatever else has started since
    if (named && !named.open) {
      named.acked = true;
    }
  } else if (foldTakes(run, current, event)) {
    foldRunEvent(run, event, index, when);
  }
}

/** An event the fold applies to the run: a beat is the last one kept, a state or a finish ends or resumes it. */
function foldRunEvent(run: Run, event: AgentEvent, index: number, when: number): void {
  if (event.op === 'beat') {
    run.lastBeat = index;
  } else if (event.op === 'state' || event.op === 'finish') {
    endOrResume(run, event, when);
  }
}

/**
 * The lines to keep, in the file's order. `cardState` tells what a card is (`open` for one that is open or started;
 * `closed` for one done or dropped; undefined for one the backlog does not know, which stays like an open one); a run ended
 * before `cutoff` (ms) whose cards are all closed (or none), and did not fail, goes.
 */
export function compactAgentLines(
  lines: string[],
  cutoff: number,
  cardState: (card: string) => CardState | undefined,
): string[] {
  const events: (AgentEvent | null)[] = lines.map((line) => {
    try {
      return readAgentEvent(JSON.parse(line)) ?? null;
    } catch {
      return null;
    }
  });
  const runs: Runs = { all: [], latest: new Map(), byName: new Map(), group: new Map() };
  events.forEach((event, index) => {
    if (!event) {
      return;
    }
    const when = Date.parse(event.at);
    if (event.op === 'start') {
      startRun(runs, event, index, when);
    } else {
      noteEvent(runs, event, index, when);
    }
  });
  const gone = new Set<Run>(
    runs.all.filter(
      (run) =>
        !run.open &&
        (run.endState !== 'failed' || run.acked) &&
        run.endedAt !== null &&
        run.endedAt < cutoff &&
        // a card the backlog does not know (an implicit `ic_` card, which never lands) is as live as an open one
        [run.card, ...run.named].every((card) => !card || cardState(card) === 'closed'),
    ),
  );
  return lines.filter((line, index) => {
    const run = runs.group.get(index);
    if (!run) {
      return true;
    }
    if (gone.has(run)) {
      return false;
    }
    return events[index]?.op !== 'beat' || run.lastBeat === index;
  });
}
