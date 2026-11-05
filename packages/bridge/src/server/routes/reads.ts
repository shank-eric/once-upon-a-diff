/*
 * What the reviewer has read, per chapter, with the commit current at the
 * time (POST), and what changed after they read each chapter (GET).
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { readMeta, stateKeyOf } from '../../services/stories/meta.ts';
import { currentHead, changesSince } from '../../services/review/freshness.ts';
import { newId } from '../../services/config/ids.ts';
import {
  readReads,
  noteRead,
  sinceOf,
  readSha,
  changedSinceRead,
} from '../../services/stories/reads.ts';
import { SHA_RE, shortSha } from '@once-upon-a-diff/domain/text';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import type { StoryData } from '@once-upon-a-diff/contracts/types';
import type { FileChange } from '../../services/review/freshness.ts';
import type { ServedStory, StoryMeta } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

type ReadBody = ReturnType<typeof parseBody<'readNote'>>;

/** The PR's head: the panel says what it saw, else ask gh (read-only, cached 60s); a local story's is its head commit. */
async function headOf(body: ReadBody, now: StoryMeta): Promise<string | null> {
  let head = SHA_RE.test(body.head_sha || '') ? (body.head_sha as string) : null;
  if (!head && now.kind === 'github' && now.repo && now.number) {
    try {
      head = await currentHead(now.repo, now.number);
    } catch {
      head = null;
    }
  }
  return head || now.head_oid || null;
}

async function noteChapterRead(
  app: App,
  story: ServedStory,
  key: string,
  data: StoryData,
  now: StoryMeta,
  body: ReadBody,
) {
  const chapterKey = body.chapter;
  const chapter = data.chapters.find((candidate) => candidate.key === chapterKey);
  if (!chapter) {
    throw new HttpError(404, 'no chapter with that key');
  }
  const head = await headOf(body, now);
  const record = noteRead(app.home, key, chapterKey as string, {
    head_sha: head,
    story_head: now.head_oid || head,
    reason: body.reason as string,
    title: chapter.title,
    step: body.step,
    seconds: body.seconds ?? null,
  });
  app.inbox.append({
    type: 'read',
    id: newId('rd'),
    ...story.ref,
    chapter: chapterKey as string,
    step: record.step,
    title: record.title,
    head_sha: record.head_sha,
    story_head: record.story_head,
    reason: record.reason,
  });
  return { chapter: chapterKey, ...record };
}

async function reads({ app, req, body: raw, send }: Call, story: ServedStory) {
  const key = stateKeyOf(story.id, story.meta);
  const data = app.stories.load(story.id) as StoryData;
  const now = story.meta.kind === 'local' ? readMeta(story.dir) : story.meta; // load() follows a local story's branch
  if (req.method === 'POST') {
    return send(200, await noteChapterRead(app, story, key, data, now, parseBody('readNote', raw)));
  }
  const readsByChapter = readReads(app.home, key);
  // what changed after they read each chapter: one compare per commit they read at (gh, cached; or git for a local story)
  const changes = new Map<string, Map<string, FileChange>>();
  let error: string | null = null;
  for (const sha of new Set(
    Object.values(readsByChapter)
      .map(readSha)
      .filter((read): read is string => !!read),
  )) {
    try {
      changes.set(sha, await changesSince(now, sha));
    } catch (e) {
      error = `couldn't compare ${shortSha(sha)} with the story's head: ${(e as Error).message}`;
    }
  }
  return send(200, {
    reads: readsByChapter,
    since: sinceOf(readsByChapter, data.chapters, now.head_oid || null),
    story_head: now.head_oid || null,
    ...changedSinceRead(data.chapters, readsByChapter, changes, now.head_oid || null),
    error,
  });
}

export const readRoutes: StoryRoute[] = [
  { route: ROUTES.readRead, handle: reads },
  { route: ROUTES.readNote, handle: reads },
];
