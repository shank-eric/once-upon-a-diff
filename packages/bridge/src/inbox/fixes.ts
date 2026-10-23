/**
 * Fix before push: the reviewer's notes on a story, collected as drafts, and the fix requests that hand a batch of
 * them to a Claude session to change the code.
 *
 *   <home>/state/<story id>/notes.json         [{id, at, path, side, line, body, done, draft?, chapter?,
 *                                                sent?: {request, to, at}, fixed?: {request, sha, by, at},
 *                                                returned?: {request, sha, why, at}}]
 *   <home>/state/<story id>/fix-settings.json  {auto_send}
 *   <home>/fixes.json                           {<request id>: {id, story, repo, kind, title, url, branch, checkout,
 *                                                notes: [{id, path, side, line, body, chapter, from_draft}], to, requested_at,
 *                                                status, claimed_by, claimed_at, done_at, sha, fixed, why}}
 *
 * A note is a draft until it's sent: it can be edited or removed. Sent, it's locked until the session reports back
 * (`once-upon fixed`): fixed in <sha>, or returned to the drafts with why. The reviewer can take back a request
 * nobody has reported on, which returns its notes too.
 *
 * Routing is the questions' rule (conversation.ts), among the waits that take fix requests: a live story listener
 * gets its story's requests, and a repo or catch-all wait leaves them alone while it's live. A wait claims each
 * request it hands over, so no request goes to two sessions.
 */
import path from 'node:path';
import { newId } from './inbox.ts';
import { sameRepo } from '../config/repos.ts';
import { answeringOf, listeners } from '../listeners/listeners.ts';
import { readJson, writeJsonAtomic } from '../util/json-file.ts';
import type { FixNote, LocalNote, Side } from '@once-upon-a-diff/shared/types';
import type { Inbox } from './inbox.ts';
import type { Listener } from '../listeners/listeners.ts';
import type { StoryStore } from '../stories/store.ts';
import type { ServedStory, StoryMeta } from '../types.ts';

/** A note as a fix request carries it to the session. */
export interface RequestNote {
  id: string;
  path: string;
  side: Side;
  line: number;
  body: string;
  chapter: number | null;
  /**
   * True when the note came from a drafted comment (Add to fix before push). Claude wrote that text from the PR's
   * content, so the session confirms it with the user before acting on it, and Auto-send never sends it.
   */
  from_draft: boolean;
}

/** A fix request, as fixes.json keeps it. */
export interface FixRequest {
  id: string;
  story: string;
  repo: string | null;
  kind: StoryMeta['kind'];
  title: string | null;
  url: string | null;
  branch: string | null;
  checkout: string | null;
  notes: RequestNote[];
  to: string | null;
  requested_at: string;
  status: 'pending' | 'done' | 'failed' | 'taken_back';
  claimed_by?: string;
  claimed_at?: string;
  done_at?: string;
  sha?: string | null;
  fixed?: string[];
  why?: string | null;
  by?: string | null;
}

/** The story a note or a request is about: its id, meta.json and ref. */
type NoteStory = Pick<ServedStory, 'id' | 'meta' | 'ref'>;

const RECENT_REQUESTS = 10;
/** The longest a note's text can be. */
export const MAX_NOTE_BODY = 8000;

/** An error the bridge answers with its HTTP status. */
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

/** 'fixed', 'sent' or 'draft'. */
export function noteState(note: LocalNote): FixNote['state'] {
  if (note.fixed) {
    return 'fixed';
  }
  return note.sent ? 'sent' : 'draft';
}

const fixesFile = (home: string) => path.join(home, 'fixes.json');
export const readFixes = (home: string): Record<string, FixRequest> =>
  readJson<Record<string, FixRequest>>(fixesFile(home), {}) || {};
const saveFixes = (home: string, all: Record<string, FixRequest>) =>
  writeJsonAtomic(fixesFile(home), all);

export const readNotes = (store: StoryStore, story: string): LocalNote[] =>
  store.readState<LocalNote[]>(story, 'notes.json', []) || [];
const saveNotes = (store: StoryStore, story: string, notes: LocalNote[]) =>
  store.writeState(story, 'notes.json', notes);

/** The story's Auto-send setting: each note is sent as it's added. Off unless the reviewer turned it on. */
export const autoSendOf = (store: StoryStore, story: string): boolean =>
  !!(store.readState<{ auto_send?: boolean }>(story, 'fix-settings.json', {}) || {}).auto_send;
export function setAutoSend(store: StoryStore, story: string, enabled: unknown): boolean {
  store.writeState(story, 'fix-settings.json', {
    auto_send: !!enabled,
    at: new Date().toISOString(),
  });
  return !!enabled;
}

/** The live listeners that take fix requests (a wait with fix_request in its --type). */
const fixListeners = (home: string, live: Listener[] | null) =>
  (live || listeners(home)).filter((listener) => listener.live && listener.fixes);

/** Which session a story's fix requests go to now: {consumer, scope} or null, by the questions' rule. */
export const fixesGoTo = (
  home: string,
  { repo = null, story = null }: { repo?: string | null; story?: string | null } = {},
  live: Listener[] | null = null,
) => answeringOf(fixListeners(home, live), { repo, story });

/** What a request says about where the work is, for the session: the PR's branch, or the local checkout. */
function whereOf(meta: StoryMeta): { branch: string | null; checkout: string | null } {
  if (meta.kind === 'local') {
    return { branch: meta.branch || null, checkout: meta.repo_path || null };
  }
  return { branch: meta.head_ref || null, checkout: null };
}

/**
 * Hands the story's draft notes (all of them, or the ids given) to a session as one fix request.
 * story: {id, meta, ref}. Returns the request.
 */
export function sendNotes(
  home: string,
  store: StoryStore,
  story: NoteStory,
  {
    ids = null,
    inbox = null,
    live = null,
  }: { ids?: string[] | null; inbox?: Inbox | null; live?: Listener[] | null } = {},
): FixRequest {
  const notes = readNotes(store, story.id);
  const chosen = notes.filter(
    (note) => noteState(note) === 'draft' && (!ids || ids.includes(note.id)),
  );
  if (!chosen.length) {
    throw failure(400, 'no notes to send: every note is already sent or fixed');
  }
  const goTo = fixesGoTo(home, { repo: story.ref.repo, story: story.id }, live);
  const now = new Date().toISOString();
  const request: FixRequest = {
    id: newId('f'),
    story: story.id,
    repo: story.ref.repo || null,
    kind: story.meta.kind,
    title: story.ref.title || null,
    url: story.meta.url || null,
    ...whereOf(story.meta),
    notes: chosen.map((note) => ({
      id: note.id,
      path: note.path,
      side: note.side,
      line: note.line,
      body: note.body,
      chapter: note.chapter ?? null,
      from_draft: !!note.draft,
    })),
    to: goTo ? goTo.consumer : null,
    requested_at: now,
    status: 'pending',
  };
  for (const note of chosen) {
    note.sent = { request: request.id, to: request.to, at: now };
    delete note.returned;
  }
  saveNotes(store, story.id, notes);
  const all = readFixes(home);
  all[request.id] = request;
  saveFixes(home, all);
  if (inbox) {
    inbox.append({
      type: 'fix',
      action: 'sent',
      ...story.ref,
      request: request.id,
      notes: request.notes.map((note) => note.id),
      to: request.to,
    });
  }
  return request;
}

/** A pending request's notes go back to the drafts, each saying why. */
function returnNotes(
  store: StoryStore,
  request: FixRequest,
  returned: { sha: string | null; why: string; at: string },
): void {
  const notes = readNotes(store, request.story);
  for (const note of notes) {
    if (note.sent && note.sent.request === request.id) {
      delete note.sent;
      note.returned = { request: request.id, ...returned };
    }
  }
  saveNotes(store, request.story, notes);
}

/** The reviewer takes back a request nobody has reported on: its notes are drafts again, to edit or send again. */
export function takeBack(
  home: string,
  store: StoryStore,
  storyId: string,
  requestId: string,
): FixRequest {
  const all = readFixes(home);
  const request = all[requestId];
  if (!request || request.story !== storyId) {
    throw failure(404, 'no such fix request');
  }
  if (request.status !== 'pending') {
    throw failure(409, `that request is ${request.status} already`);
  }
  const now = new Date().toISOString();
  Object.assign(request, { status: 'taken_back', done_at: now });
  saveFixes(home, all);
  returnNotes(store, request, { sha: null, why: 'taken back', at: now });
  return request;
}

/**
 * The session reports on a request (`once-upon fixed`): the notes it fixed in `sha` (all of them unless `fixed`
 * names some), or `failed` with why. Notes it didn't fix go back to the drafts with why.
 */
export function reportFix(
  home: string,
  store: StoryStore,
  requestId: string,
  {
    sha = null,
    fixed = null,
    failed = false,
    why = null,
    by: reporter = null,
    inbox = null,
  }: {
    sha?: string | null;
    fixed?: string[] | null;
    failed?: boolean;
    why?: string | null;
    by?: string | null;
    inbox?: Inbox | null;
  } = {},
): FixRequest {
  const all = readFixes(home);
  const request = all[requestId];
  if (!request) {
    throw failure(404, `no fix request ${requestId}`);
  }
  if (request.status === 'taken_back') {
    throw failure(
      409,
      `the reviewer took ${requestId} back at ${request.done_at}; its notes are drafts again`,
    );
  }
  if (request.status !== 'pending') {
    throw failure(409, `${requestId} is ${request.status} already`);
  }
  if (!failed && !sha) {
    throw failure(400, 'say which commit fixed it (--sha), or --failed with why');
  }
  const ids = request.notes.map((note) => note.id);
  const fixedIds = failed ? [] : fixed || ids;
  const unknown = fixedIds.filter((id) => !ids.includes(id));
  if (unknown.length) {
    throw failure(400, `not in ${requestId}: ${unknown.join(', ')}`);
  }
  const now = new Date().toISOString();
  const notes = readNotes(store, request.story);
  for (const note of notes) {
    if (!note.sent || note.sent.request !== request.id) {
      continue;
    }
    delete note.sent;
    if (fixedIds.includes(note.id)) {
      note.fixed = { request: request.id, sha: sha as string, by: reporter, at: now }; // a fix has its sha
      note.done = true;
    } else {
      note.returned = {
        request: request.id,
        sha,
        why: why || (failed ? 'not fixed' : 'not in this change'),
        at: now,
      };
    }
  }
  saveNotes(store, request.story, notes);
  Object.assign(request, {
    status: failed ? 'failed' : 'done',
    done_at: now,
    sha,
    fixed: fixedIds,
    why: why || null,
    by: reporter,
  });
  saveFixes(home, all);
  if (inbox) {
    inbox.append({
      type: 'fix',
      action: failed ? 'failed' : 'fixed',
      story: request.story,
      repo: request.repo,
      request: request.id,
      sha,
      notes: fixedIds,
      by: reporter,
    });
  }
  return request;
}

/** The request as `wait` prints it and the session takes it. */
const handOverEntry = (request: FixRequest) => ({
  type: 'fix_request' as const,
  id: request.id,
  at: request.requested_at,
  story: request.story,
  repo: request.repo,
  kind: request.kind,
  title: request.title,
  url: request.url,
  branch: request.branch,
  checkout: request.checkout,
  notes: request.notes,
});

/**
 * The pending, unclaimed requests `consumer` (waiting with `scope`: {repo}, {story} or neither) should take now,
 * claimed for it. A repo or catch-all wait leaves a story's requests to that story's live listener.
 */
export function fixesToHand(
  home: string,
  consumer: string,
  scope: { repo?: string | null; story?: string | null },
  { live = null }: { live?: Listener[] | null } = {},
) {
  const all = readFixes(home);
  const pending = Object.values(all).filter(
    (request) => request.status === 'pending' && !request.claimed_by,
  );
  if (!pending.length) {
    return [];
  }
  const storyListeners = fixListeners(home, live).filter(
    (listener) => listener.story && listener.consumer !== consumer,
  );
  const now = new Date().toISOString();
  const taken: ReturnType<typeof handOverEntry>[] = [];
  for (const request of pending) {
    let mine;
    if (scope.story) {
      mine = request.story === scope.story;
    } else {
      const inRepo = !scope.repo || (request.repo && sameRepo(request.repo, scope.repo));
      mine = inRepo && !storyListeners.some((listener) => listener.story === request.story);
    }
    if (mine) {
      Object.assign(request, { claimed_by: consumer, claimed_at: now });
      taken.push(handOverEntry(request));
    }
  }
  if (taken.length) {
    saveFixes(home, all);
  }
  return taken;
}

/** The story's fix-before-push state as the panel shows it: its notes, Auto-send, who'd get a send, and its requests. */
export function fixesView(
  home: string,
  store: StoryStore,
  story: NoteStory,
  live: Listener[] | null = null,
) {
  const requests = Object.values(readFixes(home))
    .filter((request) => request.story === story.id)
    .sort((first, second) => String(second.requested_at).localeCompare(first.requested_at))
    .slice(0, RECENT_REQUESTS)
    .map((request) => ({
      id: request.id,
      status: request.status,
      to: request.to,
      claimed_by: request.claimed_by || null,
      requested_at: request.requested_at,
      done_at: request.done_at || null,
      sha: request.sha || null,
      why: request.why || null,
      notes: request.notes.map((note) => note.id),
    }));
  return {
    notes: readNotes(store, story.id).map((note) => ({ ...note, state: noteState(note) })),
    auto_send: autoSendOf(store, story.id),
    to: fixesGoTo(home, { repo: story.ref.repo, story: story.id }, live),
    requests,
  };
}

/**
 * A new note on the story; it's sent at once when the story's Auto-send is on, unless it came from a drafted
 * comment. Returns {note, request}.
 */
export function addNote(
  home: string,
  store: StoryStore,
  story: NoteStory,
  fields: {
    path?: string | null;
    side?: unknown;
    line?: number | null;
    body?: string | null;
    draft?: string;
    chapter?: number | null;
  },
  { inbox = null }: { inbox?: Inbox | null } = {},
) {
  const notes = readNotes(store, story.id);
  const note: LocalNote = {
    id: newId('n'),
    at: new Date().toISOString(),
    path: String(fields.path || '').slice(0, 1000),
    side: fields.side === 'L' ? 'L' : 'R',
    line: (fields.line ?? null) as number, // a note on a whole file has no line
    body: String(fields.body || '')
      .slice(0, MAX_NOTE_BODY)
      .trim(),
    done: false,
    ...(fields.draft ? { draft: fields.draft } : {}),
    ...(fields.chapter != null ? { chapter: fields.chapter } : {}),
  };
  notes.push(note);
  saveNotes(store, story.id, notes);
  if (inbox) {
    inbox.append({
      type: 'note',
      ...story.ref,
      action: 'added',
      ...(note.draft ? { from_draft: true } : {}),
      note,
    });
  }
  let request: FixRequest | null = null;
  // a note from a drafted comment is Claude's text from the PR, so it waits for the reviewer's own Send
  if (autoSendOf(store, story.id) && !note.draft) {
    request = sendNotes(home, store, story, { ids: [note.id], inbox });
  }
  const saved = readNotes(store, story.id).find((candidate) => candidate.id === note.id) || note;
  return { note: { ...saved, state: noteState(saved) }, request };
}

/** Changes one note: done, its text, or deleting it. A sent note can only be ticked done. */
export function updateNote(
  store: StoryStore,
  story: NoteStory,
  noteId: string,
  changes: { delete?: unknown; body?: unknown; done?: unknown },
  { inbox = null }: { inbox?: Inbox | null } = {},
) {
  const notes = readNotes(store, story.id);
  const index = notes.findIndex((note) => note.id === noteId);
  if (index < 0) {
    throw failure(404, 'no such note');
  }
  const note = notes[index];
  const editing = changes.delete || (typeof changes.body === 'string' && changes.body.trim());
  if (editing && noteState(note) !== 'draft') {
    const why =
      noteState(note) === 'sent'
        ? `it's with ${note.sent!.to || 'a Claude session'}; take the request back to change it`
        : 'it was fixed already';
    throw failure(409, `that note can't be changed now: ${why}`);
  }
  if (changes.delete) {
    notes.splice(index, 1);
    saveNotes(store, story.id, notes);
    if (inbox) {
      inbox.append({ type: 'note', ...story.ref, action: 'deleted', note });
    }
    return { deleted: note.id };
  }
  if ('done' in changes) {
    note.done = !!changes.done;
  }
  if (typeof changes.body === 'string' && changes.body.trim()) {
    note.body = changes.body.trim().slice(0, MAX_NOTE_BODY);
  }
  note.updated_at = new Date().toISOString();
  saveNotes(store, story.id, notes);
  if (inbox) {
    inbox.append({ type: 'note', ...story.ref, action: 'updated', note });
  }
  return { ...note, state: noteState(note) };
}
