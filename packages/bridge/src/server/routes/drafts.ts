// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Drafted comments: what's become of each one (posted, in the reviewer's
 * pending review, dismissed, or still a draft), the reviewer's own marks, and
 * Add to my review. Read-only on GitHub, except Add to my review, which adds
 * the draft to their pending review (never submitted). Add to fix before push
 * (action fix) makes the draft a note (./fixes.mjs). A comment drafted in
 * Q&A comes in through `once-upon comment`.
 */
import { newId } from '../../inbox/inbox.ts';
import {
  stateKeyOf,
  readMarks,
  mark,
  draftsOf,
  forgetComments,
  addedMark,
  noteAdded,
} from '../../github/drafts.ts';
import { addToPendingReview } from '../../github/review.ts';
import { HttpError, toInt } from '../request.ts';
import { noteFromDraft } from './fixes.ts';

/** The drafted comment a request names by chapter (1-based) and index, else 404. */
export function draftOf(chapters, body) {
  const chapter = chapters[toInt(body.chapter) - 1];
  const comment = chapter && chapter.comments[toInt(body.index)];
  if (!comment) {
    throw new HttpError(404, 'no such draft');
  }
  return comment;
}

/** Add to my review: the draft goes into their pending review on GitHub, once. */
async function addToReview(app, story, key, comment, body) {
  const { meta } = story;
  if (meta.kind !== 'github' || !meta.repo || !meta.number) {
    throw new HttpError(400, 'only PR stories have a GitHub review');
  }
  // once is enough: a second click (or another tab) would put a second copy in the review
  if (addedMark(readMarks(app.home, key), comment)) {
    throw new HttpError(409, "it's already in your pending review");
  }
  let added;
  try {
    added = await addToPendingReview(meta.repo, meta.number, comment);
  } catch (e) {
    throw new HttpError(e.status || 502, `couldn't add it to your review: ${e.message}`);
  }
  noteAdded(app.home, key, comment, added); // the panel shows it as added until the page or gh shows it
  forgetComments(meta.repo, meta.number);
  app.inbox.append({
    type: 'review_comment',
    id: newId('r'),
    ...story.ref,
    chapter: toInt(body.chapter),
    path: comment.path,
    line: comment.line,
    url: added.url,
    started: added.started,
  });
  return added;
}

async function drafts({ app, req, body, send }, story) {
  const { meta } = story;
  const key = stateKeyOf(story.id, meta);
  let added = null;
  if (req.method === 'POST') {
    const comment = draftOf(app.stories.load(story.id).chapters, body);
    if (body.action === 'review') {
      added = await addToReview(app, story, key, comment, body);
    } else if (body.action === 'fix') {
      noteFromDraft(app, story, body); // Add to fix before push
    } else {
      mark(app.home, key, String(body.action || ''), comment);
    }
  }
  const { rows, login, error } = await draftsOf(app.home, app.stories, story.id, meta);
  return send(200, {
    drafts: rows,
    login,
    checked_at: new Date().toISOString(),
    error,
    added,
  });
}

export const draftRoutes = [{ what: 'drafts', handle: drafts }];
