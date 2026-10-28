/*
 * The panel's size across stories: its width and its questions dock's height,
 * the last ones dragged on any page (opts.onLayout). The bridge keeps them in
 * prefs.json (`layout`, GET and POST /api/prefs), so the GitHub page and the
 * local page share them. A story's own saved state keeps its step and folds;
 * the layout is laid over its sizes.
 */
import type { InitialUi } from './panel-state.ts';

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
