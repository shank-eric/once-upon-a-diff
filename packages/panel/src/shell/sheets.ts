/*
 * The panel's region stylesheets: each region folder's own look (panel/src/<region>/<region>.css), which the shell links into the shadow
 * root after css/panel.css (the base: the frame, the status light, the shared vocabulary). A host (the extension, the local page)
 * serves each at its path here, so this list is the one place that says which sheets there are and in what order they link: it is the
 * cascade order the split from the one panel.css kept.
 */
export const REGION_SHEETS = [
  'ask/ask.css',
  'drafts/drafts.css',
  'fixes/fixes.css',
  'rebuild/rebuild.css',
  'reading/reading.css',
] as const;
