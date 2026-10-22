/*
 * /api/health, /api/status (the panel's status light and the PR pages'
 * listener check) and /api/prefs (settings kept across stories, such as Hide
 * whitespace).
 */
import { readPrefs, writePrefs } from '../../config/settings.mjs';
import { storyRepo, REPO_RE } from '../../config/repos.mjs';
import { statusOf } from '../../listeners/listeners.mjs';
import { readMeta } from '../../stories/meta.mjs';

/** The status light: bridge, story, and a Claude session listening. */
function status({ app, url, send }) {
  // listeners are per repo, so this also works out the page's repo: the story's, or ?repo=
  const storyId = url.searchParams.get('story');
  const queryRepo = REPO_RE.test(url.searchParams.get('repo') || '')
    ? url.searchParams.get('repo')
    : null;
  let story;
  let repo = queryRepo;
  if (storyId) {
    story = app.stories.dirOf(storyId) ? storyId : null;
    if (story) {
      repo = storyRepo(readMeta(app.stories.dirOf(storyId))) || queryRepo;
    }
  }
  const { home, version } = app;
  return send(200, statusOf({ home, version, story, repo, extensionSeen: app.extensionSeen }));
}

export const statusRoutes = [
  {
    path: '/api/health',
    handle: ({ app, send }) =>
      send(200, { ok: true, name: 'pr-story-bridge', version: app.version }),
  },
  { path: '/api/status', method: 'GET', handle: status },
  {
    // page settings kept across stories and restarts (the local page's Hide whitespace)
    path: '/api/prefs',
    handle: ({ app, req, body, send }) =>
      req.method === 'GET' ? send(200, readPrefs(app.home)) : send(200, writePrefs(body, app.home)),
  },
];
