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
 * fixes.json is the record, and a note's sent, fixed and returned marks follow from it (alignNotes): each change writes
 * the request first, then brings the story's notes in line, so a crash between the two leaves notes a step behind, and
 * the next look mends them. Both files are written under fixes.json's lock (adapters/stores/fs/lock.ts), so the bridge and
 * the CLI can't lose each other's writes.
 *
 * Routing is the questions' rule (conversation.ts), among the waits that take fix requests: a live story listener
 * gets its story's requests, and a repo or catch-all wait leaves them alone while it's live. A wait claims each
 * request it hands over, so no request goes to two sessions.
 */
import path from 'node:path';
import { newId } from '../../foundation/ids.ts';
import { sameRepo } from '../../foundation/repos.ts';
import { answeringOf, listeners } from '../../records/listeners/listeners.ts';
import { withLock } from '../../adapters/stores/fs/lock.ts';
import {
  readFixRequest,
  type FixRequest,
  type RequestNote,
} from '@once-upon-a-diff/contracts/files/schemas';
import { RequestQueue } from './queue.ts';
import type { LocalNote } from '@once-upon-a-diff/contracts/types';
import type { Inbox } from './inbox.ts';
import type { Listener } from '../../records/listeners/listeners.ts';
import type { StoryStore } from '../../records/stories/store.ts';
import type { ServedStory, StoryMeta } from '../../records/stories/types.ts';
import { toSide } from '@once-upon-a-diff/domain/line-refs';
import { fixState } from '@once-upon-a-diff/domain/fix-notes';

/** A note as a fix request carries it to the session, and a fix request as fixes.json keeps it: the contracts package's formats (contracts/src/files/schemas.ts). */
export type { RequestNote, FixRequest };

/** The story a note or a request is about: its id, meta.json and ref. */
type NoteStory = Pick<ServedStory, 'id' | 'meta' | 'ref'>;

const RECENT_REQUESTS = 10;
/** The longest a note's text can be. */
export const MAX_NOTE_BODY = 8000;

/** An error the bridge answers with its HTTP status. */
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

const fixesFile = (home: string) => path.join(home, 'fixes.json');
/** fixes.json as a queue: a wait's claim on a fix request lasts until it's reported on or taken back. */
const fixesQueue = (home: string) =>
  new RequestQueue<FixRequest>(fixesFile(home), { claimFreshMs: null, check: readFixRequest });
export const readFixes = (home: string): Record<string, FixRequest> => fixesQueue(home).all();
/** Runs `work` under the lock that fixes.json and every story's notes.json are written under. */
const locked = <T>(home: string, work: () => T): T => withLock(fixesFile(home), work);

export const readNotes = (store: StoryStore, story: string): LocalNote[] =>
  store.readState<LocalNote[]>(story, 'notes.json', []) || [];
const saveNotes = (store: StoryStore, story: string, notes: LocalNote[]) =>
  store.writeState(story, 'notes.json', notes);

/** Why a note came back from a request, when the session gave no reason. */
const returnedWhy = (request: FixRequest) => {
  if (request.status === 'taken_back') {
    return 'taken back';
  }
  return request.why || (request.status === 'failed' ? 'not fixed' : 'not in this change');
};

/** Gives the note the marks its latest request says it has. */
function applyRequest(note: LocalNote, request: FixRequest, now: string): void {
  if (request.status === 'pending') {
    if (note.sent?.request !== request.id) {
      note.sent = { request: request.id, to: request.to, at: request.requested_at };
      delete note.returned;
    }
  } else if (request.status === 'done' && (request.fixed || []).includes(note.id)) {
    if (note.fixed?.request !== request.id) {
      delete note.sent;
      note.fixed = {
        request: request.id,
        sha: request.sha as string, // a fix has its sha
        by: request.by ?? null,
        at: request.done_at || now,
      };
      note.done = true;
    }
  } else if (note.sent || note.returned?.request !== request.id) {
    delete note.sent;
    note.returned = {
      request: request.id,
      sha: request.sha ?? null,
      why: returnedWhy(request),
      at: request.done_at || now,
    };
  }
}

/**
 * Brings a story's notes in line with its fix requests (the record), in place: each note takes the marks of the latest
 * request that carries it, and a note sent to a request fixes.json doesn't have goes back to the drafts. True when a note
 * changed.
 */
function alignNotes(notes: LocalNote[], requests: FixRequest[], now: string): boolean {
  const latest = new Map<string, FixRequest>();
  const oldestFirst = [...requests].sort((first, second) =>
    first.requested_at.localeCompare(second.requested_at),
  );
  for (const request of oldestFirst) {
    for (const carried of request.notes) {
      latest.set(carried.id, request);
    }
  }
  let changed = false;
  for (const note of notes) {
    const before = JSON.stringify(note);
    const request = latest.get(note.id);
    if (request) {
      applyRequest(note, request, now);
    } else if (note.sent) {
      note.returned = {
        request: note.sent.request,
        sha: null,
        why: 'lost: its request was never saved',
        at: now,
      };
      delete note.sent;
    }
    changed ||= JSON.stringify(note) !== before;
  }
  return changed;
}

const requestsOf = (home: string, story: string) =>
  Object.values(readFixes(home)).filter((request) => request.story === story);

/** The story's notes in line with fixes.json, saved when they weren't. Call it under the lock. */
function syncNotes(home: string, store: StoryStore, story: string): LocalNote[] {
  const notes = readNotes(store, story);
  if (alignNotes(notes, requestsOf(home, story), new Date().toISOString())) {
    saveNotes(store, story, notes);
  }
  return notes;
}

/** The story's notes as they should be: read without the lock, and mended under it when they lag fixes.json. */
function currentNotes(home: string, store: StoryStore, story: string): LocalNote[] {
  const notes = readNotes(store, story);
  const lagging = alignNotes(
    structuredClone(notes),
    requestsOf(home, story),
    new Date().toISOString(),
  );
  return lagging ? locked(home, () => syncNotes(home, store, story)) : notes;
}

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
  const goTo = fixesGoTo(home, { repo: story.ref.repo, story: story.id }, live);
  const request = locked(home, () => {
    const chosen = syncNotes(home, store, story.id).filter(
      (note) => fixState(note) === 'draft' && (!ids || ids.includes(note.id)),
    );
    if (!chosen.length) {
      throw failure(400, 'no notes to send: every note is already sent or fixed');
    }
    const made: FixRequest = {
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
      requested_at: new Date().toISOString(),
      status: 'pending',
    };
    fixesQueue(home).update((all) => {
      all[made.id] = made;
    });
    syncNotes(home, store, story.id);
    return made;
  });
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

/** The reviewer takes back a request nobody has reported on: its notes are drafts again, to edit or send again. */
export function takeBack(
  home: string,
  store: StoryStore,
  storyId: string,
  requestId: string,
): FixRequest {
  return locked(home, () => {
    const request = fixesQueue(home).finish(requestId, (found) => {
      if (found.story !== storyId) {
        throw failure(404, 'no such fix request');
      }
      if (found.status !== 'pending') {
        throw failure(409, `that request is ${found.status} already`);
      }
      return { status: 'taken_back' };
    });
    if (!request) {
      throw failure(404, 'no such fix request');
    }
    syncNotes(home, store, request.story);
    return request;
  });
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
  const request = locked(home, () => {
    const reported = fixesQueue(home).finish(requestId, (found) => {
      if (found.status === 'taken_back') {
        throw failure(
          409,
          `the reviewer took ${requestId} back at ${found.done_at}; its notes are drafts again`,
        );
      }
      if (found.status !== 'pending') {
        throw failure(409, `${requestId} is ${found.status} already`);
      }
      if (!failed && !sha) {
        throw failure(400, 'say which commit fixed it (--sha), or --failed with why');
      }
      const ids = found.notes.map((note) => note.id);
      const fixedIds = failed ? [] : fixed || ids;
      const unknown = fixedIds.filter((id) => !ids.includes(id));
      if (unknown.length) {
        throw failure(400, `not in ${requestId}: ${unknown.join(', ')}`);
      }
      return {
        status: failed ? 'failed' : 'done',
        sha,
        fixed: fixedIds,
        why: why || null,
        by: reporter,
      };
    });
    if (!reported) {
      throw failure(404, `no fix request ${requestId}`);
    }
    syncNotes(home, store, reported.story);
    return reported;
  });
  if (inbox) {
    inbox.append({
      type: 'fix',
      action: failed ? 'failed' : 'fixed',
      story: request.story,
      repo: request.repo,
      request: request.id,
      sha,
      notes: request.fixed || [],
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
  const storyListeners = fixListeners(home, live).filter(
    (listener) => listener.story && listener.consumer !== consumer,
  );
  const mine = (request: FixRequest) => {
    if (scope.story) {
      return request.story === scope.story;
    }
    const inRepo = !scope.repo || (!!request.repo && sameRepo(request.repo, scope.repo));
    return inRepo && !storyListeners.some((listener) => listener.story === request.story);
  };
  return fixesQueue(home).take(consumer, mine).map(handOverEntry);
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
    notes: currentNotes(home, store, story.id).map((note) => ({ ...note, state: fixState(note) })),
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
  const note: LocalNote = {
    id: newId('n'),
    at: new Date().toISOString(),
    path: String(fields.path || '').slice(0, 1000),
    side: toSide(fields.side),
    line: (fields.line ?? null) as number, // a note on a whole file has no line
    body: String(fields.body || '')
      .slice(0, MAX_NOTE_BODY)
      .trim(),
    done: false,
    ...(fields.draft ? { draft: fields.draft } : {}),
    ...(fields.chapter != null ? { chapter: fields.chapter } : {}),
  };
  locked(home, () => saveNotes(store, story.id, [...readNotes(store, story.id), note]));
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
  return { note: { ...saved, state: fixState(saved) }, request };
}

/** Changes one note: done, its text, or deleting it. A sent note can only be ticked done. */
export function updateNote(
  store: StoryStore,
  story: NoteStory,
  noteId: string,
  changes: { delete?: unknown; body?: unknown; done?: unknown },
  { inbox = null }: { inbox?: Inbox | null } = {},
) {
  return locked(store.home, () => {
    const notes = syncNotes(store.home, store, story.id);
    const index = notes.findIndex((note) => note.id === noteId);
    if (index < 0) {
      throw failure(404, 'no such note');
    }
    const note = notes[index];
    const editing = changes.delete || (typeof changes.body === 'string' && changes.body.trim());
    if (editing && fixState(note) !== 'draft') {
      const why =
        fixState(note) === 'sent'
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
    return { ...note, state: fixState(note) };
  });
}
