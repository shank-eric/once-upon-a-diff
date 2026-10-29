/**
 * What public/vendor/preact.mjs exports, for scripts/vendor-preact.ts to bundle: Preact's rendering and the hooks the
 * board's components use, and htm's tagged templates bound to Preact's h, so markup is written as html`<div>...</div>`
 * with no JSX and no build step on the bridge. Add a name here (and to public/types/preact.d.ts) when a component needs one.
 */
import { h } from 'preact';
import htm from 'htm';

export { h, render, Component, Fragment } from 'preact';
export { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
// htm's types describe its default export as the module under nodenext resolution, but it is the function (the bundler agrees)
export const html = (htm as unknown as { bind: (this: unknown, h: unknown) => unknown }).bind(h);
