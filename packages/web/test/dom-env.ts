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
  'dragstart',
  'dragover',
  'dragend',
  'dragleave',
  'drop',
  'submit',
]) {
  Object.defineProperty(window.HTMLElement.prototype, `on${name}`, {
    value: null,
    writable: true,
    configurable: true,
  });
}
// linkedom has no layout: the panel is as wide as its --ou-voice-width says, else 340
// and a list's items are 100 tall, one under the other
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const width = Number.parseInt(root.style.getPropertyValue('--ou-voice-width')) || 340;
  const top = this.parentElement ? [...this.parentElement.children].indexOf(this) * 100 : 0;
  return { width, top, height: 100 } as DOMRect;
};
// browsers take an undefined reference node as null, which Preact relies on; linkedom reads its nodeType
for (const type of [window.Element, window.DocumentFragment]) {
  const insertBefore = type.prototype.insertBefore;
  type.prototype.insertBefore = function <T extends Node>(node: T, before?: Node | null): T {
    return insertBefore.call(this, node, before ?? null) as T;
  };
}
window.HTMLElement.prototype.setPointerCapture = function () {};

// linkedom calls a listener with `this` set to the event's target, where a browser sets it to the element the listener is on
// (Preact's handlers read `this`, so a click on a button would also run the button's handler again at each ancestor)
{
  const proto = Object.getPrototypeOf(window.Node.prototype);
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const wrapped = new WeakMap<object, EventListener>();
  proto.addEventListener = function (type: string, listener: unknown, options: unknown) {
    if (typeof listener !== 'function') {
      return add.call(this, type, listener, options);
    }
    if (!wrapped.has(listener)) {
      wrapped.set(listener, (event: Event) => listener.call(event.currentTarget, event));
    }
    return add.call(this, type, wrapped.get(listener), options);
  };
  proto.removeEventListener = function (type: string, listener: unknown, options: unknown) {
    return remove.call(
      this,
      type,
      (listener && wrapped.get(listener as object)) || listener,
      options,
    );
  };
}

// linkedom has no focus: this tracks it the way a browser does for what the board relies on. focus() takes it, blur() gives
// it up, and moving the focused node in the tree (a keyed reorder) or removing it drops it, as a browser would.
let focused: Element | null = null;
Object.defineProperty(document, 'activeElement', {
  get: () => (focused && document.contains(focused) ? focused : document.body),
  configurable: true,
});
window.HTMLElement.prototype.focus = function (this: HTMLElement) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  focused = this;
};
window.HTMLElement.prototype.blur = function () {
  if (focused === this) {
    focused = null;
  }
};
for (const type of [window.Element, window.DocumentFragment]) {
  const insertBefore = type.prototype.insertBefore;
  type.prototype.insertBefore = function <T extends Node>(node: T, before?: Node | null): T {
    if (node === (focused as unknown as Node)) {
      focused = null;
    }
    return insertBefore.call(this, node, before ?? null) as T;
  };
}

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
