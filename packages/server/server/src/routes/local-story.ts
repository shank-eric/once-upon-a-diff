/*
 * What only a local story keeps on the bridge: Viewed per file (GitHub keeps it for PR stories), and Approve (POST
 * .../approve {head_sha, approved?}: ready to ship at that head, which a session hears as an `approved` event; the full
 * page key only, as it is not on the read-only key's list in ../page-key.ts). Fix-before-push notes are in ./fixes.ts,
 * for PR and local stories alike.
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { unwrittenCount } from '@once-upon-a-diff/stories/skeleton';
import { approvalOf } from '@once-upon-a-diff/stories/approval';
import { approveStory, clearApproval } from '@once-upon-a-diff/core/features/review/approve';
import type { LocalStory, StoryData } from '@once-upon-a-diff/contracts/types';
import { refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import type { LocalMeta, ServedStory } from '@once-upon-a-diff/stories/types';
import type { Call, StoryRoute } from '../types.ts';
import { localOnly } from './story-guards.ts';

function viewed({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story, 'viewed files are kept by GitHub for PR stories');
  const body = parseBody('viewed', raw);
  const data = app.stories.load(story.id) as StoryData & { local: LocalStory };
  const file = data.local.files.find((candidate) => candidate.rel === body.path);
  if (!file) {
    throw new HttpError(404, 'that file is not in the diff');
  }
  const viewedFiles = app.stories.readState<Record<string, { hash?: string | null; at: string }>>(
    story.id,
    'viewed.json',
    {},
  ) as Record<string, { hash?: string | null; at: string }>;
  if (body.viewed) {
    viewedFiles[file.rel] = { hash: file.hash, at: new Date().toISOString() };
  } else {
    delete viewedFiles[file.rel];
  }
  app.stories.writeState(story.id, 'viewed.json', viewedFiles);
  return send(200, { path: file.rel, viewed: !!body.viewed });
}

function approve({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story, 'a PR story is approved on GitHub');
  const body = parseBody('approve', raw);
  // the head as it is now: a commit since the page drew moves it
  const meta = refreshLocal(story.dir, story.meta as LocalMeta);
  const answer = () => {
    const found = approvalOf(app.stories, story.id, meta.head_oid);
    return { approved: found ? { at: found.at, head_oid: found.head_oid } : null };
  };
  if (body.approved === false) {
    clearApproval(app.stories, story.id);
    app.board.refresh(); // its card leaves Ready to ship on the page's next poll
    return send(200, answer());
  }
  if (unwrittenCount(story.dir) > 0) {
    throw new HttpError(409, 'some chapters are still being written: approve once they are done');
  }
  const headOid = meta.head_oid;
  if (!headOid) {
    throw new HttpError(409, 'the story has no head yet: reload the page');
  }
  if (body.head_sha !== headOid) {
    throw new HttpError(
      409,
      'the branch has moved since this page showed it: reload before approving',
    );
  }
  approveStory(app.stories, app.inbox, {
    id: story.id,
    ref: story.ref,
    branch: meta.branch || null,
    checkout: meta.repo_path || null,
    base: meta.base || null,
    headOid,
    baseOid: meta.base_oid || null,
  });
  app.board.refresh(); // its card moves to Ready to ship on the page's next poll
  return send(200, answer());
}

export const localStoryRoutes: StoryRoute[] = [
  { route: ROUTES.viewed, handle: viewed },
  { route: ROUTES.approve, handle: approve },
];
