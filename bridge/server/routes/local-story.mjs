/*
 * What only a local story keeps on the bridge: Viewed per file (GitHub keeps
 * it for PR stories) and fix-before-push notes, including a drafted comment
 * turned into one (Add to fix before push).
 */
import { newId } from '../../inbox/inbox.mjs';
import { draftKey } from '../../github/drafts.mjs';
import { HttpError, clipText, toInt } from '../request.mjs';
import { draftOf } from './drafts.mjs';

/** The diff file a drafted comment's path names: the path itself, or the one file it's a suffix of (`Combobox/component.tsx`). */
export function relOfDraft(name, rels) {
  const wanted = String(name || '')
    .trim()
    .replace(/^\.\//, '');
  if (!wanted) {
    return null;
  }
  if (rels.includes(wanted)) {
    return wanted;
  }
  const hits = rels.filter((rel) => rel.endsWith('/' + wanted));
  return hits.length === 1 ? hits[0] : null;
}

function viewed({ app, body, send }, story) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, 'viewed files are kept by GitHub for PR stories');
  }
  const data = app.stories.load(story.id);
  const file = data.local.files.find((candidate) => candidate.rel === body.path);
  if (!file) {
    throw new HttpError(404, 'that file is not in the diff');
  }
  const viewedFiles = app.stories.readState(story.id, 'viewed.json', {});
  if (body.viewed) {
    viewedFiles[file.rel] = { hash: file.hash, at: new Date().toISOString() };
  } else {
    delete viewedFiles[file.rel];
  }
  app.stories.writeState(story.id, 'viewed.json', viewedFiles);
  return send(200, { path: file.rel, viewed: !!body.viewed });
}

/** Changes one note: done, its text, or deleting it. */
function updateNote(app, story, notes, noteId, body) {
  const index = notes.findIndex((note) => note.id === noteId);
  if (index < 0) {
    throw new HttpError(404, 'no such note');
  }
  if (body.delete) {
    const [gone] = notes.splice(index, 1);
    app.stories.writeState(story.id, 'notes.json', notes);
    app.inbox.append({ type: 'note', ...story.ref, action: 'deleted', note: gone });
    return { deleted: gone.id };
  }
  if ('done' in body) {
    notes[index].done = !!body.done;
  }
  if (typeof body.body === 'string' && body.body.trim()) {
    notes[index].body = clipText(body.body.trim(), 8000);
  }
  notes[index].updated_at = new Date().toISOString();
  app.stories.writeState(story.id, 'notes.json', notes);
  app.inbox.append({ type: 'note', ...story.ref, action: 'updated', note: notes[index] });
  return notes[index];
}

/** Add to fix before push: a drafted comment from the story becomes a note, once. */
function noteFromDraft(app, story, notes, body) {
  const data = app.stories.load(story.id);
  const comment = draftOf(data.chapters, body);
  const rel = relOfDraft(
    comment.path,
    data.local.files.map((file) => file.rel),
  );
  if (!rel || !(toInt(comment.line) > 0)) {
    throw new HttpError(
      400,
      'only a draft on a line of a file in the diff can go in fix before push',
    );
  }
  const key = draftKey(comment);
  if (notes.some((note) => note.draft === key)) {
    throw new HttpError(409, "it's already in fix before push");
  }
  const note = {
    id: newId('n'),
    at: new Date().toISOString(),
    path: rel,
    side: comment.side === 'L' ? 'L' : 'R',
    line: toInt(comment.line),
    body: clipText(comment.body, 8000).trim(),
    done: false,
    draft: key,
    chapter: toInt(body.chapter),
  };
  notes.push(note);
  app.stories.writeState(story.id, 'notes.json', notes);
  app.inbox.append({ type: 'note', ...story.ref, action: 'added', from_draft: true, note });
  return note;
}

function notesRoute({ app, body, send }, story) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(
      400,
      'fix-before-push notes are for local stories; on GitHub, draft a review comment',
    );
  }
  const notes = app.stories.readState(story.id, 'notes.json', []);
  if (story.sub) {
    return send(200, updateNote(app, story, notes, story.sub, body));
  }
  if (body.chapter != null && body.index != null) {
    return send(200, noteFromDraft(app, story, notes, body));
  }
  const text = clipText(body.body, 8000);
  if (!text || !text.trim()) {
    throw new HttpError(400, 'body is required');
  }
  const note = {
    id: newId('n'),
    at: new Date().toISOString(),
    path: clipText(body.path, 1000),
    side: body.side === 'L' ? 'L' : 'R',
    line: toInt(body.line),
    body: text.trim(),
    done: false,
  };
  notes.push(note);
  app.stories.writeState(story.id, 'notes.json', notes);
  app.inbox.append({ type: 'note', ...story.ref, action: 'added', note });
  return send(200, note);
}

export const localStoryRoutes = [
  { what: 'viewed', method: 'POST', handle: viewed },
  { what: 'notes', method: 'POST', handle: notesRoute },
];
