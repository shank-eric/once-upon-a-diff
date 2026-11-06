/*
 * POST /api/usage and POST /api/stories/:id/usage: a page's batch of UI action counts. Only the names terms/usage-actions.ts
 * lists are kept; the bridge counts every route call itself (server/index.ts), so these carry only what never reaches it.
 */
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { parseBody } from '../validate.ts';
import type { ApiRoute, Call, StoryRoute } from '../types.ts';

function count({ app, body, send, surface }: Call) {
  const { counts } = parseBody('usage', body);
  const counting = app.usage.counting();
  if (counting) {
    app.usage.actions(counts, surface);
  }
  return send(200, { on: counting });
}

export const usageRoutes: ApiRoute[] = [{ route: ROUTES.usageCount, handle: count }];
export const storyUsageRoutes: StoryRoute[] = [{ route: ROUTES.storyUsageCount, handle: count }];
