/*
 * The typed way to call the bridge: build a route's path from its table entry (@once-upon-a-diff/protocol/routes) and hand the request to the
 * host's own transport, which knows how to reach the bridge and which key to send (the extension's service worker, a
 * page's fetch with its page key). This file does no I/O, so it has no DOM or Node in it and a page can load it.
 *
 * Two ways in:
 *  - `call` never throws. It resolves to {ok, status, body, error}, the shape the extension's content scripts already use.
 *  - `ask` resolves to the answer and throws a BridgeError (with the HTTP status) otherwise, the way the pages' `api` does.
 */
import type {
  AnswerOf,
  AnyRoute,
  BodyOf,
  ParamsOf,
  QueryOf,
} from '@once-upon-a-diff/protocol/routes';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { hasCode, replyCode } from '@once-upon-a-diff/protocol/domain/error-code';
import type { StatusError } from '@once-upon-a-diff/protocol/types';

/** What a host's transport is asked to send. `path` carries the query. A POST always has a body (`{}` when it has none). */
export interface CallRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** What a transport answers: status 0 when the call didn't get there, `body` the bridge's JSON. */
export type Reply<T = unknown> =
  | { ok: true; status: number; body: T; error?: null }
  | { ok: false; status: number; body?: unknown; error?: string | null };

/** How a host reaches the bridge. It should not throw: a call that fails says so in its Reply. */
export type Transport = (request: CallRequest) => Promise<Reply>;

/** A failed call that `ask` turns into an error: the bridge's message, the HTTP status (0 when it didn't get there) and the bridge's JSON (`replyCode` reads its `code`). */
export class BridgeError extends Error {
  declare status: number;
  declare body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * What a failed call says about the bridge, for the status light: 0 it didn't get there (`down`), 401 the token is wrong
 * (`token`), a route the bridge doesn't have (`old`, the bridge is older than the page). An older bridge sends no code,
 * so its plain 404 counts as a missing route too; anything else is `down`.
 */
export function bridgeProblem(reply: {
  status: number;
  body?: unknown;
}): NonNullable<StatusError['code']> {
  if (!reply.status) {
    return 'down';
  }
  const code = replyCode(reply);
  if (code === 'unauthorized') {
    return 'token';
  }
  if (code === 'no_route' || (code === 'not_found' && !hasCode(reply))) {
    return 'old';
  }
  return 'down';
}

/** The arguments a route needs: its params and body when it has them, and an optional query. */
export type Args<R extends AnyRoute> = (ParamsOf<R> extends undefined
  ? { params?: undefined }
  : { params: ParamsOf<R> }) &
  (BodyOf<R> extends undefined ? { body?: undefined } : { body: BodyOf<R> }) &
  (QueryOf<R> extends undefined ? { query?: undefined } : { query?: QueryOf<R> });

/** Whether a route needs no arguments at all, so the call can leave them out. */
type NoArgs<R extends AnyRoute> =
  ParamsOf<R> extends undefined ? (BodyOf<R> extends undefined ? true : false) : false;

type ArgList<R extends AnyRoute> = NoArgs<R> extends true ? [args?: Args<R>] : [args: Args<R>];

/** `?a=1&b=2` for the query's defined values, or ''. */
function queryString(query: object | undefined): string {
  const pairs = Object.entries(query || {})
    .filter((entry) => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/** A route's path with its params filled in (each encoded) and the query on. */
export function pathFor<R extends AnyRoute>(route: R, args: Partial<Args<R>> = {}): string {
  const params = (args.params || {}) as Record<string, string>;
  const path = route.path.replace(/:([a-z]+)/g, (_whole, name: string) => {
    if (params[name] === undefined) {
      throw new Error(`${route.method} ${route.path} needs ${name}`);
    }
    return encodeURIComponent(params[name]);
  });
  return path + queryString(args.query as object | undefined);
}

/** The patterns of the /api/ routes among `routes`: `:name` is one path segment. */
const patternsOf = (routes: readonly AnyRoute[]) =>
  routes
    .filter((route) => route.path.startsWith('/api/'))
    .map((route) => ({
      method: route.method,
      pattern: new RegExp(`^${route.path.replace(/:[a-z]+/g, '[A-Za-z0-9._~%-]+')}$`),
    }));
const API_ENTRIES = patternsOf(Object.values(ROUTES as Record<string, AnyRoute>));
/** What a query may hold: what encodeURIComponent writes, with = and & between. */
const QUERY_RE = /^[A-Za-z0-9._~%=&-]*$/;

/**
 * Whether a call is one the table has (or, with `routes`, one of those): an /api/ path of one of its routes, with that
 * route's method, and no dot segment in it, written plainly (`..`) or percent-encoded (`%2e`, any case), since fetch
 * and the bridge's URL parsing both fold those into another path. The extension's service worker asks this before it
 * sends the bridge's token with a request.
 */
export function matchRoute(
  method: string,
  pathWithQuery: string,
  routes?: readonly AnyRoute[],
): boolean {
  const cut = pathWithQuery.indexOf('?');
  const path = cut < 0 ? pathWithQuery : pathWithQuery.slice(0, cut);
  const query = cut < 0 ? '' : pathWithQuery.slice(cut + 1);
  const plain = path.replace(/%2e/gi, '.');
  if (plain.includes('..') || plain.split('/').includes('.') || !QUERY_RE.test(query)) {
    return false;
  }
  const entries = routes ? patternsOf(routes) : API_ENTRIES;
  return entries.some((entry) => entry.method === method && entry.pattern.test(path));
}

/** A client over one host's transport. */
export function createClient(transport: Transport) {
  const request = <R extends AnyRoute>(
    route: R,
    args: Partial<Args<R>> | undefined,
  ): CallRequest => ({
    method: route.method,
    path: pathFor(route, args),
    ...(route.method === 'POST' ? { body: args?.body ?? {} } : {}),
  });
  return {
    /** Calls a route. Never rejects. */
    async call<R extends AnyRoute>(route: R, ...rest: ArgList<R>): Promise<Reply<AnswerOf<R>>> {
      return (await transport(request(route, rest[0] as Partial<Args<R>> | undefined))) as Reply<
        AnswerOf<R>
      >;
    },
    /** Calls a route and returns the answer, or throws a BridgeError. */
    async ask<R extends AnyRoute>(route: R, ...rest: ArgList<R>): Promise<AnswerOf<R>> {
      const reply = await transport(request(route, rest[0] as Partial<Args<R>> | undefined));
      if (!reply.ok) {
        throw new BridgeError(reply.error || `HTTP ${reply.status}`, reply.status, reply.body);
      }
      return reply.body as AnswerOf<R>;
    },
  };
}

/** What createClient gives back. */
export type Client = ReturnType<typeof createClient>;
