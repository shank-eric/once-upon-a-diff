/*
 * What only a local story keeps on the bridge: Viewed per file (GitHub keeps it for PR stories), and Approve (POST
 * .../approve {head_sha, approved?}: ready to ship at that head, which a session hears as an `approved` event; the full
 * page key only, as it is not on the read-only key's list in ../page-key.ts), and POST .../lines {path, head_oid}: the text of
 * a file of the diff at the story's head, for the page's Expand controls. Fix-before-push notes are in ./fixes.ts,
 * for PR and local stories alike.
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { unwrittenCount } from '@once-upon-a-diff/stories/skeleton';
import { approvalAtTip } from '@once-upon-a-diff/stories/approval';
import { approveStory, clearApproval } from '@once-upon-a-diff/core/features/review/approve';
import { approvableTip } from '@once-upon-a-diff/core/features/review/carry-approval';
import { finishStoryRuns } from '@once-upon-a-diff/core/features/review/approve-runs';
import { storyRepo } from '@once-upon-a-diff/stories/meta';
import type { LocalStory, StoryData } from '@once-upon-a-diff/contracts/types';
import { FileLinesRefusal, fileLinesAt, refreshLocal } from '@once-upon-a-diff/stories/local-diff';
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

function fileLines({ body: raw, send }: Call, story: ServedStory) {
  localOnly(story, 'GitHub draws the diff of a PR story');
  const body = parseBody('fileLines', raw);
  const meta = refreshLocal(story.dir, story.meta as LocalMeta);
  // the page's head is only a staleness check: the text is always read at the story's own head
  if (body.head_oid !== meta.head_oid) {
    throw new HttpError(409, 'the branch has moved since this page showed it: reload');
  }
  try {
    return send(200, { lines: fileLinesAt(story.dir, meta, body.path) });
  } catch (error) {
    if (!(error instanceof FileLinesRefusal)) {
      throw error;
    }
    const why = {
      'not-in-diff': [404, 'that file is not in the diff'],
      gone: [404, 'that file is not in the head commit'],
      binary: [422, 'that file is binary'],
      'too-large': [422, 'that file is too large to expand'],
    } as const;
    throw new HttpError(why[error.kind][0], why[error.kind][1]);
  }
}

function approve({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story, 'a PR story is approved on GitHub');
  const body = parseBody('approve', raw);
  // the head as it is now: a commit since the page drew moves it
  const meta = refreshLocal(story.dir, story.meta as LocalMeta);
  const answer = () => {
    const found = approvalAtTip(app.stories, story.id, meta);
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
  // a story pinned to a branch that has moved: a rebase of its commits is approved at the tip, any other move is refused
  const moved = approvableTip(meta);
  if (moved === 'stale') {
    throw new HttpError(
      409,
      'the branch has moved on since this story was told: rebuild the story before approving',
    );
  }
  const approvedOid = moved?.tip ?? headOid;
  const added = approveStory(app.stories, app.inbox, {
    id: story.id,
    ref: story.ref,
    branch: meta.branch || null,
    checkout: meta.repo_path || null,
    base: meta.base || null,
    headOid: approvedOid,
    baseOid: moved?.base ?? (meta.base_oid || null),
    ...(moved && { rebasedFrom: headOid }),
  });
  if (added) {
    finishStoryRuns(
      app.home,
      { repo: storyRepo(meta), branch: meta.branch || null, id: story.id },
      approvedOid,
    );
  }
  app.board.refresh(); // its card moves to Ready to ship on the page's next poll
  return send(200, answer());
}

export const localStoryRoutes: StoryRoute[] = [
  { route: ROUTES.viewed, handle: viewed },
  { route: ROUTES.fileLines, handle: fileLines },
  { route: ROUTES.approve, handle: approve },
];
