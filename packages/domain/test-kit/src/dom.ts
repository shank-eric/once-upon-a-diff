/*
 * A DOM for testing browser code with no browser: linkedom's document as the globals a component reads, with the pieces
 * linkedom lacks filled in (on<event> properties, a listener's `this`, focus, layout numbers, localStorage). Call
 * installDom once, before importing the code under test. Each test file is its own process, so one call per file; a second call throws.
 */
import { parseHTML } from 'linkedom';
import { assertNoLiveTimers } from './timers.ts';

// browsers have an on<event> property for each of these, and Preact picks its event names from them
const EVENT_PROPERTIES = [
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
  'toggle',
  'input',
  'change',
  'focus',
  'blur',
  'keyup',
  'close',
];

export interface DomOptions {
  /** The page's HTML. */
  html: string;
  /** The id of the element the code under test renders into: `root` in the answer. */
  rootId: string;
  /** What getBoundingClientRect answers for `element` (linkedom has no layout). The default is 340 wide, and a list's items 100 tall, one under the other. */
  rect?: (element: HTMLElement, root: HTMLElement) => Partial<DOMRect>;
}

let installed = false;

/** Installs the DOM as the globals and answers with it. It patches linkedom's prototypes and the globals, so it refuses a second call in one process. */
export function installDom({ html, rootId, rect }: DomOptions) {
  if (installed) {
    throw new Error(
      'installDom was already called in this process: call it once, in the file that owns the DOM',
    );
  }
  installed = true;
  // a test file with a DOM runs pages and panels that poll and tick: one that is not torn down fails the file here
  assertNoLiveTimers();
  const { window, document } = parseHTML(html);
  const root = document.getElementById(rootId) as unknown as HTMLElement;
  // an `el.onclick = fn` assignment runs fn on that event, as in a browser (Preact never assigns these: it adds listeners, and
  // picks the lower-case event name only when `on<name>` exists on the element)
  for (const name of EVENT_PROPERTIES) {
    const handlers = new WeakMap<object, { handler: unknown; listener: EventListener }>();
    Object.defineProperty(window.HTMLElement.prototype, `on${name}`, {
      get(this: HTMLElement) {
        return handlers.get(this)?.handler ?? null;
      },
      set(this: HTMLElement, handler: unknown) {
        const previous = handlers.get(this);
        if (previous) {
          this.removeEventListener(name, previous.listener);
          handlers.delete(this);
        }
        if (typeof handler === 'function') {
          const listener = (event: Event) => handler.call(this, event);
          handlers.set(this, { handler, listener });
          this.addEventListener(name, listener);
        }
      },
      configurable: true,
    });
  }
  // linkedom has no requestSubmit: a submit event, which is what the form's listeners wait for
  (window.HTMLElement.prototype as unknown as { requestSubmit: () => void }).requestSubmit =
    function (this: HTMLElement) {
      this.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    };
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (rect) {
      return rect(this, root) as DOMRect;
    }
    const top = this.parentElement ? [...this.parentElement.children].indexOf(this) * 100 : 0;
    return { width: 340, top, height: 100 } as DOMRect;
  };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  // linkedom's <dialog> has no showModal: it marks the dialog open and remembers what had focus, and close() shuts it, gives that
  // element its focus back if it is still on the page, and says `close`, as a browser does
  const opener = new WeakMap<object, HTMLElement>();
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) {
      opener.set(this, document.activeElement as HTMLElement);
      this.setAttribute('open', '');
    },
    show(this: HTMLElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLElement) {
      if (this.hasAttribute('open')) {
        this.removeAttribute('open');
        const before = opener.get(this);
        if (before && document.contains(before)) {
          before.focus();
        }
        this.dispatchEvent(new window.Event('close'));
      }
    },
  });

  // linkedom has no focus: this tracks it the way a browser does for what the pages rely on. focus() takes it, blur() gives
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
  // browsers take an undefined reference node as null, which Preact relies on; linkedom reads its nodeType
  for (const type of [window.Element, window.DocumentFragment]) {
    const insertBefore = type.prototype.insertBefore;
    type.prototype.insertBefore = function <T extends Node>(node: T, before?: Node | null): T {
      if (node === (focused as unknown as Node)) {
        focused = null;
      }
      return insertBefore.call(this, node, before ?? null) as T;
    };
  }

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

  const saved = new Map<string, string>();
  Object.assign(globalThis, {
    window,
    document,
    innerWidth: 1000,
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    },
  });
  (window as unknown as { innerWidth: number }).innerWidth = 1000;

  /** Lets Preact's debounced re-render and any awaited calls run. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  /** An event as a browser would send it, with the fields the handlers read. */
  const fire = (target: Element, type: string, fields: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, ...fields });
    target.dispatchEvent(event);
    return event;
  };
  return { window, document, root, saved, tick, fire };
}
