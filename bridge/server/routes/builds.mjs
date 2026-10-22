/*
 * Build requests: the pages' "Build story" and "Update" buttons ask for a
 * story (POST /api/builds), and `once-upon builds` lists them. How a
 * request stands comes back from status-many (catalog.mjs).
 */
import { readMeta } from '../../stories/meta.mjs';
import { stateKeyOf } from '../../github/drafts.mjs';
import { readReads, sinceOf, SHA_RE } from '../../stories/reads.mjs';

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

export const buildRoutes = [{ path: '/api/builds', method: 'POST', handle: requestBuild }];
