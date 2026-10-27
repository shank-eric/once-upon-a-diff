/**
 * The voice session, pinned at the top of the board instead of sitting in a column. Larmor (voice mode for Claude Code)
 * keeps these files in a folder, which the setting board_voice_dir names (off when unset), and the board only reads them:
 *
 *   session             {"on": true, "session_id": "<Claude Code session id>", "last_listen": <epoch s>, "last_speak": <epoch s>}
 *   voice-session-name  the name the voice session answers to, one line
 *   away                exists while the user is away on the phone
 *   paused              exists while voice is paused from the menu bar
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
