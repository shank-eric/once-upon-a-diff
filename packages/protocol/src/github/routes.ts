/*
 * The extension tells the bridge what it saw on a GitHub page. Nothing here runs valibot: a body's type comes from
 * the schemas by `import type`, which is erased.
 */
import { api, type In } from '../route-kit.ts';
import type { GithubRefreshAnswer } from './types.ts';

export const GITHUB_ROUTES = {
  githubRefresh: api<In<'githubRefresh'>, GithubRefreshAnswer>(
    'POST',
    '/api/github/refresh',
    'token',
  ),
} as const;
