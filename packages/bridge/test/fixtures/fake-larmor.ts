/*
 * A fake Larmor checkout for tests. Its venv python is a node script that plays Larmor's `voice_ctl`: `status` answers from the
 * voice folder's `session`, `away` and `paused` files the way Larmor's voice_state and read_away do, `pause` and `resume` make
 * and remove `paused` (pause refuses with voice off), `log` reads spoken.jsonl and turns.jsonl there too (each call's flags go to `log.log`), and the other commands print a fixed
 * answer. Every call but status and log is
 * appended to `calls.log` in the checkout, each status call to `status.log`.
 *
 * Marker files in the checkout change what it does:
 *   slow         every command but status waits 1 s first
 *   silent       every command but status fails with a Python traceback and exit 3
 *   refuse       phone-on and start answer ok: false
 *   bridge-up    status says the phone bridge runs
 *   status.raw   status prints this file's text instead of an answer (bad JSON, empty, a bare number)
 *   log.slow     the one log call that claims the marker (it is removed) waits 0.8 s first
 *   log.hang     log waits 20 s
 *   log.fail     log answers {ok: false}
 *   status.hang  status waits 20 s
 *   status.slow  the one status call that claims the marker (it is removed) reads the state, waits 0.8 s, then answers what it read
 *   status.fail  status fails with a traceback and exit 3
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Makes the checkout's `.venv-app/bin/python` and `app/voice_ctl.py` in `larmor`, reading voice state from `voiceDir`. */
export function fakeLarmorIn(larmor: string, voiceDir: string): string {
  mkdirSync(path.join(larmor, '.venv-app', 'bin'), { recursive: true });
  mkdirSync(path.join(larmor, 'app'), { recursive: true });
  writeFileSync(path.join(larmor, 'app', 'voice_ctl.py'), '');
  const python = path.join(larmor, '.venv-app', 'bin', 'python');
  writeFileSync(
    python,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const VOICE_DIR = ${JSON.stringify(voiceDir)};
const args = process.argv.slice(2);
const cmd = args[1];
const has = (name) => fs.existsSync(name);
const read = (name) => fs.readFileSync(path.join(VOICE_DIR, name), 'utf8');
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (...lines) => { lines.forEach((line) => console.error(line)); process.exit(3); };
// Larmor's _alive: a pid that is there (or that we may not signal); no owner at all, or one that is no pid, is not alive
const alive = (owner) => {
  try { process.kill(Number.parseInt(owner, 10), 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
const truthy = (value) =>
  Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : !!value;
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const sessionFile = () => { try { return JSON.parse(read('session')); } catch { return null; } };
// Larmor's voice_state: with no readable session file everything is off, paused included
function voice() {
  const data = sessionFile();
  let base;
  if (!data || typeof data !== 'object') {
    base = { on: false, paused: false, session_id: null };
  } else {
    const on = !!data.on && alive(data.owner);
    base = { on, paused: has(path.join(VOICE_DIR, 'paused')), session_id: on ? data.session_id ?? null : null };
  }
  // the extras each fall back on their own; listen and speak are null whenever voice is off
  const times = data && typeof data === 'object' ? data : {};
  let name = null;
  try { name = read('voice-session-name').split('\\n')[0].trim() || null; } catch {}
  let lastVoice = null;
  try {
    const last = JSON.parse(read('last-voice.json'));
    if (last && typeof last.session_id === 'string' && last.session_id) {
      lastVoice = { session_id: last.session_id, cwd: typeof last.cwd === 'string' ? last.cwd : null, at: num(last.at) };
    }
  } catch {}
  return {
    ...base,
    since: num(times.since),
    last_listen: base.on ? num(times.last_listen) : null,
    last_speak: base.on ? num(times.last_speak) : null,
    name,
    last_voice: lastVoice,
  };
}
const jsonl = (name) => {
  try {
    return read(name).split('\\n').flatMap((text) => {
      try { const got = JSON.parse(text); return got && typeof got === 'object' ? [got] : []; } catch { return []; }
    });
  } catch { return []; }
};
// voice_ctl log: spoken lines (the last per id) and final turns, oldest first, spoken before a turn at the same time
function log(flags) {
  let since = 0; let limit = 20; let session = null;
  for (let at = 0; at < flags.length; at += 2) {
    if (flags[at] === '--since') since = Number(flags[at + 1]);
    else if (flags[at] === '--limit') limit = Number(flags[at + 1]);
    else if (flags[at] === '--session') session = flags[at + 1];
    else { console.error('usage'); process.exit(2); }
  }
  const byId = new Map();
  for (const got of jsonl('spoken.jsonl')) {
    if (typeof got.id === 'string' && typeof got.wall === 'number' && typeof got.text === 'string' && got.text.trim()) byId.set(got.id, got);
  }
  const spoken = [...byId.values()].map((got) => ({
    kind: 'spoken', at: got.wall, text: got.text.trim(), id: got.id,
    session_id: typeof got.session_id === 'string' ? got.session_id : null,
    status: typeof got.status === 'string' ? got.status : null, complete: got.complete === true,
  }));
  let turns = jsonl('turns.jsonl')
    .filter((got) => got.type === 'turn' && got.is_final === true && typeof got.text === 'string' && got.text.trim() && typeof got.wall_clock === 'number')
    .map((got) => ({ kind: 'turn', at: got.wall_clock, text: got.text.trim(), channel: typeof got.channel === 'string' ? got.channel : null, id: typeof got.turn_id === 'string' ? got.turn_id : null }));
  let mine = spoken;
  if (session) {
    mine = spoken.filter((one) => one.session_id === session);
    const first = Math.min(...mine.map((one) => one.at));
    const others = spoken.filter((one) => one.session_id !== session && one.at > first).map((one) => one.at);
    const end = others.length ? Math.min(...others) : Infinity;
    turns = mine.length ? turns.filter((one) => one.at >= first && one.at < end) : [];
  }
  const lines = [...mine, ...turns].filter((one) => one.at > since).sort((a, b) => a.at - b.at);
  print({ ok: true, why: '', lines: lines.slice(-limit) });
}
function away() {
  try { const got = JSON.parse(read('away')); return !!got && typeof got === 'object' && !Array.isArray(got) && truthy(got.on); } catch { return false; }
}
const state = (why) => ({ ok: !why, why: why || '', away: away(), bridge: has('bridge-up'), voice: voice() });
const print = (value) => console.log(JSON.stringify(value));

if (cmd === 'log') {
  fs.appendFileSync('log.log', args.slice(2).join(' ') + '\\n');
  // the marker is claimed atomically, so only one of several overlapping calls sleeps
  try { fs.unlinkSync('log.slow'); wait(800); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (has('log.hang')) wait(20000);
  if (has('log.fail')) { print({ ok: false, why: 'OSError: boom', lines: [] }); process.exit(0); }
  log(args.slice(2));
  process.exit(0);
}
if (cmd === 'status') {
  fs.appendFileSync('status.log', 'x\\n');
  const answer = state('');
  // the marker is claimed atomically, so only one of several overlapping calls sleeps
  try { fs.unlinkSync('status.slow'); wait(800); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (has('status.hang')) wait(20000);
  if (has('status.fail')) fail('Traceback (most recent call last):', "ModuleNotFoundError: No module named 'rumps'");
  if (has('status.raw')) { process.stdout.write(fs.readFileSync('status.raw', 'utf8')); process.exit(0); }
  print(answer);
  process.exit(0);
}
fs.appendFileSync('calls.log', args.join(' ') + '\\n');
if (has('slow')) wait(1000);
if (has('silent')) fail('Traceback (most recent call last):', "ModuleNotFoundError: No module named 'rumps'");
if (has('refuse') && cmd === 'phone-on') {
  print({ ok: false, why: "The phone isn't paired yet. Pair it first.", away: false, bridge: false });
} else if (has('refuse') && cmd === 'start') {
  print({ ok: false, why: 'Voice is already on in another session', away: false, bridge: false, voice: { on: true, paused: false } });
} else if (cmd === 'pause') {
  if (!voice().on) { print(state("Voice isn't on")); } else { fs.writeFileSync(path.join(VOICE_DIR, 'paused'), ''); print(state('')); }
} else if (cmd === 'resume') {
  try { fs.unlinkSync(path.join(VOICE_DIR, 'paused')); } catch {}
  print(state(''));
} else if (cmd === 'start') {
  print({ ok: true, why: '', away: false, bridge: false, voice: { on: true, paused: false } });
} else if (cmd === 'phone-on') {
  console.log('noise before the answer');
  print({ ok: true, why: '', away: true, bridge: true });
} else {
  print({ ok: true, why: '', away: false, bridge: false });
}
`,
  );
  chmodSync(python, 0o755);
  return larmor;
}
