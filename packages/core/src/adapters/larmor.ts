/*
 * Larmor (voice mode for Claude Code), through its own `voice_ctl` script. The board asks it for what voice and phone mode
 * are doing and tells it to pause, resume, start, stop and run phone mode; Larmor owns the checks, the files and the bridge.
 *
 * `voice_ctl status` answers `{ok, why, away, bridge, voice: {on, paused, session_id}}`: voice on (its owner alive), paused,
 * the voice session's id, phone mode on and whether the phone bridge runs. The board reads no other file for those.
 *
 * What voice_ctl does not answer yet is still read from the folder the setting board_voice_dir names (off when unset):
 *
 *   session             {"since": <epoch s>, "last_listen": <epoch s>, "last_speak": <epoch s>} (the rest is voice_ctl's)
 *   voice-session-name  the name the voice session answers to, one line
 *   last-voice.json     {"session_id", "cwd", "at": <epoch s>}: the last session that took voice mode. It outlives the end
 *                       of voice mode, which rewrites `session` as {"on": false} without the session id
 *   spoken.jsonl        what a session said aloud, a line per state: {id, wall (epoch s), text, session_id, status}
 *   turns.jsonl         what the user said: {type: "turn", channel: "mic", text, is_final, wall_clock (epoch s)}
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { BoardVoiceLine } from '@once-upon-a-diff/contracts/types';

export interface VoiceFiles {
  session: string;
  /** voice mode is on right now; false when it ended and the session is only remembered from today */
  on: boolean;
  name: string | null;
  /** phone mode is on while voice is on */
  away: boolean;
  /** phone mode is on, whether or not voice is */
  phoneOn: boolean;
  paused: boolean;
  /** epoch ms, 0 when it never has */
  lastListen: number;
  lastSpeak: number;
}

/** True when the epoch-ms times fall on the same local calendar day. */
function sameDay(first: number, second: number): boolean {
  return new Date(first).toDateString() === new Date(second).toDateString();
}

/** The session that last took voice mode and when (epoch ms), from last-voice.json, or null. */
export function lastVoice(dir: string): { session: string; at: number } | null {
  try {
    const last = JSON.parse(readFileSync(path.join(dir, 'last-voice.json'), 'utf8'));
    if (
      last &&
      typeof last.session_id === 'string' &&
      last.session_id &&
      typeof last.at === 'number'
    ) {
      return { session: last.session_id, at: last.at * 1000 };
    }
  } catch {
    /* none */
  }
  return null;
}

/** When voice last ended, and when the session last listened and spoke (epoch ms, 0 for none), from the `session` file. */
function sessionTimes(dir: string): { since: number; lastListen: number; lastSpeak: number } {
  let state: { since?: unknown; last_listen?: unknown; last_speak?: unknown } | null = null;
  try {
    state = JSON.parse(readFileSync(path.join(dir, 'session'), 'utf8'));
  } catch {
    state = null;
  }
  const millis = (seconds: unknown) =>
    state && typeof state === 'object' && typeof seconds === 'number' ? seconds * 1000 : 0;
  return {
    since: millis(state?.since),
    lastListen: millis(state?.last_listen),
    lastSpeak: millis(state?.last_speak),
  };
}

/**
 * The voice session once voice has started in it: while voice mode is on (voice_ctl names it), and after it ends, for the
 * rest of that local day (last-voice.json), as `on: false`. Null before any voice today, and when voice_ctl gave no answer
 * (`state` null): voice is then unknown, which the board shows as off.
 */
export function readVoice(
  dir: string,
  state: CtlResult | null,
  now: number = Date.now(),
): VoiceFiles | null {
  if (!state) {
    return null;
  }
  const times = sessionTimes(dir);
  const live = state.voiceOn && !!state.sessionId;
  let session: string;
  if (live) {
    session = state.sessionId as string;
  } else {
    const last = lastVoice(dir);
    // today is judged by the last activity: voice ending writes `since` (its end time) into `session`, so a voice that
    // started before midnight and ended after it still counts, while one on right now always does (the live branch)
    if (!last || !sameDay(Math.max(last.at, times.since), now)) {
      return null;
    }
    session = last.session;
  }
  let name: string | null = null;
  try {
    name = readFileSync(path.join(dir, 'voice-session-name'), 'utf8').trim() || null;
  } catch {
    name = null;
  }
  return {
    session,
    on: live,
    name,
    away: live && state.away,
    phoneOn: state.away,
    paused: state.paused,
    lastListen: live ? times.lastListen : 0,
    lastSpeak: live ? times.lastSpeak : 0,
  };
}

/** Whether the Larmor checkout has what voice_ctl runs: its venv python and app/voice_ctl.py. */
export function phoneReady(larmorDir: string): boolean {
  return (
    existsSync(path.join(larmorDir, '.venv-app', 'bin', 'python')) &&
    existsSync(path.join(larmorDir, 'app', 'voice_ctl.py'))
  );
}

/** The subcommands of Larmor's `voice_ctl` the board runs, and nothing else. */
export type PhoneCommand = 'phone-on' | 'phone-off' | 'bridge-stop';
export type VoiceCommand = PhoneCommand | 'start' | 'stop' | 'status' | 'pause' | 'resume';

const CTL_COMMANDS: readonly string[] = [
  'phone-on',
  'phone-off',
  'bridge-stop',
  'start',
  'stop',
  'status',
  'pause',
  'resume',
];

/** voice_ctl waits for the bridge to listen after phone-on, up to about 10 s. */
const CTL_TIMEOUT_MS = 30 * 1000;
/** status, pause and resume read and write a file: each is over in well under a second. The board polls status, so it never waits long. */
const QUICK_TIMEOUT_MS = 3 * 1000;
/**
 * start scans the sessions, types into iTerm and waits up to 15 s for voice (after a pause it cleared, up to 8 s more for the
 * engine), with each iTerm or ps call allowed 5 s: about 40 s in the worst case. The kill must not come after /larmor was typed.
 */
const START_TIMEOUT_MS = 70 * 1000;

function timeoutOf(command: VoiceCommand): number {
  if (command === 'start') {
    return START_TIMEOUT_MS;
  }
  return command === 'status' || command === 'pause' || command === 'resume'
    ? QUICK_TIMEOUT_MS
    : CTL_TIMEOUT_MS;
}

/** The last non-empty line of some output (a Python traceback ends with its reason), cut to a short message. */
function lastLine(text: string): string {
  const line = text.trim().split('\n').pop()?.trim() ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Larmor's voice_ctl failed or printed nothing the board can use. The board answers it as a 502. */
export class VoiceCtlError extends Error {}

export interface CtlResult {
  ok: boolean;
  why: string;
  /** phone mode is on */
  away: boolean;
  /** the phone bridge runs */
  bridge: boolean;
  /** voice mode is on, after the command ran */
  voiceOn: boolean;
  paused: boolean;
  /** the voice session's id while voice is on, once Larmor has recorded it */
  sessionId: string | null;
}

/**
 * Runs `python app/voice_ctl.py <command>` from Larmor's checkout with its own venv python (no shell, a fixed list of
 * commands, a timeout) and returns the one JSON line it prints. Larmor owns the checks and the bridge; the board only asks.
 */
export function runVoiceCtl(
  larmorDir: string,
  command: VoiceCommand,
  session?: string,
): Promise<CtlResult> {
  if (!CTL_COMMANDS.includes(command)) {
    throw new Error(`not an allowed voice_ctl command: ${command}`);
  }
  // a session id goes only to start, and only in the id's own shape (execFile, so no shell either way)
  if (
    session !== undefined &&
    (command !== 'start' || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(session))
  ) {
    throw new Error(`not an allowed voice_ctl argument for ${command}`);
  }
  const python = path.join(larmorDir, '.venv-app', 'bin', 'python');
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ['app/voice_ctl.py', command, ...(session ? [session] : [])],
      {
        cwd: larmorDir,
        timeout: timeoutOf(command),
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop() ?? '';
        try {
          const got = JSON.parse(line) as Partial<Omit<CtlResult, 'voiceOn' | 'paused'>> & {
            voice?: { on?: unknown; paused?: unknown; session_id?: unknown };
          };
          if (got && typeof got.ok === 'boolean') {
            const id = got.voice?.session_id;
            return resolve({
              ok: got.ok,
              why: typeof got.why === 'string' ? got.why : '',
              away: got.away === true,
              bridge: got.bridge === true,
              voiceOn: got.voice?.on === true,
              paused: got.voice?.paused === true,
              sessionId: typeof id === 'string' && id ? id : null,
            });
          }
        } catch {
          /* no result line */
        }
        reject(
          new VoiceCtlError(
            err
              ? `Larmor's voice_ctl ${command} failed: ${lastLine(String(stderr)) || err.message.split('\n')[0]}`
              : `Larmor's voice_ctl ${command} printed no result`,
          ),
        );
      },
    );
  });
}

/** How old a good answer may get before a build starts a refresh in the background (about one board poll). */
export const STATUS_FRESH_MS = 2 * 1000;
/** After voice_ctl failed to answer status, how long the board does not ask again. */
const STATUS_RETRY_MS = 10 * 1000;
/** With no answer yet (first build, or just after the board changed voice), a build waits this long for one, then goes on without it. */
const STATUS_COLD_WAIT_MS = 1000;

/** The last answer (null for a failed call) and when it came in (the call's end, epoch ms). */
const statusKept = new Map<string, { value: CtlResult | null; at: number }>();
const statusRunning = new Map<string, Promise<void>>();
/** Bumped when the board forgets, so a call that started before does not store what it saw. */
let statusGeneration = 0;

function refreshStatus(larmorDir: string): Promise<void> {
  const running = statusRunning.get(larmorDir);
  if (running) {
    return running;
  }
  const generation = statusGeneration;
  const call = runVoiceCtl(larmorDir, 'status')
    .catch(() => null)
    .then((value) => {
      if (generation === statusGeneration) {
        statusKept.set(larmorDir, { value, at: Date.now() });
        statusRunning.delete(larmorDir);
      }
    });
  statusRunning.set(larmorDir, call);
  return call;
}

/**
 * What Larmor's voice_ctl last said voice and phone mode are doing, or null when it cannot say (no checkout, it failed, timed
 * out or printed nothing usable: the board then shows voice as off). The board does not wait for voice_ctl: a build uses the
 * last answer, and when that is older than a poll (a failure: 10 s) starts one refresh in the background, one at a time. Only
 * with no answer at all does a build wait, and for a second at most. Never rejects.
 */
export function voiceState(larmorDir: string): Promise<CtlResult | null> {
  const kept = statusKept.get(larmorDir);
  if (kept) {
    if (Date.now() - kept.at >= (kept.value ? STATUS_FRESH_MS : STATUS_RETRY_MS)) {
      void refreshStatus(larmorDir);
    }
    return Promise.resolve(kept.value);
  }
  const call = refreshStatus(larmorDir);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), STATUS_COLD_WAIT_MS);
    void call.then(() => {
      clearTimeout(timer);
      resolve(statusKept.get(larmorDir)?.value ?? null);
    });
  });
}

/**
 * After the board ran a voice_ctl command: its result carries the state after the command, so it is the new answer (the next
 * build needs no call), and any status call already running, which may have read the state before the command, is dropped.
 */
export function rememberVoiceState(larmorDir: string, result: CtlResult): void {
  statusGeneration += 1;
  statusRunning.clear();
  statusKept.set(larmorDir, { value: result, at: Date.now() });
}

/** Forget what voice_ctl last said, and any call already running, after a command whose result is unknown: the next build asks again. */
export function forgetProbes(): void {
  statusGeneration += 1;
  statusKept.clear();
  statusRunning.clear();
}

/** How much of each log's end is read for the last lines. */
const TAIL_BYTES = 128 * 1024;

/** How many lines the voice panel keeps (it scrolls). */
const VOICE_LINES = 20;

/** The whole JSON lines in a file's last TAIL_BYTES (the first one, cut by the read, is skipped), or [] without it. */
function tailLines(file: string): Record<string, unknown>[] {
  let handle: number;
  try {
    handle = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    return lines.flatMap((text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  } finally {
    closeSync(handle);
  }
}

/**
 * The voice session's last few lines, oldest first: what it said (its own lines in spoken.jsonl, each at its latest
 * state) and what you said since it first spoke in the part read (turns.jsonl names no session, and one voice session
 * runs at a time).
 */
export function voiceLines(dir: string, session: string): BoardVoiceLine[] {
  const said = new Map<string, BoardVoiceLine>();
  for (const line of tailLines(path.join(dir, 'spoken.jsonl'))) {
    if (
      line.session_id === session &&
      typeof line.id === 'string' &&
      typeof line.text === 'string' &&
      line.text.trim() &&
      typeof line.wall === 'number'
    ) {
      said.set(line.id, { who: 'voice', text: line.text.trim(), at: line.wall * 1000 });
    }
  }
  if (!said.size) {
    return [];
  }
  const start = Math.min(...[...said.values()].map((line) => line.at));
  const heard = tailLines(path.join(dir, 'turns.jsonl')).flatMap((line) =>
    line.type === 'turn' &&
    line.is_final === true &&
    typeof line.text === 'string' &&
    line.text.trim() &&
    typeof line.wall_clock === 'number' &&
    line.wall_clock * 1000 >= start
      ? [{ who: 'you' as const, text: line.text.trim(), at: line.wall_clock * 1000 }]
      : [],
  );
  return [...said.values(), ...heard]
    .sort((first, second) => first.at - second.at)
    .slice(-VOICE_LINES);
}
