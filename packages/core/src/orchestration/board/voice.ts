/*
 * The voice session, pinned at the top of the board instead of sitting in a column. Larmor keeps its state in files
 * (adapters/larmor.ts reads them); this is what the board makes of them.
 */
import type { VoiceFiles } from '../../adapters/larmor.ts';

export type VoiceStatus = 'listening' | 'speaking' | 'working' | 'paused' | 'away' | 'ended';

/** How soon after it spoke the session counts as still speaking. */
const SPEAKING_MS = 20 * 1000;

/**
 * Where the voice session stands: ended (voice mode is off, the session only remembered from today), paused or away on the phone
 * (files; paused wins, so Resume is offered), else speaking just after it spoke, listening
 * when it asked and is waiting for you, else working. `busy` is the session's own busy flag: a session that is working
 * is working whatever it last said.
 */
export function voiceStatus(files: VoiceFiles, busy: boolean, now: number): VoiceStatus {
  if (!files.on) {
    return 'ended';
  }
  if (files.paused) {
    return 'paused';
  }
  if (files.away) {
    return 'away';
  }
  if (!busy && files.lastListen >= files.lastSpeak && files.lastListen > 0) {
    return 'listening';
  }
  if (files.lastSpeak > files.lastListen && now - files.lastSpeak < SPEAKING_MS) {
    return 'speaking';
  }
  return busy ? 'working' : 'listening';
}
