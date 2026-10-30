/*
 * Larmor (voice mode for Claude Code), through the files it keeps in a folder (the setting board_voice_dir names it, off when
 * unset), its phone bridge's local port and its `voice_ctl` script. The board reads the files and asks voice_ctl; Larmor
 * owns the checks and the bridge.
 *
 *   session             {"on": true, "session_id": "<Claude Code session id>", "last_listen": <epoch s>, "last_speak": <epoch s>}
 *   voice-session-name  the name the voice session answers to, one line
 *   away                exists while the user is away on the phone: Larmor writes {"on": true, ...} and removes it when they are back
 *   paused              exists while voice is paused from the menu bar (the board's Pause makes and removes it the same way)
 *   last-voice.json     {"session_id", "cwd", "at": <epoch s>}: the last session that took voice mode. It outlives the end
 *                       of voice mode, which rewrites `session` as {"on": false} without the session id
 *   spoken.jsonl        what a session said aloud, a line per state: {id, wall (epoch s), text, session_id, status}
 *   turns.jsonl         what the user said: {type: "turn", channel: "mic", text, is_final, wall_clock (epoch s)}
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { BoardVoiceLine } from '@once-upon-a-diff/shared/types';

export interface VoiceFiles {
  session: string;
  /** voice mode is on right now; false when it ended and the session is only remembered from today */
  on: boolean;
  name: string | null;
  /** phone mode is on while voice is on */
  away: boolean;
  /** the away file says phone mode is on, whether or not voice is */
  phoneOn: boolean;
  paused: boolean;
  /** epoch ms, 0 when it never has */
  lastListen: number;
  lastSpeak: number;
}

/** Python's truthiness for a parsed JSON value: false, null, 0, "", [] and {} are falsy (JavaScript calls [] and {} truthy). */
function pythonTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return !!value;
}

/**
 * Whether phone mode is on, from the `away` file, decided the way Larmor's `phone_contracts.read_away` decides it: the file
 * parses to a JSON object whose `on` is truthy (a missing, unparseable or other file is off).
 */
export function awayOn(dir: string): boolean {
  try {
    const record: unknown = JSON.parse(readFileSync(path.join(dir, 'away'), 'utf8'));
    return (
      !!record &&
      typeof record === 'object' &&
      !Array.isArray(record) &&
      pythonTruthy((record as { on?: unknown }).on)
    );
  } catch {
    return false;
  }
}

/** True when the epoch-ms times fall on the same local calendar day. */
function sameDay(first: number, second: number): boolean {
  return new Date(first).toDateString() === new Date(second).toDateString();
}

/** The session that last took voice mode and when (epoch ms), from last-voice.json, or null. */
function lastVoice(dir: string): { session: string; at: number } | null {
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

/**
 * The voice session once voice has started in it: while voice mode is on (`session` names it), and after it ends, for the
 * rest of that local day (last-voice.json), as `on: false`. Null before any voice today.
 */
export function readVoice(dir: string, now: number = Date.now()): VoiceFiles | null {
  let state: {
    on?: unknown;
    session_id?: unknown;
    since?: unknown;
    last_listen?: unknown;
    last_speak?: unknown;
  } | null = null;
  try {
    state = JSON.parse(readFileSync(path.join(dir, 'session'), 'utf8'));
  } catch {
    state = null;
  }
  // `null` or a bare value is valid JSON but says nothing
  const live =
    !!state &&
    typeof state === 'object' &&
    state.on === true &&
    typeof state.session_id === 'string' &&
    !!state.session_id;
  let session: string;
  if (live) {
    session = (state as { session_id: string }).session_id;
  } else {
    const last = lastVoice(dir);
    // today is judged by the last activity: voice ending writes `since` (its end time) into `session`, so a voice that
    // started before midnight and ended after it still counts, while one on right now always does (the live branch)
    const since = state && typeof state.since === 'number' ? state.since * 1000 : 0;
    if (!last || !sameDay(Math.max(last.at, since), now)) {
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
  const phoneOn = awayOn(dir);
  const millis = (seconds: unknown) => (typeof seconds === 'number' ? seconds * 1000 : 0);
  return {
    session,
    on: live,
    name,
    away: live && phoneOn,
    phoneOn,
    paused: existsSync(path.join(dir, 'paused')),
    lastListen: live ? millis(state?.last_listen) : 0,
    lastSpeak: live ? millis(state?.last_speak) : 0,
  };
}

/**
 * Pause or resume voice the way Larmor's menu bar does: the `paused` file is made (the folder is made if need be) or
 * removed (no error when it is not there), and Larmor's ear, which watches the file, does the rest.
 */
export function setPaused(dir: string, paused: boolean): void {
  const file = path.join(dir, 'paused');
  if (paused) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '');
  } else {
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

/** Where Larmor's phone bridge listens on this Mac (phone.json's sink_port, else Larmor's default). */
export function sinkPort(dir: string): number {
  try {
    const port = JSON.parse(readFileSync(path.join(dir, 'phone.json'), 'utf8')).sink_port;
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    /* the default */
  }
  return 8171;
}

const bridgeProbes = new Map<number, { at: number; up: boolean }>();

/** How long a probe's answer is reused, so a board refresh costs no connection of its own. */
const PROBE_TTL_MS = 2000;

/**
 * Whether Larmor's phone bridge is running: something accepts a connection on its local sink port (the way Larmor's menu
 * bar tells, so a bridge started by hand counts). A socket on 127.0.0.1, not an HTTP call. Never rejects.
 */
export function bridgeUp(
  dir: string,
  now: number = Date.now(),
  fresh: boolean = false,
): Promise<boolean> {
  const port = sinkPort(dir);
  const seen = bridgeProbes.get(port);
  if (!fresh && seen && now - seen.at >= 0 && now - seen.at < PROBE_TTL_MS) {
    return Promise.resolve(seen.up);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (listening: boolean) => {
      socket.destroy();
      bridgeProbes.set(port, { at: now, up: listening });
      resolve(listening);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** After the bridge was told to stop (Larmor sends the signal and does not wait): probes it uncached until it is down, or the time is up. Resolves to whether it is still up. */
export async function waitBridgeDown(dir: string, timeoutMs: number = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (!(await bridgeUp(dir, Date.now(), true))) {
      return false;
    }
    if (Date.now() >= end) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Whether the Larmor checkout has what the phone buttons run: its venv python and app/voice_ctl.py. */
export function phoneReady(larmorDir: string): boolean {
  return (
    existsSync(path.join(larmorDir, '.venv-app', 'bin', 'python')) &&
    existsSync(path.join(larmorDir, 'app', 'voice_ctl.py'))
  );
}

/** Forget what the probe saw, after the board changed the bridge. */
export function forgetProbes(): void {
  bridgeProbes.clear();
}

/** The subcommands of Larmor's `voice_ctl` the board runs for the phone buttons, and nothing else. */
export type PhoneCommand = 'phone-on' | 'phone-off' | 'bridge-stop';

const PHONE_COMMANDS: readonly string[] = ['phone-on', 'phone-off', 'bridge-stop'];

/** voice_ctl waits for the bridge to listen after phone-on, up to about 10 s. */
const CTL_TIMEOUT_MS = 20 * 1000;

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
  away: boolean;
  bridge: boolean;
}

/**
 * Runs `python app/voice_ctl.py <command>` from Larmor's checkout with its own venv python (no shell, a fixed list of
 * commands, a timeout) and returns the one JSON line it prints. Larmor owns the checks and the bridge; the board only asks.
 */
export function runVoiceCtl(larmorDir: string, command: PhoneCommand): Promise<CtlResult> {
  if (!PHONE_COMMANDS.includes(command)) {
    throw new Error(`not an allowed voice_ctl command: ${command}`);
  }
  const python = path.join(larmorDir, '.venv-app', 'bin', 'python');
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ['app/voice_ctl.py', command],
      { cwd: larmorDir, timeout: CTL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop() ?? '';
        try {
          const got = JSON.parse(line) as Partial<CtlResult>;
          if (typeof got.ok === 'boolean') {
            return resolve({
              ok: got.ok,
              why: typeof got.why === 'string' ? got.why : '',
              away: got.away === true,
              bridge: got.bridge === true,
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
