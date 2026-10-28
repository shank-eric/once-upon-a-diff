/**
 * The voice session, pinned at the top of the board instead of sitting in a column. Larmor (voice mode for Claude Code)
 * keeps these files in a folder, which the setting board_voice_dir names (off when unset), and the board only reads them:
 *
 *   session             {"on": true, "session_id": "<Claude Code session id>", "last_listen": <epoch s>, "last_speak": <epoch s>}
 *   voice-session-name  the name the voice session answers to, one line
 *   away                exists while the user is away on the phone
 *   paused              exists while voice is paused from the menu bar
 *   spoken.jsonl        what a session said aloud, a line per state: {id, wall (epoch s), text, session_id, status}
 *   turns.jsonl         what the user said: {type: "turn", channel: "mic", text, is_final, wall_clock (epoch s)}
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BoardVoiceLine } from '@once-upon-a-diff/shared/types';

export interface VoiceFiles {
  session: string;
  name: string | null;
  away: boolean;
  paused: boolean;
  /** epoch ms, 0 when it never has */
  lastListen: number;
  lastSpeak: number;
}

/** The voice files when voice is on and names a session, else null. */
export function readVoice(dir: string): VoiceFiles | null {
  let state: { on?: unknown; session_id?: unknown; last_listen?: unknown; last_speak?: unknown };
  try {
    state = JSON.parse(readFileSync(path.join(dir, 'session'), 'utf8'));
  } catch {
    return null;
  }
  // `null` or a bare value is valid JSON but says nothing
  if (
    !state ||
    typeof state !== 'object' ||
    state.on !== true ||
    typeof state.session_id !== 'string' ||
    !state.session_id
  ) {
    return null;
  }
  let name: string | null = null;
  try {
    name = readFileSync(path.join(dir, 'voice-session-name'), 'utf8').trim() || null;
  } catch {
    name = null;
  }
  const millis = (seconds: unknown) => (typeof seconds === 'number' ? seconds * 1000 : 0);
  return {
    session: state.session_id,
    name,
    away: existsSync(path.join(dir, 'away')),
    paused: existsSync(path.join(dir, 'paused')),
    lastListen: millis(state.last_listen),
    lastSpeak: millis(state.last_speak),
  };
}

export type VoiceStatus = 'listening' | 'speaking' | 'working' | 'paused' | 'away';

/** How soon after it spoke the session counts as still speaking. */
const SPEAKING_MS = 20 * 1000;

/**
 * Where the voice session stands: away on the phone or paused (files), else speaking just after it spoke, listening
 * when it asked and is waiting for you, else working. `busy` is the session's own busy flag: a session that is working
 * is working whatever it last said.
 */
export function voiceStatus(files: VoiceFiles, busy: boolean, now: number): VoiceStatus {
  if (files.away) {
    return 'away';
  }
  if (files.paused) {
    return 'paused';
  }
  if (!busy && files.lastListen >= files.lastSpeak && files.lastListen > 0) {
    return 'listening';
  }
  if (files.lastSpeak > files.lastListen && now - files.lastSpeak < SPEAKING_MS) {
    return 'speaking';
  }
  return busy ? 'working' : 'listening';
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
