/*
 * Drafted comments: what's become of each one (posted, in the reviewer's
 * pending review, dismissed, or still a draft), the reviewer's own marks, and
 * Add to my review. Read-only on GitHub, except Add to my review, which adds
 * the draft to their pending review (never submitted). Add to fix before push
 * (action fix) makes the draft a note (./fixes.ts). A comment drafted in
 * Q&A comes in through `once-upon comment`.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { newId } from '../../services/inbox/inbox.ts';
import {
  stateKeyOf,
  readMarks,
  mark,
  draftsOf,
  forgetComments,
  addedMark,
  noteAdded,
} from '../../services/review/drafts.ts';
import { addToPendingReview } from '../../services/review/pending-review.ts';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { noteFromDraft } from './fixes.ts';
import type { DraftComment, StoryData } from '@once-upon-a-diff/shared/types';
import type { ServedStory } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

/** The drafted comment a request names by chapter (1-based) and index, else 404. */
export function draftOf(
  chapters: StoryData['chapters'],
  where: { chapter: number | null; index: number | null },
): DraftComment {
  const chapter = chapters[(where.chapter as number) - 1];
  const comment = chapter && chapter.comments[where.index as number];
  if (!comment) {
    throw new HttpError(404, 'no such draft');
  }
  return comment;
}

/** Add to my review: the draft goes into their pending review on GitHub, once. */
async function addToReview(
  app: App,
  story: ServedStory,
  key: string,
  comment: DraftComment,
  chapter: number | null,
) {
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
    const err = e as Error & { status?: number };
    throw new HttpError(err.status || 502, `couldn't add it to your review: ${err.message}`);
  }
  noteAdded(app.home, key, comment, added); // the panel shows it as added until the page or gh shows it
  forgetComments(meta.repo, meta.number);
  app.inbox.append({
    type: 'review_comment',
    id: newId('r'),
    ...story.ref,
    chapter,
    path: comment.path,
    line: comment.line,
    url: added.url,
    started: added.started,
  });
  return added;
}

async function drafts({ app, req, body: raw, send }: Call, story: ServedStory) {
  const { meta } = story;
  const key = stateKeyOf(story.id, meta);
  let added = null;
  if (req.method === 'POST') {
    const body = parseBody('draftsAct', raw);
    const comment = draftOf((app.stories.load(story.id) as StoryData).chapters, body);
    if (body.action === 'review') {
      added = await addToReview(app, story, key, comment, body.chapter);
    } else if (body.action === 'fix') {
      noteFromDraft(app, story, body); // Add to fix before push
    } else {
      mark(app.home, key, body.action, comment);
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

export const draftRoutes: StoryRoute[] = [
  { route: ROUTES.draftsRead, handle: drafts },
  { route: ROUTES.draftsAct, handle: drafts },
];
