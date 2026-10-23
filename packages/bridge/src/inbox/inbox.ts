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
import type { LocalNote } from '@once-upon-a-diff/shared/types';

/** What every inbox line has, and what a story's ref adds (StoryRef). */
interface EntryBase {
  id: string;
  at: string;
  story?: string;
  kind?: string;
  title?: string | null;
  repo?: string | null;
}

export interface QuestionEntry extends EntryBase {
  type: 'question';
  story: string;
  step: number | null;
  chapter: string | null;
  file: string | null;
  text: string;
  url?: string | null;
}

export interface AnswerEntry extends EntryBase {
  type: 'answer';
  question: string;
  text: string;
  by?: string;
}

export interface NoteEntry extends EntryBase {
  type: 'note';
  action: 'added' | 'updated' | 'deleted';
  from_draft?: boolean;
  note: LocalNote;
}

export interface FixEntry extends EntryBase {
  type: 'fix';
  action: 'sent' | 'fixed' | 'failed';
  request: string;
  notes: string[];
  to?: string | null;
  sha?: string | null;
  by?: string | null;
}

export interface ReadEntry extends EntryBase {
  type: 'read';
  chapter: string;
  step: number | null;
  title: string | null;
  head_sha: string | null;
  story_head: string | null;
  reason: string;
}

export interface ReviewCommentEntry extends EntryBase {
  type: 'review_comment';
  chapter: number | null;
  path: string;
  line: number;
  url?: string | null;
  started?: boolean;
}

export interface CommentEntry extends EntryBase {
  type: 'comment';
  chapter: number;
  comment: unknown;
}

/** One line of inbox.jsonl. */
export type InboxEntry =
  | QuestionEntry
  | AnswerEntry
  | NoteEntry
  | FixEntry
  | ReadEntry
  | ReviewCommentEntry
  | CommentEntry;

/** A question with its answers, as the panel and the CLI take it. */
export interface QuestionWithAnswers {
  id: string;
  at: string;
  story: string;
  step: number | null;
  chapter: string | null;
  file: string | null;
  text: string;
  answers: { id: string; at: string; text: string; by: string | null }[];
}

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export class Inbox {
  declare home: string;
  declare file: string;
  constructor(home: string) {
    this.home = home;
    this.file = path.join(home, 'inbox.jsonl');
    mkdirSync(home, { recursive: true });
  }

  /** Appends the entry with an id (unless it has one) and the time. */
  append<E extends { type: string; id?: string }>(entry: E): E & { id: string; at: string } {
    const full = {
      id: entry.id || newId(entry.type ? entry.type[0] : 'e'),
      at: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(this.file, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  /** Entries from byte `offset` on: {entries, offset} where offset is where the next read starts. */
  readFrom(offset = 0): { entries: InboxEntry[]; offset: number } {
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
    const entries: InboxEntry[] = [];
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

  all(): InboxEntry[] {
    return this.readFrom(0).entries;
  }

  /** Questions for a story, oldest first, each with its answers. */
  questions(story?: string | null): QuestionWithAnswers[] {
    const byId = new Map<string, QuestionWithAnswers>();
    const answers: AnswerEntry[] = [];
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
        byId.get(answer.question)!.answers.push({
          id: answer.id,
          at: answer.at,
          text: answer.text,
          by: answer.by || null,
        });
      }
    }
    return [...byId.values()];
  }

  cursorFile(consumer: string | null | undefined): string {
    const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
    mkdirSync(path.join(this.home, 'cursors'), { recursive: true });
    return path.join(this.home, 'cursors', `${safe}.json`);
  }
  getCursor(consumer: string | null | undefined): number {
    return readJson<{ offset?: number }>(this.cursorFile(consumer), {})?.offset || 0;
  }
  setCursor(consumer: string | null | undefined, offset: number): void {
    writeFileSync(
      this.cursorFile(consumer),
      JSON.stringify({ offset, at: new Date().toISOString() }),
    );
  }
  /** What `consumer` hasn't read yet. `advance` moves its cursor past it. */
  unread(consumer: string | null | undefined, { advance = false } = {}): InboxEntry[] {
    const { entries, offset } = this.readFrom(this.getCursor(consumer));
    if (advance) {
      this.setCursor(consumer, offset);
    }
    return entries;
  }
}
