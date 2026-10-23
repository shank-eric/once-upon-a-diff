/*
 * The extension's build: WXT (Vite) bundles src/entrypoints into
 * .output/chrome-mv3, the folder Chrome loads unpacked. `yarn dev` rebuilds it
 * on every change and reloads the extension, `yarn build` builds it once, and
 * `yarn zip` builds the store copy (no `key`) into .output/store.
 */
import path from 'node:path';
import { defineConfig } from 'wxt';

/**
 * The public half of the extension's signing key (the private half is kept out of git). It fixes the extension's
 * ID at faaibhigocihefldbmdgchcnnclalkmo wherever the folder is loaded from, so chrome.storage (the bridge port and
 * token) survives a reload or a move.
 */
const KEY =
  // eslint-disable-next-line max-len -- one base64 string
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxrQdR/Nz2MWrHd3jU4mZp5hyrm/WU1nW4OPuumezJ5RM6OPfwGfriZsHnvTf3NCOWlfKcqMtZA+uG1rXkfDTPEPejyHbjztvvqtXsbYDStUy5T/GePu82QZOPh9HchI4mGCohf+0p09i899a5B/HSzBneWrC4h0tXILvYhh9K8NDAO2ndur4yYL8eUJWbk/M3E8/TUR5m8N6ljrZd2Q+iYhylCn1zwNq3oO/LQUdYSBor8W8wftzzgknE/jo8UcOFriol6uAVDdwk06yr9z8Vzm1c+DkUb0cvmutppIDZje+fCbjFuPVL9T9YelceXBzuZRalOVzqD05tFHQ/QX4tQIDAQAB';
/** The Chrome Web Store signs with its own key and refuses a manifest that has one. */
const STORE = !!process.env.ONCE_UPON_STORE;

/**
 * Stylesheets the content scripts link into their shadow roots (and the page's head), copied as is to the same
 * paths in the output: they're web-accessible, so github.com can load them from the extension.
 */
const LINKED_CSS = {
  'panel/page.css': '../shared/src/panel/page.css',
  'panel/panel.css': '../shared/src/panel/panel.css',
  'content/ui/story-tag.css': 'src/content/ui/story-tag.css',
  'content/ui/listen-notice.css': 'src/content/ui/listen-notice.css',
  'content/ui/toast.css': 'src/content/ui/toast.css',
};

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: STORE ? '.output/store' : '.output',
  // one folder for `yarn dev` and `yarn build`, so Chrome loads the same one either way
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}',
  imports: false,
  // you load .output/chrome-mv3 in your own Chrome; `yarn dev` only rebuilds it and reloads the extension
  webExt: { disabled: true },
  dev: { server: { port: 4830 } }, // the usual 3000 is often taken
  manifest: {
    name: 'Once Upon a Diff',
    short_name: 'Once Upon',
    description:
      "Shows a code-review story (overview, then chapters) in a side panel on a GitHub pull request, with the diff filtered to each chapter's files",
    ...(STORE ? {} : { key: KEY }),
    action: { default_title: 'Show or hide the story panel' },
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1/*'],
    commands: {
      'toggle-panel': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Show or hide the story panel',
      },
    },
    icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    web_accessible_resources: [
      { resources: Object.keys(LINKED_CSS), matches: ['https://github.com/*'] },
    ],
  },
  hooks: {
    'build:publicAssets': (wxt, files) => {
      for (const [dest, src] of Object.entries(LINKED_CSS)) {
        files.push({ absoluteSrc: path.resolve(wxt.config.root, src), relativeDest: dest });
      }
    },
  },
});
