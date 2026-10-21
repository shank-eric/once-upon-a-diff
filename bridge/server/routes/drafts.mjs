/*
 * Drafted comments: what's become of each one (posted, in the reviewer's
 * pending review, dismissed, or still a draft), the reviewer's own marks, Add
 * to my review, and a comment drafted in Q&A landing in a chapter. Read-only
 * on GitHub, except Add to my review, which adds the draft to their pending
 * review (never submitted).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '../../inbox/inbox.mjs';
import { addComment } from '../../lib/comments.mjs';
import {
  stateKeyOf,
  readMarks,
  mark,
  draftStatus,
  githubComments,
  forgetComments,
  addedMark,
  noteAdded,
} from '../../github/drafts.mjs';
import { addToPendingReview } from '../../github/review.mjs';
import { HttpError, toInt } from '../request.mjs';

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
  const data = app.stories.load(story.id);
  let added = null;
  if (req.method === 'POST') {
    const comment = draftOf(data.chapters, body);
    if (body.action === 'review') {
      added = await addToReview(app, story, key, comment, body);
    } else {
      mark(app.home, key, String(body.action || ''), comment);
    }
  }
  let github = null;
  let error = null;
  if (meta.kind === 'github' && meta.repo && meta.number) {
    try {
      github = await githubComments(meta.repo, meta.number);
    } catch (e) {
      error = `couldn't read the PR's comments with gh: ${e.message}`;
    }
  }
  const notes = meta.kind === 'local' ? app.stories.readState(story.id, 'notes.json', []) : null;
  return send(200, {
    drafts: draftStatus(data.chapters, readMarks(app.home, key), github, notes),
    login: github ? github.login : null,
    checked_at: new Date().toISOString(),
    error,
    added,
  });
}

/** A comment drafted in Q&A lands in the chapter's Draft comments (never posted anywhere). */
function addDraftedComment({ app, body, send }, story) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path.join(story.dir, 'meta.json'), 'utf8'));
  } catch {
    raw = {};
  }
  const result = addComment(story.dir, raw, body);
  if (result.added) {
    app.inbox.append({
      type: 'comment',
      id: newId('c'),
      ...story.ref,
      chapter: result.chapter,
      comment: result.comment,
    });
  }
  return send(200, result);
}

export const draftRoutes = [
  { what: 'drafts', handle: drafts },
  { what: 'comments', method: 'POST', handle: addDraftedComment },
];
