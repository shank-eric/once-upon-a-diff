/*
 * What a test of the content script's components needs: the test kit's linkedom document as the globals they read, the vendored
 * Preact under the one specifier the components spell, /assets/preact.mjs, and a stand-in for chrome.runtime (the CSS urls and the
 * service worker the bridge calls go through). Import it first, then import the component.
 */
import { fileURLToPath } from 'node:url';
import { registerPreact } from '@once-upon-a-diff/test-kit/preact';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

registerPreact(fileURLToPath(new URL('../../web/public/vendor/preact.mjs', import.meta.url)));

export const { window, document, tick, fire } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});

/** What the service worker is asked, and what it answers (set `answer` before the click that asks). */
export const worker: { sent: unknown[]; answer: (message: { path: string }) => unknown } = {
  sent: [],
  answer: () => ({ ok: false, status: 0, error: 'no answer' }),
};

Object.assign(globalThis, {
  chrome: {
    runtime: {
      id: 'test-extension',
      getURL: (file: string) => `chrome-extension://test/${file}`,
      sendMessage: async (message: { path: string }) => {
        worker.sent.push(message);
        return worker.answer(message);
      },
    },
  },
});
