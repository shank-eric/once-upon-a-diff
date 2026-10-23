// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * What the reviewer has read, per chapter, with the commit current at the
 * time (POST), and what changed after they read each chapter (GET).
 */
import { readMeta } from '../../stories/meta.ts';
import { stateKeyOf } from '../../github/drafts.ts';
import { currentHead, changesSince } from '../../github/freshness.ts';
import { newId } from '../../inbox/inbox.ts';
import { readReads, noteRead, sinceOf, readSha, changedSinceRead } from '../../stories/reads.ts';
import { SHA_RE } from '@once-upon-a-diff/shared/util/text';
import { HttpError, clipText, toInt } from '../request.ts';

/** The PR's head: the panel says what it saw, else ask gh (read-only, cached 60s); a local story's is its head commit. */
async function headOf(body, now) {
  let head = SHA_RE.test(String(body.head_sha || '')) ? body.head_sha : null;
  if (!head && now.kind === 'github' && now.repo && now.number) {
    try {
      head = await currentHead(now.repo, now.number);
    } catch {
      head = null;
    }
  }
  return head || now.head_oid || null;
}

async function noteChapterRead(app, story, key, data, now, body) {
  const chapterKey = clipText(body.chapter, 200);
  const chapter = data.chapters.find((candidate) => candidate.key === chapterKey);
  if (!chapter) {
    throw new HttpError(404, 'no chapter with that key');
  }
  const head = await headOf(body, now);
  const record = noteRead(app.home, key, chapterKey, {
    head_sha: head,
    story_head: now.head_oid || head,
    reason: body.reason,
    title: chapter.title,
    step: toInt(body.step),
    seconds: body.seconds,
  });
  app.inbox.append({
    type: 'read',
    id: newId('rd'),
    ...story.ref,
    chapter: chapterKey,
    step: record.step,
    title: record.title,
    head_sha: record.head_sha,
    story_head: record.story_head,
    reason: record.reason,
  });
  return { chapter: chapterKey, ...record };
}

async function reads({ app, req, body, send }, story) {
  const key = stateKeyOf(story.id, story.meta);
  const data = app.stories.load(story.id);
  const now = story.meta.kind === 'local' ? readMeta(story.dir) : story.meta; // load() follows a local story's branch
  if (req.method === 'POST') {
    return send(200, await noteChapterRead(app, story, key, data, now, body));
  }
  const readsByChapter = readReads(app.home, key);
  // what changed after they read each chapter: one compare per commit they read at (gh, cached; or git for a local story)
  const changes = new Map();
  let error = null;
  for (const sha of new Set(Object.values(readsByChapter).map(readSha).filter(Boolean))) {
    try {
      changes.set(sha, await changesSince(now, sha));
    } catch (e) {
      error = `couldn't compare ${sha.slice(0, 7)} with the story's head: ${e.message}`;
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

export const readRoutes = [{ what: 'read', handle: reads }];
