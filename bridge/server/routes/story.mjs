/*
 * One story: its data (GET /api/stories/<id>), its version (the pages poll it
 * to redraw when chapters.json changes), the panel's saved state (ui), where
 * the reviewer is (position) and whether the story is up to date (freshness).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPrefs } from '../../config/settings.mjs';
import { seenCheckout } from '../../config/repos.mjs';
import { freshness } from '../../github/freshness.mjs';
import { refreshLocal } from '../../stories/local-diff.mjs';
import { storyVersion, localVersion } from '../../stories/meta.mjs';
import { clipText, toInt } from '../request.mjs';

function load({ app, send }, story) {
  if (story.meta.kind === 'local' && story.ref.repo) {
    seenCheckout(app.home, story.ref.repo, story.meta.repo_path); // where to tell a listener to work from
  }
  return send(200, app.stories.load(story.id));
}

function version({ app, send }, story) {
  if (story.meta.kind === 'local') {
    refreshLocal(story.dir, readMetaFile(story.dir));
    return send(200, { version: localVersion(story.dir, readPrefs(app.home)) });
  }
  return send(200, { version: storyVersion(story.dir) });
}

/** meta.json as written, for the local diff refresh (readMeta fills in defaults). Throws when it's missing or broken. */
const readMetaFile = (dir) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));

function panelState({ app, req, body, send }, story) {
  if (req.method === 'GET') {
    return send(200, app.stories.readState(story.id, 'ui.json', {}));
  }
  const saved = {
    n: toInt(body.n) ?? 0,
    all: !!body.all,
    collapsed: !!body.collapsed,
    width: toInt(body.width),
    hidden: !!body.hidden,
    filesOpen: !!body.filesOpen,
    at: new Date().toISOString(),
  };
  app.stories.writeState(story.id, 'ui.json', saved);
  return send(200, saved);
}

function position({ app, body, send }, story) {
  const where = {
    step: toInt(body.step),
    chapter: clipText(body.chapter, 300),
    file: clipText(body.file, 1000),
    url: clipText(body.url, 2000),
  };
  app.stories.writeState(story.id, 'position.json', { ...where, at: new Date().toISOString() });
  return send(200, { ok: true });
}

async function storyFreshness({ app, send }, story) {
  const { meta } = story;
  const lastBuild =
    meta.kind === 'github' && meta.repo && meta.number
      ? app.builds.get(meta.repo, meta.number)
      : null;
  return send(200, await freshness(meta, app.stories.load(story.id).chapters, { lastBuild }));
}

export const storyRoutes = [
  { what: '', method: 'GET', handle: load },
  { what: 'version', method: 'GET', handle: version },
  { what: 'ui', handle: panelState },
  { what: 'position', method: 'POST', handle: position },
  { what: 'freshness', method: 'GET', handle: storyFreshness },
];
