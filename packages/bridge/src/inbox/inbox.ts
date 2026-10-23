// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/**
 * The inbox: one JSONL file every reader can tail. The bridge appends
 * questions and fix-before-push notes from the panel, and the
 * `answer` command appends answers. Each line is a whole JSON object with an
 * `id`, `at` (ISO time), `type` and `story`.
 *
 *   {"type":"question","id":"q_…","story":"octo-org-web-app-42","step":2,"chapter":"Chapter 2: …","file":"…","text":"…","url":"…"}
 *   {"type":"answer","id":"a_…","question":"q_…","story":"…","text":"markdown","by":"<the consumer that answered>"}
 *   {"type":"note","story":"…","note":{"id":"n_…","path":"…","side":"R","line":12,"body":"…"}}
 *   {"type":"read","story":"…","chapter":"<chapter key>","step":2,"title":"Chapter 2: …","head_sha":"…","story_head":"…","reason":"time|viewed|inferred"}
 *   {"type":"fix","action":"sent|fixed|failed","story":"…","request":"f_…","notes":["n_…"],"sha":"…"}  (the requests themselves are in fixes.json)
 *
 * Readers keep a cursor (a byte offset) under <home>/cursors/<consumer>.json,
 * so `once-upon inbox --unread` and `once-upon wait` only hand over what a
 * reader hasn't seen. A later MCP server or hook reads the same file the same way.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJson } from '../util/json-file.ts';

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export class Inbox {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'inbox.jsonl');
    mkdirSync(home, { recursive: true });
  }

  append(entry) {
    const full = {
      id: entry.id || newId(entry.type ? entry.type[0] : 'e'),
      at: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  /** Entries from byte `offset` on: {entries, offset} where offset is where the next read starts. */
  readFrom(offset = 0) {
    if (!existsSync(this.file)) {
      return { entries: [], offset: 0 };
    }
    const size = statSync(this.file).size;
    if (offset > size) {
      offset = 0;
    } // the file was truncated or replaced
    if (offset === size) {
      return { entries: [], offset };
    }
    const buf = Buffer.alloc(size - offset);
    const descriptor = openSync(this.file, 'r');
    try {
      readSync(descriptor, buf, 0, buf.length, offset);
    } finally {
      closeSync(descriptor);
    }
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1; // leave a half-written last line for next time
    const entries = [];
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip a bad line */
      }
    }
    return { entries, offset: offset + Buffer.byteLength(text.slice(0, end)) };
  }

  all() {
    return this.readFrom(0).entries;
  }

  /** Questions for a story, oldest first, each with its answers. */
  questions(story) {
    const byId = new Map();
    const answers = [];
    for (const e of this.all()) {
      if (e.type === 'question' && (!story || e.story === story)) {
        byId.set(e.id, {
          id: e.id,
          at: e.at,
          story: e.story,
          step: e.step ?? null,
          chapter: e.chapter || null,
          file: e.file || null,
          text: e.text,
          answers: [],
        });
      } else if (e.type === 'answer') {
        answers.push(e);
      }
    }
    for (const answer of answers) {
      if (byId.has(answer.question)) {
        byId.get(answer.question).answers.push({
          id: answer.id,
          at: answer.at,
          text: answer.text,
          by: answer.by || null,
        });
      }
    }
    return [...byId.values()];
  }

  cursorFile(consumer) {
    const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
    mkdirSync(path.join(this.home, 'cursors'), { recursive: true });
    return path.join(this.home, 'cursors', `${safe}.json`);
  }
  getCursor(consumer) {
    return readJson(this.cursorFile(consumer), {})?.offset || 0;
  }
  setCursor(consumer, offset) {
    writeFileSync(
      this.cursorFile(consumer),
      JSON.stringify({ offset, at: new Date().toISOString() }),
    );
  }
  /** What `consumer` hasn't read yet. `advance` moves its cursor past it. */
  unread(consumer, { advance = false } = {}) {
    const { entries, offset } = this.readFrom(this.getCursor(consumer));
    if (advance) {
      this.setCursor(consumer, offset);
    }
    return entries;
  }
}
