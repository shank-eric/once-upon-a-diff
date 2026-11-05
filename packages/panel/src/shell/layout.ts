/*
 * The panel's size across stories: its width and its questions dock's height,
 * the last ones dragged on any page (opts.onLayout). The bridge keeps them in
 * prefs.json (`layout`, GET and POST /api/prefs), so the GitHub page and the
 * local page share them. A story's own saved state keeps its step and folds;
 * the layout is laid over its sizes.
 */
import type { InitialUi } from '../state/panel-state.ts';

/** The panel's sizes kept across stories, in pixels. */
export interface Layout {
  width?: number;
  chatHeight?: number;
}

const size = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A story's saved state with the layout's sizes over it (a layout of null leaves it as it is). */
export function withLayout(saved: InitialUi, layout: Layout | null | undefined): InitialUi {
  return {
    ...saved,
    ...(size(layout?.width) && { width: layout.width }),
    ...(size(layout?.chatHeight) && { chatHeight: layout.chatHeight }),
  };
}

const MIN_DOCK_HEIGHT = 120;
const MAX_DOCK_SHARE = 0.8; // of the panel's height

/**
 * The height to show the questions dock at: height, kept within the panel. A panel with no height yet (not laid
 * out) has nothing to keep it within, so only the minimum applies.
 */
export function dockHeightWithin(height: number, panelHeight: number): number {
  const max = panelHeight > 0 ? Math.max(MIN_DOCK_HEIGHT, panelHeight * MAX_DOCK_SHARE) : Infinity;
  return Math.round(Math.min(Math.max(height, MIN_DOCK_HEIGHT), max));
}
