/*
 * What `once-upon compact` keeps of agents.jsonl. The log only grows, so a run that is over for good goes (to the archive), and a run that
 * stays keeps one beat. It plans from the lines and returns lines, never new ones: the format and the fold are untouched,
 * and what the fold tells about every run that stays is what it told before.
 *
 * A run goes, with every event it has (its start, state, branch, card and finish lines, found by the `run` they name, and by
 * its place after the id's latest start for a line that names none), when it is over, it ended before the cutoff (the end of its latest finish: the agent's own replaces the SubagentStop hook's), it did not
 * fail,
 * or its failure was acknowledged (`agent ack`) or a later start of its id replaced it (an unacked failed run that is its id's latest stays: it is what the board shows as failed), and its card is done, dropped or none (and so is every card its finishes
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
  /** a later start of its id came: the board shows only an id's latest run, so a failure here is no longer shown */
  replaced: boolean;
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
  if (current) {
    current.replaced = true;
  }
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
    replaced: false,
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

/** What `planAgentLines` decided: the lines to keep (in the file's order) and those of the runs that go, for the archive. */
export interface AgentPlan {
  kept: string[];
  archived: string[];
}

/**
 * Plans the lines. `cardState` tells what a card is (`open` for one that is open or started, or closed too recently; `closed` for
 * one done or dropped before the archive cutoff; undefined for one the backlog does not know, which stays like an open one). A run
 * ended before `cutoff` (ms) whose cards are all closed (or none), and did not fail, goes whole, to `archived`. Of the runs that
 * stay, every one keeps only its last beat, except a finished run that ended after `foldCutoff` (ms), which keeps all of them.
 */
export function planAgentLines(
  lines: string[],
  cutoff: number,
  cardState: (card: string) => CardState | undefined,
  foldCutoff = Infinity,
): AgentPlan {
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
        (run.endState !== 'failed' || run.acked || run.replaced) &&
        run.endedAt !== null &&
        run.endedAt < cutoff &&
        // a card the backlog does not know (an implicit `ic_` card, which never lands) is as live as an open one
        [run.card, ...run.named].every((card) => !card || cardState(card) === 'closed'),
    ),
  );
  // a finished run that ended after the fold cutoff keeps its beats
  const recent = (run: Run) => !run.open && (run.endedAt ?? -Infinity) >= foldCutoff;
  const plan: AgentPlan = { kept: [], archived: [] };
  lines.forEach((line, index) => {
    const run = runs.group.get(index);
    if (run && gone.has(run)) {
      plan.archived.push(line);
    } else if (!run || events[index]?.op !== 'beat' || run.lastBeat === index || recent(run)) {
      plan.kept.push(line);
    }
  });
  return plan;
}

/** The lines `planAgentLines` keeps, thinning every run's beats. */
export function compactAgentLines(
  lines: string[],
  cutoff: number,
  cardState: (card: string) => CardState | undefined,
): string[] {
  return planAgentLines(lines, cutoff, cardState).kept;
}
