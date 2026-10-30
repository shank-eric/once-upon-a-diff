/*
 * A DOM for testing the board's Preact components with no browser: linkedom's document as the globals Preact and the
 * component read, and a resolver so a page module's `/assets/...` imports (which the bridge serves) load from the files
 * they come from. Import it first, then import the component.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../../protocol/src/', import.meta.url));
const SHARED_UTIL = fileURLToPath(new URL('../../shared/src/util/', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '/assets/preact.mjs') {
      return {
        url: pathToFileURL(path.join(PUBLIC, 'vendor/preact.mjs')).href,
        shortCircuit: true,
      };
    }
    const util = /^\/assets\/util\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (util) {
      return { url: pathToFileURL(path.join(SHARED_UTIL, util[1])).href, shortCircuit: true };
    }
    const protocol = /^\/assets\/protocol\/([a-z0-9/-]+\.ts)$/.exec(specifier);
    if (protocol) {
      return { url: pathToFileURL(path.join(PROTOCOL, protocol[1])).href, shortCircuit: true };
    }
    const board = /^\/assets\/board\/([a-z0-9/-]+\.ts)$/.exec(specifier);
    if (board) {
      return { url: pathToFileURL(path.join(PUBLIC, 'board', board[1])).href, shortCircuit: true };
    }
    const local = /^\/assets\/local\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (local) {
      return { url: pathToFileURL(path.join(PUBLIC, 'local', local[1])).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="ou-board-app"></div></body></html>',
);
const root = document.getElementById('ou-board-app') as unknown as HTMLElement;
export { root };

// browsers have an on<event> property for each of these, and Preact picks its event names from them
for (const name of [
  'click',
  'keydown',
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'scroll',
]) {
  Object.defineProperty(window.HTMLElement.prototype, `on${name}`, {
    value: null,
    writable: true,
    configurable: true,
  });
}
// linkedom has no layout: the panel is as wide as its --ou-voice-width says, else 340
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const width = Number.parseInt(root.style.getPropertyValue('--ou-voice-width')) || 340;
  return { width } as DOMRect;
};
window.HTMLElement.prototype.setPointerCapture = function () {};

const storage = new Map<string, string>();
Object.assign(globalThis, {
  window,
  document,
  innerWidth: 1000,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  },
});
(window as unknown as { innerWidth: number }).innerWidth = 1000;

export const saved = storage;
/** Lets Preact's debounced re-render and any awaited calls run. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** An event as a browser would send it, with the fields the handlers read. */
export function fire(target: Element, type: string, fields: Record<string, unknown> = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, ...fields });
  target.dispatchEvent(event);
  return event;
}
