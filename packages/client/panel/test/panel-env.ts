/*
 * What a test that mounts the panel needs: the test kit's linkedom document as the globals the panel reads, the browser
 * pieces linkedom lacks (location, scrolling, MutationObserver), a frozen clock so every time text is the same, and the
 * resolver for the one specifier the panel spells as the pages do, /assets/preact.mjs (preact.ts). Import it first, then import the panel.
 */
import './preact.ts';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

export const NOW = Date.parse('2026-11-03T12:00:00Z');
/** The panel's clock: frozen at NOW until a test moves it. */
export const clock = { now: NOW };
Date.now = () => clock.now;

export const dom = installDom({
  html: '<!doctype html><html><head></head><body><div id="app"></div></body></html>',
  rootId: 'app',
});
const { window } = dom;

class NoObserver {
  observe() {}
  disconnect() {}
}
/** An IntersectionObserver a test fires by hand: `observers` are the live ones, each with what it watches. */
export class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  targets = new Set<Element>();
  callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
  options?: IntersectionObserverInit;
  constructor(
    callback: (entries: Partial<IntersectionObserverEntry>[]) => void,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeIntersectionObserver.all = FakeIntersectionObserver.all.filter((one) => one !== this);
  }
}
Object.assign(globalThis, {
  IntersectionObserver: FakeIntersectionObserver,
  Element: window.Element,
  location: Object.assign(new URL('https://github.com/acme/widgets/pull/7/changes'), {
    replace() {},
  }),
  MutationObserver: NoObserver,
});
Object.assign(window, { scrollTo() {}, scrollY: 0, innerHeight: 800 });

/** The clipboard, the selection and execCommand, which linkedom lacks: `mode` says whether the clipboard takes a write. */
export const clipboardEnv = {
  mode: 'ok' as 'ok' | 'refused' | 'none',
  exec: true,
  written: [] as string[],
  /** a write waits for this to settle, when a test sets it */
  gate: null as Promise<void> | null,
  selected: [] as Node[],
  execCalls: 0,
};
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  get: () =>
    clipboardEnv.mode === 'none'
      ? undefined
      : {
          async writeText(text: string) {
            clipboardEnv.written.push(text);
            await clipboardEnv.gate;
            if (clipboardEnv.mode === 'refused') {
              throw new Error('not allowed');
            }
          },
        },
});
const selectionStub = {
  removeAllRanges() {},
  addRange(range: { node?: Node }) {
    if (range.node) {
      clipboardEnv.selected.push(range.node);
    }
  },
};
Object.assign(window, { getSelection: () => selectionStub });
Object.assign(globalThis.document, {
  createRange: () => ({
    node: undefined as Node | undefined,
    selectNodeContents(node: Node) {
      this.node = node;
    },
  }),
  execCommand: () => {
    clipboardEnv.execCalls++;
    return clipboardEnv.exec;
  },
});
