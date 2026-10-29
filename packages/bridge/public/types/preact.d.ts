// The vendored Preact + htm build the bridge serves at /assets/preact.mjs (public/vendor), for type checks only. Types come
// from the preact package; keep the names in step with scripts/preact-entry.ts.
import type { VNode } from 'preact';

export { h, render, Component, Fragment } from 'preact';
export { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
/** htm's tagged template bound to Preact's h: html`<div class=${name} onClick=${fn}>${child}</div>`. Values are not type-checked. */
export const html: (strings: TemplateStringsArray, ...values: unknown[]) => VNode;
