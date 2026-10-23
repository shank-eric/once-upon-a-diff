/*
 * The content script on github.com. WXT bundles it with everything it
 * imports; the router and the pages are in ../content/.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentScript } from '../content/index.ts';

export default defineContentScript({
  matches: ['https://github.com/*'],
  runAt: 'document_idle',
  main: startContentScript,
});
