/*
 * Create pull request on a local story's page (../../stories/pull-request.ts): GET .../pr says where the branch
 * stands, and POST .../pr {action: 'push', head_sha} pushes it, only from the reviewer's click in the confirm box.
 * The page opens the PR itself on GitHub's compare page.
 */
import { HttpError } from '../request.ts';
import { DRAFT_FILE, prView, pushBlocker, pushBranch } from '../../stories/pull-request.ts';
import type { PrDraft, PrPushAnswer } from '@once-upon-a-diff/shared/types';
import type { App, Call, ServedStory, StoryRoute } from '../../types.ts';

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

async function push({ app, body, send }: Call, story: ServedStory) {
  localOnly(story);
  if (body.action !== 'push') {
    throw new HttpError(400, 'action must be push');
  }
  if (pushing.has(story.id)) {
    throw new HttpError(409, 'a push for this story is already running');
  }
  pushing.add(story.id);
  try {
    const before = await prView(story.meta, draftOf(app, story));
    const blocker = pushBlocker(before, body.head_sha);
    if (blocker) {
      throw new HttpError(409, blocker);
    }
    const branch = before.branch as string;
    if (before.remote.state === 'same') {
      return send(200, { output: 'Already on GitHub: nothing to push.', view: before });
    }
    app.log(`pushing ${branch} for ${story.id}, on the page's Create pull request`);
    let output: string;
    try {
      output = await pushBranch(story.meta.repo_path as string, branch);
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
  { what: 'pr', method: 'GET', handle: view },
  { what: 'pr', method: 'POST', handle: push },
];
