/*
 * What a test of a Preact component needs: the test kit's linkedom document as the globals Preact reads, and a resolver for the one
 * specifier the components spell as the pages do, /assets/preact.mjs, which the bridge serves from the web package's vendored build
 * (see the test kit's registerPreact). Import it first, then import the component.
 */
import { fileURLToPath } from 'node:url';
import { registerPreact } from '@once-upon-a-diff/test-kit/preact';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

registerPreact(fileURLToPath(new URL('../../web/public/vendor/preact.mjs', import.meta.url)));

export const { window, document, root, tick, fire } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
