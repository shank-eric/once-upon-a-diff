// Types for highlight.mjs beside it (made by scripts/vendor-hljs.ts), for code that imports the file itself: the
// bridge's tests. The local page imports it as /assets/highlight.mjs, typed by ../types/highlight.d.ts.
import type { Highlighter } from '../syntax.ts';

declare const hljs: Highlighter;
export default hljs;
