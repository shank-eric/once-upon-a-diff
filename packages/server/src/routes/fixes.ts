/*
 * Fix before push, on PR and local stories alike: the notes (a line note, or a drafted comment turned into one by
 * Add to fix before push), sending them to a Claude session as one fix request (Send N notes, or Auto-send), and the
 * story's "being changed" marks from `once-upon working`. See state/src/queues/requests/fixes.ts and state/src/queues/requests/working.ts.
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import {
  addNote,
  fixesView,
  MAX_NOTE_BODY,
  sendNotes,
  setAutoSend,
  takeBack,
  updateNote,
} from '@once-upon-a-diff/state/queues/requests/fixes';
import { ghLogin } from '@once-upon-a-diff/core/features/review/drafts';
import { workingOf } from '@once-upon-a-diff/state/queues/requests/working';
import { prAuthorOf } from '@once-upon-a-diff/stories/meta';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { noteFromDraft } from './draft-notes.ts';
import type { FixesView } from '@once-upon-a-diff/contracts/types';
import type { ServedStory } from '@once-upon-a-diff/stories/types';
import type { App, Call, StoryRoute } from '../types.ts';

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
