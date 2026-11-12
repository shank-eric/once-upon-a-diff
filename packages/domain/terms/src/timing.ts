/** How long the story page and the bridge wait before they count something (milliseconds); every package that times it imports these. */

/** A chapter the reviewer stayed on this long, with the tab showing, counts as read. */
export const READ_MS = 30000;
/** A hidden tab's page is still open: the panel and the local page say so this often. */
export const STILL_OPEN_MS = 60000;
/** The bridge writes a story's seen.json, and the extension's seen mark, at most this often. */
export const SEEN_WRITE_MS = 30000;
