/*
 * What a test that mounts the panel needs: the test kit's linkedom document as the globals the panel reads, the browser
 * pieces linkedom lacks (location, scrolling, MutationObserver), a frozen clock so every time text is the same, and the
 * resolver for the one specifier the panel spells as the pages do, /assets/preact.mjs (preact.ts). Import it first, then import the panel.
 */
import './preact.ts';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

export const NOW = Date.parse('2026-11-03T12:00:00Z');
Date.now = () => NOW;

export const dom = installDom({
  html: '<!doctype html><html><head></head><body><div id="app"></div></body></html>',
  rootId: 'app',
});
const { window } = dom;

class NoObserver {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, {
  location: Object.assign(new URL('https://github.com/acme/widgets/pull/7/changes'), {
    replace() {},
  }),
  MutationObserver: NoObserver,
});
Object.assign(window, { scrollTo() {}, scrollY: 0, innerHeight: 800 });
