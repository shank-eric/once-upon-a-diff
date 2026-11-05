/*
 * A fake Larmor checkout for tests. Its venv python is a node script that plays Larmor's `voice_ctl`: `status` answers from the
 * voice folder's `session`, `away` and `paused` files the way Larmor's voice_state and read_away do, `pause` and `resume` make
 * and remove `paused` (pause refuses with voice off), and the other commands print a fixed answer. Every call but status is
 * appended to `calls.log` in the checkout, each status call to `status.log`.
 *
 * Marker files in the checkout change what it does:
 *   slow         every command but status waits 1 s first
 *   silent       every command but status fails with a Python traceback and exit 3
 *   refuse       phone-on and start answer ok: false
 *   bridge-up    status says the phone bridge runs
 *   status.raw   status prints this file's text instead of an answer (bad JSON, empty, a bare number)
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
// Larmor's voice_state: with no readable session file everything is off, paused included
function voice() {
  try {
    const data = JSON.parse(read('session'));
    const on = !!data.on && alive(data.owner);
    return { on, paused: has(path.join(VOICE_DIR, 'paused')), session_id: on ? data.session_id ?? null : null };
  } catch { return { on: false, paused: false, session_id: null }; }
}
function away() {
  try { const got = JSON.parse(read('away')); return !!got && typeof got === 'object' && !Array.isArray(got) && truthy(got.on); } catch { return false; }
}
const state = (why) => ({ ok: !why, why: why || '', away: away(), bridge: has('bridge-up'), voice: voice() });
const print = (value) => console.log(JSON.stringify(value));

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
