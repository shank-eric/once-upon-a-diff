/*
 * What the content script's router tells every page. Types only, so the pages can name it without importing the router.
 */
import type { PageKind } from '@once-upon-a-diff/github-page/pages';

/**
 * Why the router looks: 'tick' (the URL watch, while the tab shows), 'event' (a navigation event) or 'back' (the tab
 * got focus or showed again).
 */
export type RouteReason = 'tick' | 'event' | 'back';

/** What the router tells every page; navigated: the URL changed since the last look. */
export interface Route {
  kind: PageKind;
  navigated: boolean;
  reason: RouteReason;
}
