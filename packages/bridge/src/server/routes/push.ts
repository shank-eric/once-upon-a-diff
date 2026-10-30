/*
 * Push on a local story's page, for commits that go straight to the repo's default branch (../../services/stories/push-default.ts):
 * GET .../push says what a push of the approved commit would do, and POST .../push {action: 'push', head_sha} does it,
 * only from the reviewer's click in the confirm box. head_sha is the approved commit the box showed. The full page key
 * only: the read-only key reaches neither (page-key.ts). Right after a push the story's delivered check runs, which
 * clears its card.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import { approvedFor, pushApproved, pushView } from '../../services/stories/push-default.ts';
import { localEntries } from '../../services/review/story-lists.ts';
import { refreshLocal } from '../../services/stories/local-diff.ts';
import type { PushAnswer } from '@once-upon-a-diff/shared/types';
import type { LocalMeta, ServedStory } from '../../services/stories/types.ts';
import type { Call, StoryRoute } from '../types.ts';

/** Stories with a push under way, so a second click can't start another. */
const pushing = new Set<string>();
/** How long a push's answer waits for the delivered check before it goes without it. */
const CHECK_WAIT_MS = 5000;

function localOnly(story: ServedStory) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, 'a PR story is not pushed from here');
  }
}

async function view({ app, send }: Call, story: ServedStory) {
  localOnly(story);
  return send(200, await pushView(story.meta, approvedFor(app.stories, story.id)));
}

async function push({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story);
  const body = parseBody('pushApproved', raw);
  if (pushing.has(story.id)) {
    throw new HttpError(409, 'a push for this story is already running');
  }
  pushing.add(story.id);
  try {
    const approval = approvedFor(app.stories, story.id);
    const before = await pushView(story.meta, approval);
    if (!approval || !before.approved_sha) {
      throw new HttpError(409, before.blocker || 'Approve the story first');
    }
    if (body.head_sha !== before.approved_sha) {
      throw new HttpError(
        409,
        'the approved commit changed since the box opened. Look again before pushing.',
      );
    }
    if (before.blocker || !before.branch) {
      throw new HttpError(409, before.blocker || 'no default branch to push to');
    }
    app.log(
      `pushing ${before.approved_sha.slice(0, 7)} to ${before.branch} for ${story.id}, on the page's Push`,
    );
    let output: string;
    try {
      output = await pushApproved(
        story.meta.repo_path as string,
        before.branch,
        before.approved_sha,
      );
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    // the story's head as it is now (commits made since Approve are not pushed and stay in review), then the delivered
    // check (AutoReview.kickLocal), which finds the commit in origin's default branch and clears the card
    refreshLocal(story.dir, story.meta as LocalMeta);
    app.autoReview.forget(story.id);
    app.autoReview.kickLocal(localEntries(app.stories).filter((one) => one.story.id === story.id));
    await Promise.race([
      app.autoReview.idle(),
      new Promise((resolve) => setTimeout(resolve, CHECK_WAIT_MS).unref()),
    ]);
    const answer: PushAnswer = {
      output,
      view: await pushView(story.meta, approvedFor(app.stories, story.id)),
    };
    return send(200, answer);
  } finally {
    pushing.delete(story.id);
  }
}

export const pushRoutes: StoryRoute[] = [
  { route: ROUTES.pushView, handle: view },
  { route: ROUTES.pushApproved, handle: push },
];
