/*
 * Build requests: the pages' "Build story" and "Update" buttons ask for a
 * story (POST /api/builds), and `once-upon builds` lists them. How a
 * request stands comes back from status-many (catalog.ts).
 */
import { readMeta, stateKeyOf } from '@once-upon-a-diff/stories/meta';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { parseBody } from '../validate.ts';
import { readReads, sinceOf } from '@once-upon-a-diff/stories/reads';
import { SHA_RE } from '@once-upon-a-diff/terms/text';
import type { StoryData } from '@once-upon-a-diff/contracts/types';
import type { ApiRoute, App, Call } from '../types.ts';

type BuildBody = ReturnType<typeof parseBody<'buildRequest'>>;

/** An update starts where the reviewer's reading stopped (read.json), so the story can add one "Since you read it" chapter. */
function sinceOfUpdate(app: App, body: BuildBody) {
  const hit = body.mode === 'update' ? app.stories.find(body.repo, body.number) : null;
  if (!hit) {
    return null;
  }
  const meta = readMeta(app.stories.dirOf(hit.id) as string);
  const told = SHA_RE.test(body.base_sha || '') ? (body.base_sha as string) : meta.head_oid || null;
  return {
    ...sinceOf(
      readReads(app.home, stateKeyOf(hit.id, meta)),
      (app.stories.load(hit.id) as StoryData).chapters,
      told,
    ),
    story: hit.id,
  };
}

function requestBuild({ app, body: raw, send }: Call) {
  const body = parseBody('buildRequest', raw);
  app.statusCache = null;
  const since = sinceOfUpdate(app, body);
  const build = app.builds.view(
    // request() checks the repo and the number as well
    app.builds.request({ ...body, since }),
  );
  return send(200, { state: build!.state, request: build });
}

export const buildRoutes: ApiRoute[] = [{ route: ROUTES.buildRequest, handle: requestBuild }];
