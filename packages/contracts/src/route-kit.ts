/*
 * What every area's route file builds its entries with: the key scopes, the shape of a route and the two factories (a
 * bridge-wide /api/ route, and a story's route under /api/stories/:id). A page loads this file with the area route files,
 * so it holds no valibot: a body's type comes from schemas.ts by `import type`, which is erased.
 */
import type { InferInput } from 'valibot';
import type * as schemas from './schemas.ts';

/**
 * Which keys may make the call (the bridge's token always may):
 *  - `token`: the token only
 *  - `token+board`: and the agent board page's key
 *  - `token+page`: and the full key of a local story's page, for that story
 *  - `token+page+view`: and the story's read-only key too
 *  - `none`: no key, the route checks the request itself (POST /auth/session)
 * The bridge enforces this in server/index.ts and server/page-key.ts. A test compares the two, so a route can't be
 * added to one without the other.
 */
export type Keys = 'token' | 'token+board' | 'token+page' | 'token+page+view' | 'none';

/** One call. Body, answer, query and params are types only: the entry holds none of them. */
export interface Route<Body = undefined, Answer = unknown, Query = undefined, Params = undefined> {
  readonly method: 'GET' | 'POST';
  /** the full path, with `:name` where a value goes (a story's id, a note's id) */
  readonly path: string;
  /** a story route's name, the path segment after the story's id ('' for the story itself) */
  readonly what?: string;
  /** a story route's part after `what`, when it has a fixed one ('marks') or a value (':note') */
  readonly sub?: string;
  readonly keys: Keys;
  readonly types?: { body: Body; answer: Answer; query: Query; params: Params };
}

type Bodies = typeof schemas.BODIES;
/** The body a route takes, as a caller writes it (a schema's input). */
export type In<Name extends keyof Bodies> = InferInput<Bodies[Name]>;

/** A bridge-wide route, /api/<path>. */
export const api = <Body = undefined, Answer = unknown, Query = undefined>(
  method: 'GET' | 'POST',
  path: string,
  keys: Keys,
): Route<Body, Answer, Query> => ({ method, path, keys });

/** A story's route, /api/stories/<id>/<what>[/<sub>]. */
export const story = <Body = undefined, Answer = unknown, Params = { id: string }>(
  method: 'GET' | 'POST',
  what: string,
  keys: Keys,
  sub?: string,
): Route<Body, Answer, undefined, Params> => ({
  method,
  path: `/api/stories/:id${what ? `/${what}` : ''}${sub ? `/${sub}` : ''}`,
  what,
  ...(sub ? { sub } : {}),
  keys,
});
