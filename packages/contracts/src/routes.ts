/*
 * The route table: every call the bridge's HTTP API answers, with its method, its path, which keys may make it, the
 * body it takes and the answer it gives. The bridge registers its handlers from these entries, and the clients
 * (the extension, the board and the local page) call through them with the client in the api-client package, so a
 * route's path and shapes are written once.
 *
 * This file is the index. The entries are in each area's folder (bridge/, github/, board/, story/ routes.ts), built
 * with the factories in route-kit.ts, and the table is assembled here in the order the calls have always been listed.
 *
 * Nothing here runs valibot. A body's type comes from its schema in ./schemas.ts through `import type`, which is
 * erased, so a page that imports this file never loads the schemas. Types only for the rest, and no DOM or Node.
 *
 * Pages and assets (GET /local/<id>/, GET /board/, /assets/*) are served, not called, so they are not here.
 */
import { BRIDGE_ROUTES } from './bridge/routes.ts';
import { GITHUB_ROUTES } from './github/routes.ts';
import { BOARD_ROUTES } from './board/routes.ts';
import { STORY_ROUTES } from './story/routes.ts';
import type { Keys, Route } from './route-kit.ts';

export type { Keys, Route } from './route-kit.ts';
export type { SavedUi } from './story/routes.ts';

export const ROUTES = {
  ...BRIDGE_ROUTES,
  ...GITHUB_ROUTES,
  ...BOARD_ROUTES,
  ...STORY_ROUTES,
} as const;

/** The name of a route in ROUTES. */
export type RouteName = keyof typeof ROUTES;

/** Any route: a Route is read-only in its types, so each one fits. */
export type AnyRoute = Route<unknown, unknown, unknown, unknown>;

/** Whether the agent board page's key may make this call. */
export const boardKeyMay = (route: { keys: Keys }): boolean => route.keys === 'token+board';

/** Whether a local story's read-only key may make this call. */
export const viewKeyAllowed = (route: { keys: Keys }): boolean => route.keys === 'token+page+view';

/** What a route takes and gives, from the types it was written with. */
export type BodyOf<R extends AnyRoute> = NonNullable<R['types']>['body'];
export type AnswerOf<R extends AnyRoute> = NonNullable<R['types']>['answer'];
export type QueryOf<R extends AnyRoute> = NonNullable<R['types']>['query'];
export type ParamsOf<R extends AnyRoute> = NonNullable<R['types']>['params'];
