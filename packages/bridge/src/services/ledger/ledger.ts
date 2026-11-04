/**
 * The background agents the board shows inside their parent session's card. Agents registered through
 * `once-upon agent start|state|beat|finish` come from <home>/agents.jsonl (events.ts, registry.ts) and are never parsed
 * from text; this file reads the older source, two optional text files (the settings board_ledger_file and
 * board_progress_file), still used for agents nobody registered and for old history. read.ts merges the two, and the
 * registry writes both files' lines as views of its events when the settings name them.
 *
 * The ledger has one line per event, appended by whatever launches the agents:
 *
 *   - [running] sid:<8 hex> [lane:<name>] <name> (model, effort) — task — started 1:50 PM ET, 10/26
 *   - [done] sid:<8 hex> [lane:<name>] <name> — 1:33 PM ET, 10/26 — outcome — notes path
 *   - [waiting] sid:<8 hex> [lane:<name>] <name> — 1:40 PM ET, 10/26 — needs <you>: question — notes path
 *
 * The time can come before the outcome (`— 1:40 PM ET, 10/26 — outcome`) or after it (`— outcome — 1:40 PM ET, 10/26`).
 * [failed] and [stopped] work like [done]. [waiting] is an agent that has finished but whose result needs a decision:
 * the board puts it in the waiting column with the question, until a later [done] or [stopped] line clears it.
 * [review] is an agent that has finished and is parked on your story review (`— story <id> up, <what changed>`): it
 * reads as state 'waiting' with `review` set, so every open list still holds it, but the board shows it as ready for
 * review instead of as a question, in the card its registered branch or PR names (a ledger line registers none) or a Ready card of its own. A later line clears it.
 *
 * Two more statuses mean the launching session, not you, is the next actor, and put the card in Agent checks:
 *
 *   - [plan] sid:<8 hex> [lane:<name>] <name> — 10:30 AM ET, 10/27 — plan ready: <one line> — notes path
 *   - [fixing] sid:<8 hex> [lane:<name>] review-<x> — 10:55 AM ET, 10/27 — 5 findings — notes path
 *
 * [plan] is a build agent stopped at its plan; a later [running] line (plan checked, building) or a [done] clears it.
 * [fixing] is written under the critic's name when the launcher starts on the findings (the first "<n> findings" in
 * its text is the count); a later [done] under that name clears it. A running agent whose name starts with review- is
 * a critic, which is a gate too, with no line of its own. sid is the first 8 characters of the launching session's id, and the name
 * is a word of letters, digits, dashes and underscores. A lane tag only names the lane of an agent's own card (the board
 * nests an agent by its registered repo, branch, PR or card, agent-home.ts, whatever its tag says). The last line with a given sid and name wins. Lines that don't match are skipped.
 *
 * A finished agent (done, failed or stopped) with no card to sit in is a card of its own: in Done when it is a critic,
 * a registered agent whose finish event has a result, or a ledger agent with a `[done]` line; in Research when a
 * registered research run has no result; and otherwise in Waiting (finishedColumn in
 * board/agent-home.ts reads fields, never the text), for the setting board_finished_wait_minutes (30; an author in
 * Waiting, kind author, stays board_done_hours, 1 hour) after its latest ledger line, with its outcome and the first `notes/` path its lines
 * name; a new line starts the time again (progress beats are not counted: they carry no date or sid). The board's Finish on that card appends a `[done]` line only for an
 * agent still `[waiting]` (doneLine), and otherwise just records the click (adapters/stores/finished-agents.ts).
 *
 * The progress file's lines are `- <time> <name> <N>/<M> <step>: <note>`; the board shows each agent's latest.
 * Both files are read from their tail only, so a long history costs nothing.
 */
import type { BoardBeat, BoardGate } from '@once-upon-a-diff/protocol/types';
import type { AgentKind, AgentResult } from './events.ts';

/** One agent as its ledger lines tell it. */
export interface LedgerAgent {
  sid: string;
  name: string;
  state: 'running' | 'waiting' | 'plan' | 'fixing' | 'done' | 'failed' | 'stopped';
  /** a `[review]` line: waiting, but on your story review and not on a question */
  review?: boolean;
  lane: string | null;
  model: string | null;
  task: string | null;
  started: Date | null;
  ended: Date | null;
  outcome: string | null;
  /** the notes file its latest line names (the first path with `notes/` in it), when it names one */
  notes?: string | null;
  /**
   * the runs before this one, oldest first: a `[running]` line after a `[done]`, `[failed]` or `[stopped]` one (a
   * SendMessage follow-up under the same name) starts a new run, and the finished one is kept here as it stood. A
   * `[running]` line after a plan, a question or a fix gate is the same run going on
   */
  earlier?: LedgerAgent[];
  /**
   * 'events' for an agent registered through `once-upon agent` (events.ts), which carries the fields below; absent or
   * 'ledger' for one read from ledger lines, which carries none of them
   */
  source?: 'events' | 'ledger';
  run?: string | null;
  /** the launching session's full id, when the agent was registered from a Claude session */
  session?: string | null;
  kind?: AgentKind | null;
  /** registered `--standing`: held out of the cards, shown in the Helpers row (a ledger agent is never standing) */
  standing?: boolean;
  repo?: string | null;
  branch?: string | null;
  /** the registered branch's tip when the run started (null when the branch did not exist yet), to tell at finish whether it moved */
  tip?: string | null;
  pr?: number | null;
  cwd?: string | null;
  card?: string | null;
  /** an editor's build slots (kind `editor`) */
  slots?: number | null;
  result?: AgentResult | null;
  findings?: number | null;
  /** this run's latest progress beat */
  beat?: BoardBeat | null;
  /** its latest event of any kind, a beat included: the sign of life staleness is measured from */
  lastEvent?: Date | null;
}

/** How far a zone is ahead of UTC at an instant, in ms. */
function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    instant
  );
}

/** The instant a wall-clock time was in a zone. */
function inZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(wall, zone);
  return new Date(wall - offsetMs(first, zone));
}

const LABELS: Record<string, string> = {
  ET: 'America/New_York',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CT: 'America/Chicago',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MT: 'America/Denver',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  UTC: 'UTC',
};
const NOTES_PATH_RE = /^\S*notes\/\S*$/;
/** A notes path inside a line: `notes/…`, `~/…/notes/…` or `/…/notes/…`, up to a space. */
const NOTES_IN_LINE_RE = /(?:^|[\s(,;])((?:~|\/)?[^\s()]*\bnotes\/[^\s()]+)/;
const TIME_RE = /(\d{1,2}):(\d{2})\s*([AP]M)(?:\s+([A-Z]{2,4}))?,\s*(\d{1,2})\/(\d{1,2})/i;

/**
 * "1:50 PM ET, 10/26" as an instant, or null. The year is this year's (last year's when that would be more than a
 * day ahead). A zone label like ET picks the zone; with none, `zone` or the system's.
 */
export function parseLedgerTime(text: string, now: Date, zone?: string): Date | null {
  const match = TIME_RE.exec(text);
  if (!match) {
    return null;
  }
  const label = match[4] ? LABELS[match[4].toUpperCase()] : undefined;
  const timeZone = label || zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') {
    hour += 12;
  }
  const month = Number(match[5]);
  const day = Number(match[6]);
  try {
    const year = Number(
      new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now),
    );
    let when = inZone(year, month, day, hour, Number(match[2]), timeZone);
    if (when.getTime() > now.getTime() + 24 * 3600 * 1000) {
      when = inZone(year - 1, month, day, hour, Number(match[2]), timeZone);
    }
    return Number.isNaN(when.getTime()) ? null : when;
  } catch {
    return null;
  }
}

const LINE_RE =
  /^\s*-\s*\[(running|waiting|review|plan|fixing|done|failed|stopped)\]\s+sid:([0-9a-f]{8})\s+(?:lane:([\w.-]+)\s+)?([\w.-]+)\s*(.*)$/;

/** The notes path a line's text names, without the punctuation after it, or null. */
function notesOf(text: string): string | null {
  const path = NOTES_IN_LINE_RE.exec(text)?.[1];
  return path ? path.replace(/[.,;:]+$/, '') : null;
}

/** The ledger's agents, one per sid and name, from the lines' text. */
export function parseLedger(text: string, now: Date, zone?: string): LedgerAgent[] {
  const agents = new Map<string, LedgerAgent>();
  for (const line of text.split('\n')) {
    const match = LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, state, sid, lane, name, rest] = match;
    const key = `${sid}:${name}`;
    const agent: LedgerAgent = agents.get(key) || {
      sid,
      name,
      state: 'running',
      review: false,
      lane: null,
      model: null,
      task: null,
      started: null,
      ended: null,
      outcome: null,
      notes: null,
    };
    if (
      state === 'running' &&
      ['done', 'failed', 'stopped'].includes(agent.state) &&
      agents.has(key)
    ) {
      agent.earlier = [...(agent.earlier ?? []), { ...agent, earlier: undefined }];
    }
    agent.state = state === 'review' ? 'waiting' : (state as LedgerAgent['state']);
    agent.review = state === 'review';
    agent.lane = lane || agent.lane;
    // a follow-up line that names no notes keeps the path an earlier line gave
    agent.notes = notesOf(rest) || agent.notes;
    if (state === 'running') {
      // (model, effort) — task — started <time>
      const model = /^\(([^)]*)\)/.exec(rest.trim());
      agent.model = model ? model[1] : agent.model;
      const task = /—\s*(.*?)\s+—\s+started\s/.exec(rest);
      agent.task = task ? task[1] : agent.task;
      agent.started =
        parseLedgerTime(rest.slice(rest.indexOf('started')), now, zone) || agent.started;
      agent.ended = null;
      agent.outcome = null;
    } else {
      // <time> — outcome — notes path, though lines in the wild put words between the name and the time, or leave the time out
      const time = TIME_RE.exec(rest);
      agent.ended = time ? parseLedgerTime(time[0], now, zone) : null;
      const after = time ? rest.slice(time.index + time[0].length) : rest;
      const outcome =
        after
          .replace(/^[^—]*—\s*/, '')
          .split(/\s+—\s+/)[0]
          .trim() || null;
      // the time can also come last (`— outcome — 6:04 PM ET, 10/29`, optionally a notes path after it): then the
      // outcome is what sits between the name's (model, effort) and the time, and a lone notes path is not one
      const before = time
        ? rest
            .slice(0, time.index)
            .split('—')
            .map((part) => part.trim())
            .slice(1)
            .filter(Boolean)
            .join(' — ')
        : '';
      agent.outcome =
        (outcome && !NOTES_PATH_RE.test(outcome) ? outcome : before || outcome) || null;
    }
    agents.set(key, agent);
  }
  return [...agents.values()];
}

/** The gate an agent is at, or null: its plan to check, findings being fixed, or a critic running. The one place for the rule. */
export function gateOf(
  agent: Pick<LedgerAgent, 'state' | 'name' | 'outcome'> &
    Partial<Pick<LedgerAgent, 'source' | 'kind' | 'findings'>>,
): BoardGate | null {
  if (agent.state === 'plan') {
    return { kind: 'plan', findings: null };
  }
  if (agent.state === 'fixing') {
    if (agent.source === 'events') {
      return { kind: 'fixing', findings: agent.findings ?? null };
    }
    const count = /(\d+)\s+findings?\b/i.exec(agent.outcome || '');
    return { kind: 'fixing', findings: count ? Number(count[1]) : null };
  }
  return agent.state === 'running' && isCritic(agent) ? { kind: 'review', findings: null } : null;
}

/** A critic: a registered agent's kind says so, and a ledger agent is one when its name starts with review-. */
export const isCritic = (
  agent: Pick<LedgerAgent, 'name'> & Partial<Pick<LedgerAgent, 'source' | 'kind'>>,
): boolean => (agent.source === 'events' ? agent.kind === 'critic' : /^review-/i.test(agent.name));

const BEAT_RE =
  /^\s*-\s*\d{1,2}:\d{2}\s*[AP]M\s+([\w.-]+)\s+(\d+)\/(\d+)\s+([\w.-]+)(?::\s*(.*))?$/i;

/** Each agent's latest progress beat, by name, from the progress file's text. */
export function parseProgress(text: string): Map<string, BoardBeat> {
  const beats = new Map<string, BoardBeat>();
  for (const line of text.split('\n')) {
    const match = BEAT_RE.exec(line);
    if (match) {
      beats.set(match[1], {
        n: Number(match[2]),
        of: Number(match[3]),
        step: match[4],
        note: (match[5] || '').trim(),
      });
    }
  }
  return beats;
}

/**
 * When an agent last did anything: its latest ledger line's time, else its start (a registered agent: its latest event,
 * a beat included). For a ledger agent only ledger lines count: they carry a
 * date and a sid, where a progress beat has neither (its time of day would land on today for an agent from last week, and
 * a name used by two sessions would be one agent). Null when no line has a time.
 */
export function lastActivity(
  agent: Pick<LedgerAgent, 'ended' | 'started'> &
    Partial<Pick<LedgerAgent, 'source' | 'lastEvent'>>,
): Date | null {
  // a registered agent's beats carry a date and a sid, so they count
  return (
    (agent.source === 'events' ? agent.lastEvent : null) ?? agent.ended ?? agent.started ?? null
  );
}

/** "3:40 PM ET, 11/2": a time as the ledger's writers write it, always in Eastern time and always labelled, so it reads the same whatever zone the reader is set to. */
export function ledgerTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
    hour12: true,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()} ET, ${get('month')}/${get('day')}`;
}

/** The `[done]` line the board's Finish writes for an agent that was still open: its own sid, lane tag and name, the time, and why. */
export function doneLine(agent: Pick<LedgerAgent, 'sid' | 'lane' | 'name'>, when: Date): string {
  const lane = agent.lane ? ` lane:${agent.lane}` : '';
  return `- [done] sid:${agent.sid}${lane} ${agent.name} — ${ledgerTime(when)} — finished from the board`;
}
