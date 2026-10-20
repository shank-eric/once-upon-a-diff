/**
 * The inbox: one JSONL file every reader can tail. The bridge appends
 * questions, positions and fix-before-push notes from the panel, and the
 * `answer` command appends answers. Each line is a whole JSON object with an
 * `id`, `at` (ISO time), `type` and `story`.
 *
 *   {"type":"question","id":"q_…","story":"EverFi-everfi-frontend-6943","step":2,"chapter":"Chapter 2: …","file":"…","text":"…","url":"…"}
 *   {"type":"answer","id":"a_…","question":"q_…","story":"…","text":"markdown"}
 *   {"type":"position","story":"…","step":2,"chapter":"…","file":"…"}
 *   {"type":"note","story":"…","note":{"id":"n_…","path":"…","side":"R","line":12,"body":"…"}}
 *
 * Readers keep a cursor (a byte offset) under <home>/cursors/<consumer>.json,
 * so `diff-story inbox --unread` and `diff-story wait` only hand over what a
 * reader hasn't seen. A later MCP server or hook reads the same file the same way.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const newId = prefix => `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export class Inbox {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'inbox.jsonl');
    mkdirSync(home, { recursive: true });
  }

  append(entry) {
    const full = { id: entry.id || newId(entry.type ? entry.type[0] : 'e'), at: new Date().toISOString(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  /** Entries from byte `offset` on: {entries, offset} where offset is where the next read starts. */
  readFrom(offset = 0) {
    if (!existsSync(this.file)) return { entries: [], offset: 0 };
    const size = statSync(this.file).size;
    if (offset > size) offset = 0; // the file was truncated or replaced
    if (offset === size) return { entries: [], offset };
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(this.file, 'r');
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1; // leave a half-written last line for next time
    const entries = [];
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip a bad line */ }
    }
    return { entries, offset: offset + Buffer.byteLength(text.slice(0, end)) };
  }

  all() { return this.readFrom(0).entries; }

  /** Questions for a story, oldest first, each with its answers. */
  questions(story) {
    const qs = new Map();
    const answers = [];
    for (const e of this.all()) {
      if (e.type === 'question' && (!story || e.story === story)) qs.set(e.id, { id: e.id, at: e.at, story: e.story, step: e.step ?? null, chapter: e.chapter || null, file: e.file || null, text: e.text, answers: [] });
      else if (e.type === 'answer') answers.push(e);
    }
    for (const a of answers) if (qs.has(a.question)) qs.get(a.question).answers.push({ id: a.id, at: a.at, text: a.text });
    return [...qs.values()];
  }

  cursorFile(consumer) {
    const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
    mkdirSync(path.join(this.home, 'cursors'), { recursive: true });
    return path.join(this.home, 'cursors', `${safe}.json`);
  }
  getCursor(consumer) {
    try { return JSON.parse(readFileSync(this.cursorFile(consumer), 'utf8')).offset || 0; } catch { return 0; }
  }
  setCursor(consumer, offset) {
    writeFileSync(this.cursorFile(consumer), JSON.stringify({ offset, at: new Date().toISOString() }));
  }
  /** What `consumer` hasn't read yet. `advance` moves its cursor past it. */
  unread(consumer, { advance = false } = {}) {
    const { entries, offset } = this.readFrom(this.getCursor(consumer));
    if (advance) this.setCursor(consumer, offset);
    return entries;
  }
}
