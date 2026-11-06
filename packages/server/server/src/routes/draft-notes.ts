/*
 * Turning a drafted comment into a fix-before-push note (the drafts route's `fix` action and the notes route's
 * add-from-a-draft), and finding the draft a request names. Shared by drafts.ts and fixes.ts so neither imports the other.
 */
import { addNote, MAX_NOTE_BODY, readNotes } from '@once-upon-a-diff/state/queues/requests/fixes';
import { draftKey } from '@once-upon-a-diff/core/features/review/drafts';
import { relOfPath } from '@once-upon-a-diff/stories/diff';
import { HttpError } from '../request.ts';
import type { DraftComment, StoryData } from '@once-upon-a-diff/contracts/types';
import type { ServedStory } from '@once-upon-a-diff/stories/types';
import type { App } from '../types.ts';

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

/** The files a note can be on: a local story's diff, or a PR story's files. */
function relsOf(app: App, story: ServedStory): string[] {
  const data = app.stories.load(story.id) as StoryData;
  return data.local ? data.local.files.map((file) => file.rel) : data.files.map((file) => file.rel);
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
