/*
 * The subagents nobody registered (a quick lookup, a web fetch: no `once-upon agent start`), as light rows on the card or strip
 * entry of the session that launched them. They come from the session's subagent transcripts (adapters/claude-sessions/
 * subagent-liveness.ts), have no card of their own and never move a column. A subagent that IS a registered run is dropped
 * here, so no agent shows twice. Pure: the transcripts are read by the caller.
 */
import type {
  SubagentFile,
  SubagentLiveness,
} from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import { agentId } from '@once-upon-a-diff/terms/ids';
import { QUIET_MS } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { BuildContext } from './types.ts';
import type { BoardData, BoardSubagent, BoardSubagents } from '@once-upon-a-diff/contracts/types';

/** The finished rows a card or entry shows; the rest are counted in `older`, never dropped silently. */
export const DONE_CAP = 20;

/** A ledger run of a session, by the first 8 of its id, as far as telling it from an unregistered subagent needs. */
export interface RegisteredRun {
  name: string;
  task: string | null;
  /** when the run started and ended, when the ledger says: the task-prefix match only counts for a run alive alongside the subagent */
  started?: Date | null;
  ended?: Date | null;
}

const normal = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Shorter than this, a description or task says too little to tell two subagents apart by its start. */
const MIN_MATCH = 12;

/** Whether the run was alive while the subagent was: started no later than it ended (or now), not finished before it started. A run with no dates counts. */
function overlaps(file: SubagentFile, run: RegisteredRun): boolean {
  const started = run.started?.getTime();
  const ended = run.ended?.getTime();
  return (
    (started === undefined || file.endedMs === null || started <= file.endedMs) &&
    (ended === undefined || ended >= file.startedMs)
  );
}

/**
 * Whether a subagent is the registered run: its name (the tool's `name` or the description's `<name>:` prefix, whatever its
 * letters), the description's first word, or its description against the start of the run's task (a run launched with a plain
 * description) when the run's life overlaps the subagent's, so an old run's task never hides a new subagent. What cannot be matched shows as a row too: the residue is a registered run launched with a description that
 * names neither.
 */
function isRegistered(file: SubagentFile, runs: RegisteredRun[]): boolean {
  const first = file.description?.split(/[\s:]/, 1)[0];
  const text = file.description ? normal(file.description) : '';
  return runs.some((run) => {
    if (file.name === run.name || first === run.name) {
      return true;
    }
    const task = run.task ? normal(run.task) : '';
    return (
      overlaps(file, run) &&
      text.length >= MIN_MATCH &&
      task.length >= MIN_MATCH &&
      (task.startsWith(text) || text.startsWith(task))
    );
  });
}

/** The light rows of one session's subagent transcripts: the unregistered ones, running first, then the newest. */
export function unregisteredRows(
  files: SubagentFile[],
  sid: string,
  registered: RegisteredRun[],
): BoardSubagent[] {
  return files
    .filter((file) => !isRegistered(file, registered))
    .map((file) => ({
      key: agentId(sid, file.id),
      name: file.name,
      description: file.description ?? file.agentType ?? 'subagent',
      agent_type: file.agentType,
      state: file.state,
      started_at: new Date(file.startedMs).toISOString(),
      ended_at: file.endedMs === null ? null : new Date(file.endedMs).toISOString(),
    }))
    .sort(order);
}

/** Rows as a card or entry shows them: every running one, the newest `DONE_CAP` finished ones, the count of the rest. Null when there are none. */
export function capped(rows: BoardSubagent[]): BoardSubagents | null {
  if (!rows.length) {
    return null;
  }
  const done = rows.filter((row) => row.state === 'done');
  const keep = new Set(done.slice(0, DONE_CAP));
  return {
    rows: rows.filter((row) => row.state === 'running' || keep.has(row)),
    older: Math.max(0, done.length - DONE_CAP),
  };
}

/** Every session the board shows somewhere: on a card, or in the voice, editors, listeners or blank strips. */
export function shownSessions(data: BoardData): string[] {
  return [
    ...new Set([
      ...data.lanes.flatMap((lane) =>
        lane.cards.flatMap((card) => card.sessions.map((session) => session.id)),
      ),
      ...(data.voice ? [data.voice.session] : []),
      ...data.editors.map((editor) => editor.session),
      ...data.listeners.flatMap((entry) => (entry.active?.session ? [entry.active.session] : [])),
      ...data.blank.flatMap((group) => group.sessions.map((one) => one.id)),
    ]),
  ];
}

/** Sets `subagents` on each card and strip entry whose sessions have rows (`bySession`, by session id). Changes `data`. */
export function attachSubagents(data: BoardData, bySession: Map<string, BoardSubagent[]>): void {
  const rowsOf = (ids: string[]) =>
    capped(ids.flatMap((id) => bySession.get(id) ?? []).sort(order));
  for (const lane of data.lanes) {
    for (const card of lane.cards) {
      const found = rowsOf(card.sessions.map((session) => session.id));
      if (found) {
        card.subagents = found;
      }
    }
  }
  const attach = (target: { subagents?: BoardSubagents }, ids: string[]) => {
    const found = rowsOf(ids);
    if (found) {
      target.subagents = found;
    }
  };
  if (data.voice) {
    attach(data.voice, [data.voice.session]);
  }
  for (const editor of data.editors) {
    attach(editor, [editor.session]);
  }
  for (const entry of data.listeners) {
    if (entry.active?.session) {
      attach(entry.active, [entry.active.session]);
    }
  }
  for (const group of data.blank) {
    for (const one of group.sessions) {
      attach(one, [one.id]);
    }
  }
}

/** Running first, newest start first; then the finished, the one that finished last first (a start is the file system's creation time, which not every system keeps). */
function order(left: BoardSubagent, right: BoardSubagent): number {
  const when = (row: BoardSubagent) => row.ended_at ?? row.started_at ?? '';
  return (
    Number(right.state === 'running') - Number(left.state === 'running') ||
    when(right).localeCompare(when(left))
  );
}

/**
 * Reads the unregistered subagents of every session `data` shows and attaches them (see `attachSubagents`). `ledger` is every
 * registered run, standing helpers and editors included, so none of them shows as a row too. A session's transcripts that
 * cannot be read are no rows.
 */
export async function addSubagentRows(
  ctx: BuildContext,
  liveness: SubagentLiveness,
  data: BoardData,
  ledger: LedgerAgent[],
): Promise<void> {
  const { settings, nowMs } = ctx;
  const keepMs = Math.max(
    settings.doneHours * 3600 * 1000,
    settings.finishedWaitMinutes * 60 * 1000,
  );
  const bySession = new Map<string, BoardSubagent[]>();
  for (const id of shownSessions(data)) {
    const sid = id.slice(0, 8);
    const files = await liveness.subagentsOf(settings.projectsDir, sid, nowMs, {
      quietMs: QUIET_MS,
      keepMs,
    });
    if (files.length) {
      const registered = ledger.filter((agent) => agent.sid === sid);
      bySession.set(id, unregisteredRows(files, sid, registered));
    }
  }
  attachSubagents(data, bySession);
}
