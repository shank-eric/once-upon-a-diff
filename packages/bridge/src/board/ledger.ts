/**
 * The background agents the board shows inside their parent session's card, read from two optional text files
 * (the settings board_ledger_file and board_progress_file; with neither set there are no agents).
 *
 * The ledger has one line per event, appended by whatever launches the agents:
 *
 *   - [running] sid:<8 hex> [lane:<name>] <name> (model, effort) — task — started 1:50 PM ET, 10/26
 *   - [done] sid:<8 hex> [lane:<name>] <name> — 1:33 PM ET, 10/26 — outcome — notes path
 *   - [waiting] sid:<8 hex> [lane:<name>] <name> — 1:40 PM ET, 10/26 — needs <you>: question — notes path
 *
 * [failed] and [stopped] work like [done]. [waiting] is an agent that has finished but whose result needs a decision:
 * the board puts it in the waiting column with the question, until a later [done] or [stopped] line clears it. sid is the first 8 characters of the launching session's id, and the name
 * is a word of letters, digits, dashes and underscores. A lane tag puts the agent on a lane of that name instead of
 * inside its parent's card. The last line with a given sid and name wins. Lines that don't match are skipped.
 *
 * The progress file's lines are `- <time> <name> <N>/<M> <step>: <note>`; the board shows each agent's latest.
 * Both files are read from their tail only, so a long history costs nothing.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { BoardBeat } from '@once-upon-a-diff/shared/types';

/** One agent as its ledger lines tell it. */
export interface LedgerAgent {
  sid: string;
  name: string;
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  lane: string | null;
  model: string | null;
  task: string | null;
  started: Date | null;
  ended: Date | null;
  outcome: string | null;
}

const LEDGER_TAIL = 1024 * 1024;
const PROGRESS_TAIL = 256 * 1024;

/** The last `max` bytes of a text file ('' when it can't be read), cut to whole lines. */
export function tailOf(file: string, max: number): string {
  let handle: number | null = null;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    readSync(handle, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
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
  /^\s*-\s*\[(running|waiting|done|failed|stopped)\]\s+sid:([0-9a-f]{8})\s+(?:lane:([\w.-]+)\s+)?([\w.-]+)\s*(.*)$/;

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
      lane: null,
      model: null,
      task: null,
      started: null,
      ended: null,
      outcome: null,
    };
    agent.state = state as LedgerAgent['state'];
    agent.lane = lane || agent.lane;
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
      agent.outcome =
        after
          .replace(/^[^—]*—\s*/, '')
          .split(/\s+—\s+/)[0]
          .trim() || null;
    }
    agents.set(key, agent);
  }
  return [...agents.values()];
}

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

/** The ledger's agents with the progress file's beats, for the files the settings name (a missing file or setting gives none). */
export function readAgents(
  files: { ledger: string | null; progress: string | null },
  now: Date,
  zone?: string,
): { agents: LedgerAgent[]; beats: Map<string, BoardBeat> } {
  return {
    agents: files.ledger ? parseLedger(tailOf(files.ledger, LEDGER_TAIL), now, zone) : [],
    beats: files.progress ? parseProgress(tailOf(files.progress, PROGRESS_TAIL)) : new Map(),
  };
}
