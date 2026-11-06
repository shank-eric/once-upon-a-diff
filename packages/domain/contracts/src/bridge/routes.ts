/*
 * The bridge-wide calls (health, status, page settings, the story list, builds, usage counts), token only. Nothing
 * here runs valibot: a body's type comes from the schemas by `import type`, which is erased.
 */
import { api, type In } from '../route-kit.ts';
import type { UsageAnswer } from '@once-upon-a-diff/terms/usage-actions';
import type {
  BridgeStatus,
  BuildRequestView,
  Health,
  Prefs,
  StatusMany,
  StoryList,
} from './types.ts';

export const BRIDGE_ROUTES = {
  health: api<undefined, Health>('GET', '/api/health', 'token'),
  status: api<undefined, BridgeStatus, { story?: string; repo?: string }>(
    'GET',
    '/api/status',
    'token',
  ),
  prefsRead: api<undefined, Prefs>('GET', '/api/prefs', 'token'),
  prefsWrite: api<In<'prefs'>, Prefs>('POST', '/api/prefs', 'token'),
  stories: api<undefined, StoryList>('GET', '/api/stories', 'token'),
  statusMany: api<In<'statusMany'>, StatusMany>('POST', '/api/stories/status-many', 'token'),
  buildRequest: api<In<'buildRequest'>, { state: string; request: BuildRequestView }>(
    'POST',
    '/api/builds',
    'token',
  ),
  // a page's batch of UI action counts (domain/usage-actions.ts); the board's key and the extension's token reach it
  usageCount: api<In<'usage'>, UsageAnswer>('POST', '/api/usage', 'token+board'),
} as const;
