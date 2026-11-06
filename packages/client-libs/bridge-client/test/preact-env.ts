/*
 * What a test of the Preact hook needs: the test kit's linkedom document as the globals Preact reads, and a resolver for the
 * one specifier the hook spells as the pages do, /assets/preact.mjs, which the bridge serves from the web package's vendored
 * build. Import it first, then import the hook.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

const PREACT = fileURLToPath(
  new URL('../../../client/web/public/vendor/preact.mjs', import.meta.url),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '/assets/preact.mjs') {
      return { url: pathToFileURL(PREACT).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const { window, document, root, tick } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
