/**
 * Fix before push: the reviewer's notes on a story, collected as drafts, and the fix requests that hand a batch of
 * them to a Claude session to change the code.
 *
 *   <home>/state/<story id>/notes.json         [{id, at, path, side, line, body, done, draft?, chapter?,
 *                                                sent?: {request, to, at}, fixed?: {request, sha, by, at},
 *                                                returned?: {request, sha, why, at}}]
 *   <home>/state/<story id>/fix-settings.json  {auto_send}
 *   <home>/fixes.json                           {<request id>: {id, story, repo, kind, title, url, branch, checkout,
 *                                                notes: [{id, path, side, line, body, chapter}], to, requested_at,
 *                                                status, claimed_by, claimed_at, done_at, sha, fixed, why}}
 *
 * A note is a draft until it's sent: it can be edited or removed. Sent, it's locked until the session reports back
 * (`once-upon fixed`): fixed in <sha>, or returned to the drafts with why. The reviewer can take back a request
 * nobody has reported on, which returns its notes too.
 *
 * Routing is the questions' rule (conversation.mjs), among the waits that take fix requests: a live story listener
 * gets its story's requests, and a repo or catch-all wait leaves them alone while it's live. A wait claims each
 * request it hands over, so no request goes to two sessions.
 */
import path from 'node:path';
import { newId } from './inbox.mjs';
import { sameRepo } from '../config/repos.mjs';
import { answeringOf, listeners } from '../listeners/listeners.mjs';
import { readJson, writeJsonAtomic } from '../util/json-file.mjs';

const RECENT_REQUESTS = 10;
/** The longest a note's text can be. */
export const MAX_NOTE_BODY = 8000;

/** An error the bridge answers with its HTTP status. */
const failure = (status, message) => Object.assign(new Error(message), { status });

/** 'fixed', 'sent' or 'draft'. */
export function noteState(note) {
  if (note.fixed) {
    return 'fixed';
  }
  return note.sent ? 'sent' : 'draft';
}

const fixesFile = (home) => path.join(home, 'fixes.json');
export const readFixes = (home) => readJson(fixesFile(home), {}) || {};
const saveFixes = (home, all) => writeJsonAtomic(fixesFile(home), all);

export const readNotes = (store, story) => store.readState(story, 'notes.json', []) || [];
const saveNotes = (store, story, notes) => store.writeState(story, 'notes.json', notes);

/** The story's Auto-send setting: each note is sent as it's added. Off unless the reviewer turned it on. */
export const autoSendOf = (store, story) =>
  !!(store.readState(story, 'fix-settings.json', {}) || {}).auto_send;
export function setAutoSend(store, story, enabled) {
  store.writeState(story, 'fix-settings.json', {
    auto_send: !!enabled,
    at: new Date().toISOString(),
  });
  return !!enabled;
}

/** The live listeners that take fix requests (a wait with fix_request in its --type). */
const fixListeners = (home, live) =>
  (live || listeners(home)).filter((listener) => listener.live && listener.fixes);

/** Which session a story's fix requests go to now: {consumer, scope} or null, by the questions' rule. */
export const fixesGoTo = (home, { repo = null, story = null } = {}, live = null) =>
  answeringOf(fixListeners(home, live), { repo, story });

/** What a request says about where the work is, for the session: the PR's branch, or the local checkout. */
function whereOf(meta) {
  if (meta.kind === 'local') {
    return { branch: meta.branch || null, checkout: meta.repo_path || null };
  }
  return { branch: meta.head_ref || null, checkout: null };
}

/**
 * Hands the story's draft notes (all of them, or the ids given) to a session as one fix request.
 * story: {id, meta, ref}. Returns the request.
 */
export function sendNotes(home, store, story, { ids = null, inbox = null, live = null } = {}) {
  const notes = readNotes(store, story.id);
  const chosen = notes.filter(
    (note) => noteState(note) === 'draft' && (!ids || ids.includes(note.id)),
  );
  if (!chosen.length) {
    throw failure(400, 'no notes to send: every note is already sent or fixed');
  }
  const goTo = fixesGoTo(home, { repo: story.ref.repo, story: story.id }, live);
  const now = new Date().toISOString();
  const request = {
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
function returnNotes(store, request, returned) {
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
export function takeBack(home, store, storyId, requestId) {
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
  home,
  store,
  requestId,
  { sha = null, fixed = null, failed = false, why = null, by: reporter = null, inbox = null } = {},
) {
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
      note.fixed = { request: request.id, sha, by: reporter, at: now };
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
const handOverEntry = (request) => ({
  type: 'fix_request',
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
export function fixesToHand(home, consumer, scope, { live = null } = {}) {
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
  const taken = [];
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
export function fixesView(home, store, story, live = null) {
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

/** A new note on the story; it's sent at once when the story's Auto-send is on. Returns {note, request}. */
export function addNote(home, store, story, fields, { inbox = null } = {}) {
  const notes = readNotes(store, story.id);
  const note = {
    id: newId('n'),
    at: new Date().toISOString(),
    path: String(fields.path || '').slice(0, 1000),
    side: fields.side === 'L' ? 'L' : 'R',
    line: fields.line ?? null,
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
  let request = null;
  if (autoSendOf(store, story.id)) {
    request = sendNotes(home, store, story, { ids: [note.id], inbox });
  }
  const saved = readNotes(store, story.id).find((candidate) => candidate.id === note.id) || note;
  return { note: { ...saved, state: noteState(saved) }, request };
}

/** Changes one note: done, its text, or deleting it. A sent note can only be ticked done. */
export function updateNote(store, story, noteId, changes, { inbox = null } = {}) {
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
        ? `it's with ${note.sent.to || 'a Claude session'}; take the request back to change it`
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
