/*
 * Fix before push, on PR and local stories alike: the notes (a line note, or a drafted comment turned into one by
 * Add to fix before push), sending them to a Claude session as one fix request (Send N notes, or Auto-send), and the
 * story's "being changed" marks from `once-upon working`. See ../../inbox/fixes.ts and ../../stories/working.ts.
 */
import {
  addNote,
  fixesView,
  MAX_NOTE_BODY,
  readNotes,
  sendNotes,
  setAutoSend,
  takeBack,
  updateNote,
} from '../../inbox/fixes.ts';
import { draftKey } from '../../github/drafts.ts';
import { relOfPath } from '../../util/diff.ts';
import { workingOf } from '../../stories/working.ts';
import { HttpError, clipText, toInt } from '../request.ts';
import { draftOf } from './drafts.ts';
import type { StoryData } from '@once-upon-a-diff/shared/types';
import type { App, Body, Call, ServedStory, StoryRoute } from '../../types.ts';

const MAX_IDS = 500;

/** The files a note can be on: a local story's diff, or a PR story's files. */
function relsOf(app: App, story: ServedStory): string[] {
  const data = app.stories.load(story.id) as StoryData;
  return data.local ? data.local.files.map((file) => file.rel) : data.files.map((file) => file.rel);
}

/** Add to fix before push: a drafted comment from the story becomes a note, once. Returns {note, request}. */
export function noteFromDraft(app: App, story: ServedStory, body: Body) {
  const comment = draftOf((app.stories.load(story.id) as StoryData).chapters, body);
  const rel = relOfPath(comment.path, relsOf(app, story));
  if (!rel || !((toInt(comment.line) as number) > 0)) {
    throw new HttpError(
      400,
      'only a draft on a line of a file in the diff can go in fix before push',
    );
  }
  const key = draftKey(comment);
  if (readNotes(app.stories, story.id).some((note) => note.draft === key)) {
    throw new HttpError(409, "it's already in fix before push");
  }
  return addNote(
    app.home,
    app.stories,
    story,
    {
      path: rel,
      side: comment.side,
      line: toInt(comment.line),
      body: clipText(comment.body, MAX_NOTE_BODY),
      draft: key,
      chapter: toInt(body.chapter),
    },
    { inbox: app.inbox },
  );
}

/** POST .../notes: a new note. POST .../notes/<id>: done, its text, or deleting it (a draft note only). */
function notesRoute({ app, body, send }: Call, story: ServedStory) {
  if (story.sub) {
    return send(200, updateNote(app.stories, story, story.sub, body, { inbox: app.inbox }));
  }
  if (body.chapter != null && body.index != null) {
    return send(200, noteFromDraft(app, story, body).note);
  }
  const text = clipText(body.body, MAX_NOTE_BODY);
  if (!text || !text.trim()) {
    throw new HttpError(400, 'body is required');
  }
  const { note } = addNote(
    app.home,
    app.stories,
    story,
    { path: clipText(body.path, 1000), side: body.side, line: toInt(body.line), body: text },
    { inbox: app.inbox },
  );
  return send(200, note);
}

/**
 * GET .../fixes: the notes with their state, Auto-send, who a send goes to and the recent requests.
 * POST {action: 'send', ids?}: the draft notes (all, or those ids) go to the session as one fix request.
 * POST {action: 'auto', on}: Auto-send on or off. POST {action: 'take_back', request}: a pending request's notes come
 * back as drafts.
 */
function fixesRoute({ app, req, body, send }: Call, story: ServedStory) {
  let sent = null;
  if (req.method === 'POST') {
    const action = String(body.action || '');
    if (action === 'send') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_IDS).map(String) : null;
      sent = sendNotes(app.home, app.stories, story, { ids, inbox: app.inbox });
    } else if (action === 'auto') {
      setAutoSend(app.stories, story.id, !!body.on);
    } else if (action === 'take_back') {
      takeBack(app.home, app.stories, story.id, String(body.request || ''));
    } else {
      throw new HttpError(400, 'action is one of send, auto, take_back');
    }
  }
  return send(200, { ...fixesView(app.home, app.stories, story), ...(sent ? { sent } : {}) });
}

/** GET .../working: the story's "being changed" marks that still stand, and the last one cleared. */
const workingRoute = ({ app, send }: Call, story: ServedStory) =>
  send(200, workingOf(app.home, story.id));

export const fixRoutes: StoryRoute[] = [
  { what: 'notes', method: 'POST', handle: notesRoute },
  { what: 'fixes', handle: fixesRoute },
  { what: 'working', method: 'GET', handle: workingRoute },
];
