/*
 * Build requests: the pages' "Build story" and "Update" buttons ask for a
 * story (POST /api/builds), and `once-upon builds` lists them. How a
 * request stands comes back from status-many (catalog.ts).
 */
import { readMeta } from '../../stories/meta.ts';
import { stateKeyOf } from '../../github/drafts.ts';
import { readReads, sinceOf } from '../../stories/reads.ts';
import { SHA_RE } from '@once-upon-a-diff/shared/util/text';
import type { StoryData } from '@once-upon-a-diff/shared/types';
import type { BuildAsk } from '../../inbox/builds.ts';
import type { ApiRoute, App, Body, Call } from '../../types.ts';

/** An update starts where the reviewer's reading stopped (read.json), so the story can add one "Since you read it" chapter. */
function sinceOfUpdate(app: App, body: Body) {
  const hit =
    body.mode === 'update'
      ? app.stories.find(String(body.repo || ''), body.number as number | string)
      : null;
  if (!hit) {
    return null;
  }
  const meta = readMeta(app.stories.dirOf(hit.id) as string);
  const told = SHA_RE.test(String(body.base_sha || ''))
    ? (body.base_sha as string)
    : meta.head_oid || null;
  return {
    ...sinceOf(
      readReads(app.home, stateKeyOf(hit.id, meta)),
      (app.stories.load(hit.id) as StoryData).chapters,
      told,
    ),
    story: hit.id,
  };
}

function requestBuild({ app, body, send }: Call) {
  app.statusCache = null;
  const since = sinceOfUpdate(app, body);
  const build = app.builds.view(
    // request() checks what the page sent
    app.builds.request({ ...(body as unknown as BuildAsk), retell: body.retell === true, since }),
  );
  return send(200, { state: build!.state, request: build });
}

export const buildRoutes: ApiRoute[] = [
  { path: '/api/builds', method: 'POST', handle: requestBuild },
];
