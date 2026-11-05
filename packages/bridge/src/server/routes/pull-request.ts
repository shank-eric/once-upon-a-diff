/*
 * Create pull request on a local story's page (../../services/stories/pull-request.ts): GET .../pr says where the branch
 * stands, and POST .../pr {action: 'push', head_sha} pushes it, only from the reviewer's click in the confirm box.
 * The page opens the PR itself on GitHub's compare page. {action: 'push-ahead', head_sha} is Push for a branch that
 * already has an open PR: the same click-only fast-forward of what the PR is behind on, refused when there is no open PR
 * or origin has commits this checkout lacks. On a storyless review the click is the approval, so it pushes only the head
 * the page showed, by its sha (`<sha>:refs/heads/<branch>`), and then tracks origin's branch. A branch that has moved past
 * it is refused until Review on its card re-pins the review to the new tip, and a commit made after that check still
 * can't go out.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { HttpError } from '../request.ts';
import { localOnly, oncePerStory } from './story-guards.ts';
import { parseBody } from '../validate.ts';
import { storyRepo } from '../../services/config/repos.ts';
import {
  DRAFT_FILE,
  prView,
  pushAhead,
  pushAheadBlocker,
  pushBlocker,
  pushBranch,
} from '../../services/stories/pull-request.ts';
import type { PrDraft, PrPushAnswer } from '@once-upon-a-diff/protocol/types';
import { isStoryless } from '../../services/stories/local-story.ts';
import type { LocalMeta, ServedStory } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

const NOT_LOCAL = 'a PR story already has its pull request';

const draftOf = (app: App, story: ServedStory) =>
  app.stories.readState<PrDraft | null>(story.id, DRAFT_FILE, null);

async function view({ app, send }: Call, story: ServedStory) {
  localOnly(story, NOT_LOCAL);
  return send(200, await prView(story.meta, draftOf(app, story)));
}

async function push({ app, body: raw, send }: Call, story: ServedStory) {
  localOnly(story, NOT_LOCAL);
  const body = parseBody('prPush', raw);
  const ahead = body.action === 'push-ahead';
  return oncePerStory(story.id, async () => {
    const before = await prView(story.meta, draftOf(app, story));
    const blocker = ahead
      ? pushAheadBlocker(before, body.head_sha)
      : pushBlocker(before, body.head_sha);
    if (blocker) {
      throw new HttpError(409, blocker);
    }
    // a storyless review: the diff the page drew is what was approved, so the branch must still be at it
    const storyless = isStoryless(story.dir);
    const shown = (story.meta as LocalMeta).head_oid;
    if (storyless && (!shown || before.head_sha !== shown)) {
      throw new HttpError(409, 'the branch moved: click Review on its card to see the new commits');
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
      // a storyless review pushes the very commit the page showed, never whatever the branch holds by then
      output = await (ahead ? pushAhead : pushBranch)(
        story.meta.repo_path as string,
        branch,
        storyless ? shown : null,
      );
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    // the PR's head moved (its checks and approvals with it): ask GitHub again at the board's next build
    const repo = storyRepo(story.meta);
    if (repo) {
      app.autoReview.refresh({ repo, branch });
    }
    app.board.refresh();
    const answer: PrPushAnswer = {
      output,
      view: await prView(story.meta, draftOf(app, story)),
    };
    return send(200, answer);
  });
}

export const pullRequestRoutes: StoryRoute[] = [
  { route: ROUTES.prView, handle: view },
  { route: ROUTES.prPush, handle: push },
];
