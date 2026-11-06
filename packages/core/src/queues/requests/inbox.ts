/**
 * The inbox: one JSONL file every reader can tail. The bridge appends
 * questions and fix-before-push notes from the panel, and the
 * `answer` command appends answers. Each line is a whole JSON object with an
 * `id`, `at` (ISO time), `type` and `story`. The format of each entry is the contracts package's
 * (contracts/src/files/schemas.ts); a line that isn't one of the types below is skipped.
 *
 *   {"type":"question","id":"q_…","story":"octo-org-web-app-42","step":2,"chapter":"Chapter 2: …","file":"…","text":"…","url":"…"}
 *   {"type":"answer","id":"a_…","question":"q_…","story":"…","text":"markdown","by":"<the consumer that answered>"}
 *   {"type":"note","story":"…","note":{"id":"n_…","path":"…","side":"R","line":12,"body":"…"}}
 *   {"type":"read","story":"…","chapter":"<chapter key>","step":2,"title":"Chapter 2: …","head_sha":"…","story_head":"…","reason":"time|viewed|inferred"}
 *   {"type":"approved","story":"…","branch":"…","checkout":"…","base":"…","head_sha":"…"}  (Approve on a local story's page)
 *   {"type":"fix","action":"sent|fixed|failed","story":"…","request":"f_…","notes":["n_…"],"sha":"…"}  (the requests themselves are in fixes.json)
 *
 * Readers keep a cursor (a byte offset) under <home>/cursors/<consumer>.json,
 * so `once-upon inbox --unread` and `once-upon wait` only hand over what a
 * reader hasn't seen. A later MCP server or hook reads the same file the same way.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId } from '../../foundation/ids.ts';
import { sameRepo } from '../../foundation/repos.ts';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../../adapters/stores/fs/json-file.ts';
import { ownerOnly, ensureDir, appendText, writeText } from '../../adapters/stores/fs/files.ts';
import type { ChapterRef } from '@once-upon-a-diff/contracts/types';
import { readInboxEntry, type InboxEntry } from '@once-upon-a-diff/contracts/files/schemas';
import { noteIfMalformed } from '../../foundation/shared-files.ts';

export type { InboxEntry };
type Entry<T extends InboxEntry['type']> = Extract<InboxEntry, { type: T }>;
export type QuestionEntry = Entry<'question'>;
export type AnswerEntry = Entry<'answer'>;
export type NoteEntry = Entry<'note'>;
export type FixEntry = Entry<'fix'>;
export type ReadEntry = Entry<'read'>;
export type ReviewCommentEntry = Entry<'review_comment'>;
export type CommentEntry = Entry<'comment'>;
/** Approve was clicked on a local story's page (or `once-upon approve` ran): ready to ship at this head. */
export type ApprovedEntry = Entry<'approved'>;

/** A question with its answers, as the panel and the CLI take it. */
export interface QuestionWithAnswers {
  id: string;
  at: string;
  story: string;
  step: number | null;
  chapter: string | null;
  file: string | null;
  text: string;
  channel: 'voice' | null;
  answers: { id: string; at: string; text: string; by: string | null; refs?: ChapterRef[] }[];
}

export class Inbox {
  declare home: string;
  declare file: string;
  constructor(home: string) {
    this.home = home;
    this.file = path.join(home, 'inbox.jsonl');
    ownerOnly(home);
  }

  /** Makes the inbox file when it is not there yet (a reader needs one to take a cursor from). */
  ensureFile(): void {
    if (!existsSync(this.file)) {
      writeText(this.file, '', 0o600);
    }
  }

  /** Appends the entry with an id (unless it has one) and the time. */
  append<E extends { type: string; id?: string }>(entry: E): E & { id: string; at: string } {
    const full = {
      id: entry.id || newId(entry.type ? entry.type[0] : 'e'),
      at: new Date().toISOString(),
      ...entry,
    };
    noteIfMalformed(this.file, full, readInboxEntry);
    appendText(this.file, JSON.stringify(full) + '\n', 0o600);
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
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue; // a bad line
      }
      const entry = readInboxEntry(value);
      if (entry) {
        entries.push(entry);
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
          channel: e.channel === 'voice' ? 'voice' : null,
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
          ...(answer.refs?.length ? { refs: answer.refs } : {}),
        });
      }
    }
    return [...byId.values()];
  }

  cursorFile(consumer: string | null | undefined): string {
    const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
    ensureDir(path.join(this.home, 'cursors'));
    return path.join(this.home, 'cursors', `${safe}.json`);
  }
  getCursor(consumer: string | null | undefined): number {
    return readJson<{ offset?: number }>(this.cursorFile(consumer), {})?.offset || 0;
  }
  setCursor(consumer: string | null | undefined, offset: number): void {
    writeFileAtomic(
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

/** A list of ids kept in a small JSON file, empty when there is none (the questions a wait left to a story listener). */
export const readIdList = (file: string): string[] => readJson<string[]>(file, []) || [];

export const writeIdList = (file: string, ids: string[]): void => writeJsonAtomic(file, ids);

/** The entries a --type, --story or --repo flag asks for (`inbox` and `wait` both filter this way). */
export function filterEntries<
  E extends { type: string; story?: string | null; repo?: string | null },
>(entries: E[], opts: Record<string, unknown>): E[] {
  const types = opts.type ? String(opts.type).split(',') : null;
  return entries.filter(
    (entry) =>
      (!types || types.includes(entry.type)) &&
      (!opts.story || entry.story === opts.story) &&
      (!opts.repo || sameRepo(entry.repo, opts.repo)),
  );
}
