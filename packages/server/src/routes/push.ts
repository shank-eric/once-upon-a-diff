/*
 * Push on a local story's page, for commits that go straight to the repo's default branch (stories/src/push-default.ts):
 * GET .../push says what a push of the approved commit would do, and POST .../push {action: 'push', head_sha} does it,
 * only from the reviewer's click in the confirm box. head_sha is the approved commit the box showed. A storyless review
 * (made by the board's Review, no story told) has no Approve: the commit its diff was drawn at (the story's stored head) is
 * what a push sends, and the page sends that head, so seeing the diff and clicking Push is the approval. Any other commit,
 * such as one made since, is refused, never pushed unseen. The full page key
 * only: the read-only key reaches neither (page-key.ts). Right after a push the story's delivered check runs, which
 * clears its card.
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { HttpError } from '../request.ts';
import { localOnly, oncePerStory } from './story-guards.ts';
import { parseBody } from '../validate.ts';
import { approvedFor, pushApproved, pushView } from '@once-upon-a-diff/stories/push-default';
import { localEntries } from '@once-upon-a-diff/core/features/review/story-lists';
import { refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import { isStoryless } from '@once-upon-a-diff/stories/local-story';
import type { PushAnswer } from '@once-upon-a-diff/contracts/types';
import type { LocalMeta, ServedStory } from '@once-upon-a-diff/stories/types';
import type { App, Call, StoryRoute } from '../types.ts';
import { shortSha } from '@once-upon-a-diff/domain/text';

const NOT_LOCAL = 'a PR story is not pushed from here';

/** How long a push's answer waits for the delivered check before it goes without it. */
const CHECK_WAIT_MS = 5000;

/** The commit a push may send: the approved one, or for a storyless review the head its diff was drawn at. */
function approvalOf(app: App, story: ServedStory) {
  if (isStoryless(story.dir)) {
    const shown = (story.meta as LocalMeta).head_oid;
    return shown ? { head_oid: shown, at: new Date().toISOString() } : null;
  }
  return approvedFor(app.stories, story.id);
}

async function view({ app, send }: Call, story: ServedStory) {
  localOnly(story, NOT_LOCAL);
  return send(200, await pushView(story.meta, approvalOf(app, story)));
}

async function push({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story, NOT_LOCAL);
  const body = parseBody('pushApproved', raw);
  return oncePerStory(story.id, async () => {
    const approval = approvalOf(app, story);
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
      `pushing ${shortSha(before.approved_sha)} to ${before.branch} for ${story.id}, on the page's Push`,
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
    app.autoReview.kickLocal(
      localEntries(app.stories).filter((one) => one.story.id === story.id),
      Date.now(),
    );
    await Promise.race([
      app.autoReview.idle(),
      new Promise((resolve) => setTimeout(resolve, CHECK_WAIT_MS).unref()),
    ]);
    // the page's card clears on its next poll, not after the board's kept answer runs out
    app.board.refresh();
    const answer: PushAnswer = {
      output,
      view: await pushView(story.meta, approvalOf(app, story)),
    };
    return send(200, answer);
  });
}

export const pushRoutes: StoryRoute[] = [
  { route: ROUTES.pushView, handle: view },
  { route: ROUTES.pushApproved, handle: push },
];
