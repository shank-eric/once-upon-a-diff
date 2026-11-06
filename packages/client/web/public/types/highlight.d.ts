// The vendored highlight.js build the bridge serves at /assets/highlight.mjs (public/vendor), for type checks only.
import type { Highlighter } from '../local/diff/syntax.ts';

declare const hljs: Highlighter;
export default hljs;
