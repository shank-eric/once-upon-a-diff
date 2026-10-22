// Globals the panel and the local page hang on window, for type checks only.
interface Window {
  /** The panel on this page (overlay.js), so a newer panel replaces it. */
  __prStoryOverlay?: { destroy(): void; [key: string]: unknown };
  /** The local page's story and panel, for its browser test. */
  __prStoryLocal?: { readonly story: unknown; readonly overlay: unknown };
}
