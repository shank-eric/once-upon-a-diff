/*
 * Create pull request on a local story's page (../../services/stories/pull-request.ts): GET .../pr says where the branch
 * stands, and POST .../pr {action: 'push', head_sha} pushes it, only from the reviewer's click in the confirm box.
 * The page opens the PR itself on GitHub's compare page. {action: 'push-ahead', head_sha} is Push for a branch that
 * already has an open PR: the same click-only fast-forward of what the PR is behind on, refused when there is no open PR
 * or origin has commits this checkout lacks.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import {
  DRAFT_FILE,
  prView,
  pushAhead,
  pushAheadBlocker,
  pushBlocker,
  pushBranch,
} from '../../services/stories/pull-request.ts';
import type { PrDraft, PrPushAnswer } from '@once-upon-a-diff/protocol/types';
import type { ServedStory } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

/** Stories with a push under way, so a second click can't start another. */
const pushing = new Set<string>();

function localOnly(story: ServedStory) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, 'a PR story already has its pull request');
  }
}

const draftOf = (app: App, story: ServedStory) =>
  app.stories.readState<PrDraft | null>(story.id, DRAFT_FILE, null);

async function view({ app, send }: Call, story: ServedStory) {
  localOnly(story);
  return send(200, await prView(story.meta, draftOf(app, story)));
}

async function push({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story);
  const body = parseBody('prPush', raw);
  const ahead = body.action === 'push-ahead';
  if (pushing.has(story.id)) {
    throw new HttpError(409, 'a push for this story is already running');
  }
  pushing.add(story.id);
  try {
    const before = await prView(story.meta, draftOf(app, story));
    const blocker = ahead
      ? pushAheadBlocker(before, body.head_sha)
      : pushBlocker(before, body.head_sha);
    if (blocker) {
      throw new HttpError(409, blocker);
    }
    const branch = before.branch as string;
    if (before.remote.state === 'same') {
      return send(200, { output: 'Already on GitHub: nothing to push.', view: before });
    }
    app.log(
      `pushing ${branch} for ${story.id}, on the page's ${ahead ? 'Push (open PR)' : 'Create pull request'}`,
    );
    let output: string;
    try {
      output = await (ahead ? pushAhead : pushBranch)(story.meta.repo_path as string, branch);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    const answer: PrPushAnswer = {
      output,
      view: await prView(story.meta, draftOf(app, story)),
    };
    return send(200, answer);
  } finally {
    pushing.delete(story.id);
  }
}

export const pullRequestRoutes: StoryRoute[] = [
  { route: ROUTES.prView, handle: view },
  { route: ROUTES.prPush, handle: push },
];
