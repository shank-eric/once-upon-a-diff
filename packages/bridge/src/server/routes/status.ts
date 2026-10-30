/*
 * /api/health, /api/status (the panel's status light and the PR pages'
 * listener check) and /api/prefs (settings kept across stories, such as Hide
 * whitespace).
 */
import { readPrefs, writePrefs } from '../../config/settings.ts';
import { storyRepo, REPO_RE } from '../../config/repos.ts';
import { statusOf } from '../../listeners/listeners.ts';
import { readMeta } from '../../stories/meta.ts';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { parseBody } from '../validate.ts';
import type { ApiRoute, Call, ServedStory, StoryRoute } from '../../types.ts';

/** The status light: bridge, story, and a Claude session listening. */
function status({ app, url, send }: Call) {
  // listeners are per repo, so this also works out the page's repo: the story's, or ?repo=
  const storyId = url.searchParams.get('story');
  const queryRepo = REPO_RE.test(url.searchParams.get('repo') || '')
    ? url.searchParams.get('repo')
    : null;
  let story: string | null | undefined;
  let repo = queryRepo;
  if (storyId) {
    story = app.stories.dirOf(storyId) ? storyId : null;
    if (story) {
      repo = storyRepo(readMeta(app.stories.dirOf(storyId) as string)) || queryRepo;
    }
  }
  const { home, version } = app;
  return send(200, statusOf({ home, version, story, repo, extensionSeen: app.extensionSeen }));
}

/** GET or POST page settings: what /api/prefs answers. A POST's body is checked here, after the guards. */
const prefs = ({ app, req, body, send }: Call) =>
  req.method === 'GET'
    ? send(200, readPrefs(app.home))
    : send(200, writePrefs(parseBody('prefs', body), app.home));

/**
 * The same status light and page settings under a story's own path, for the local page, whose key reaches only
 * its story's routes: GET .../status and GET or POST .../prefs.
 */
export const storyStatusRoutes: StoryRoute[] = [
  {
    route: ROUTES.storyStatus,
    handle: ({ app, send }: Call, story: ServedStory) =>
      send(
        200,
        statusOf({
          home: app.home,
          version: app.version,
          story: story.id,
          repo: storyRepo(story.meta),
          extensionSeen: app.extensionSeen,
        }),
      ),
  },
  { route: ROUTES.storyPrefsRead, handle: prefs },
  { route: ROUTES.storyPrefsWrite, handle: prefs },
];

export const statusRoutes: ApiRoute[] = [
  {
    route: ROUTES.health,
    handle: ({ app, send }) =>
      send(200, { ok: true, name: 'once-upon-bridge', version: app.version }),
  },
  { route: ROUTES.status, handle: status },
  // page settings kept across stories and restarts (the local page's Hide whitespace)
  { route: ROUTES.prefsRead, handle: prefs },
  { route: ROUTES.prefsWrite, handle: prefs },
];
