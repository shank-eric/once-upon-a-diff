/*
 * Build requests: the pages' "Build story" and "Update" buttons ask for a
 * story (POST /api/builds), `diff-story builds` lists them, and a PR page
 * asks how its request stands (GET /api/builds/status).
 */
import { readMeta } from '../../stories/meta.mjs';
import { stateKeyOf } from '../../github/drafts.mjs';
import { readReads, sinceOf, SHA_RE } from '../../stories/reads.mjs';
import { storyFinishes } from './catalog.mjs';

/** An update starts where the reviewer's reading stopped (read.json), so the story can add one "Since you read it" chapter. */
function sinceOfUpdate(app, body) {
  const hit =
    body.mode === 'update' ? app.stories.find(String(body.repo || ''), body.number) : null;
  if (!hit) {
    return null;
  }
  const meta = readMeta(app.stories.dirOf(hit.id));
  const told = SHA_RE.test(String(body.base_sha || '')) ? body.base_sha : meta.head_oid || null;
  return {
    ...sinceOf(
      readReads(app.home, stateKeyOf(hit.id, meta)),
      app.stories.load(hit.id).chapters,
      told,
    ),
    story: hit.id,
  };
}

function requestBuild({ app, body, send }) {
  app.statusCache = null;
  const since = sinceOfUpdate(app, body);
  const build = app.builds.view(
    app.builds.request({ ...body, retell: body.retell === true, since }),
  );
  return send(200, { state: build.state, request: build });
}

/** A PR's story and build request: ready (maybe updating), queued or building, or none. */
function buildStatus({ app, url, send }) {
  const repo = url.searchParams.get('repo') || '';
  const number = url.searchParams.get('number');
  const hit = app.stories.find(repo, number);
  let build = app.builds.get(repo, number);
  // the story turned up (for an update: its head moved off the one it was asked to update from)
  if (hit && storyFinishes(app, hit.id, build)) {
    build = app.builds.done(build.id, { story: hit.id });
  }
  build = app.builds.view(build);
  const pending = !!(build && build.status === 'pending');
  if (hit) {
    const updating = pending && build.mode === 'update';
    return send(200, {
      state: 'ready',
      story: hit.id,
      version: hit.version,
      title: hit.title,
      request: build,
      updating,
      update_state: updating ? build.state : null,
    });
  }
  if (pending) {
    return send(200, { state: build.state, request: build }); // queued (no session has it yet) or building
  }
  return send(200, { state: 'none', request: build });
}

export const buildRoutes = [
  { path: '/api/builds', method: 'POST', handle: requestBuild },
  { path: '/api/builds/status', method: 'GET', handle: buildStatus },
];
