/*
 * Fix before push, on PR and local stories alike: the notes (a line note, or a drafted comment turned into one by
 * Add to fix before push), sending them to a Claude session as one fix request (Send N notes, or Auto-send), and the
 * story's "being changed" marks from `once-upon working`. See ../../services/inbox/fixes.ts and ../../services/inbox/working.ts.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import {
  addNote,
  fixesView,
  MAX_NOTE_BODY,
  readNotes,
  sendNotes,
  setAutoSend,
  takeBack,
  updateNote,
} from '../../services/inbox/fixes.ts';
import { draftKey, ghLogin } from '../../services/review/drafts.ts';
import { relOfPath } from '../../services/stories/diff.ts';
import { workingOf } from '../../services/inbox/working.ts';
import { prAuthorOf } from '../../services/stories/meta.ts';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { draftOf } from './drafts.ts';
import type { FixesView, StoryData } from '@once-upon-a-diff/protocol/types';
import type { ServedStory } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

/** The files a note can be on: a local story's diff, or a PR story's files. */
function relsOf(app: App, story: ServedStory): string[] {
  const data = app.stories.load(story.id) as StoryData;
  return data.local ? data.local.files.map((file) => file.rel) : data.files.map((file) => file.rel);
}

/**
 * Whether the panel offers Fix before push: always on a local story, and on a PR story only when its author is the
 * bridge's gh user, since fix requests go to the session working the viewer's own branch. When it's off, notes
 * already there stay readable. An author or a gh login that isn't known counts as not the viewer's.
 */
export async function canAddNotes(story: ServedStory): Promise<boolean> {
  if (story.meta.kind === 'local') {
    return true;
  }
  const author = prAuthorOf(story.dir, story.meta);
  if (!author) {
    return false;
  }
  const viewer = await ghLogin();
  return !!viewer && viewer.toLowerCase() === author.toLowerCase();
}

/** The story's fix-before-push view with whether it can take new notes (`can_add`). */
export async function fixesViewOf(app: App, story: ServedStory): Promise<FixesView> {
  return { ...fixesView(app.home, app.stories, story), can_add: await canAddNotes(story) };
}

/** Add to fix before push: a drafted comment from the story becomes a note, once. Returns {note, request}. */
export function noteFromDraft(
  app: App,
  story: ServedStory,
  where: { chapter: number | null; index: number | null },
) {
  const comment = draftOf((app.stories.load(story.id) as StoryData).chapters, where);
  const rel = relOfPath(comment.path, relsOf(app, story));
  if (!rel || !(Number(comment.line) > 0)) {
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
      line: Math.trunc(Number(comment.line)),
      body: String(comment.body ?? '').slice(0, MAX_NOTE_BODY),
      draft: key,
      chapter: where.chapter,
    },
    { inbox: app.inbox },
  );
}

/** POST .../notes: a new note. POST .../notes/<id>: done, its text, or deleting it (a draft note only). */
function notesRoute({ app, body: raw, send }: Call, story: ServedStory) {
  if (story.sub) {
    return send(
      200,
      updateNote(app.stories, story, story.sub, parseBody('noteUpdate', raw), { inbox: app.inbox }),
    );
  }
  const body = parseBody('noteAdd', raw);
  if (body.chapter != null && body.index != null) {
    return send(200, noteFromDraft(app, story, body).note);
  }
  const text = (body.body ?? '').slice(0, MAX_NOTE_BODY);
  if (!text.trim()) {
    throw new HttpError(400, 'body is required');
  }
  const { note } = addNote(
    app.home,
    app.stories,
    story,
    { path: body.path, side: body.side, line: body.line, body: text },
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
async function fixesRoute({ app, req, body: raw, send }: Call, story: ServedStory) {
  let sent = null;
  if (req.method === 'POST') {
    const body = parseBody('fixesAct', raw);
    if (body.action === 'send') {
      sent = sendNotes(app.home, app.stories, story, { ids: body.ids ?? null, inbox: app.inbox });
    } else if (body.action === 'auto') {
      setAutoSend(app.stories, story.id, body.on);
    } else {
      takeBack(app.home, app.stories, story.id, body.request || '');
    }
  }
  return send(200, { ...(await fixesViewOf(app, story)), ...(sent ? { sent } : {}) });
}

/** GET .../working: the story's "being changed" marks that still stand, and the last one cleared. */
const workingRoute = ({ app, send }: Call, story: ServedStory) =>
  send(200, workingOf(app.home, story.id));

export const fixRoutes: StoryRoute[] = [
  { route: ROUTES.noteAdd, handle: notesRoute },
  { route: ROUTES.noteUpdate, handle: notesRoute },
  { route: ROUTES.fixesRead, handle: fixesRoute },
  { route: ROUTES.fixesAct, handle: fixesRoute },
  { route: ROUTES.working, handle: workingRoute },
];
