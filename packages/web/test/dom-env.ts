/*
 * A DOM for testing the board's Preact components with no browser: the test kit's linkedom document as the globals Preact and
 * the component read, and a resolver so a page module's `/assets/...` imports (which the bridge serves) load from the files
 * they come from. Import it first, then import the component.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../../protocol/src/', import.meta.url));
const API_CLIENT = fileURLToPath(new URL('../../api-client/src/', import.meta.url));
const PANEL = fileURLToPath(new URL('../../panel/src/', import.meta.url));
const UI_DIR = fileURLToPath(new URL('../../ui/src/', import.meta.url));
const HOST_GITHUB = fileURLToPath(new URL('../../host-github/src/', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '/assets/preact.mjs') {
      return {
        url: pathToFileURL(path.join(PUBLIC, 'vendor/preact.mjs')).href,
        shortCircuit: true,
      };
    }
    const panel = /^\/assets\/panel\/([a-z0-9/-]+\.ts)$/.exec(specifier);
    if (panel) {
      return { url: pathToFileURL(path.join(PANEL, panel[1])).href, shortCircuit: true };
    }
    const shared = /^\/assets\/ui\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (shared) {
      return { url: pathToFileURL(path.join(UI_DIR, shared[1])).href, shortCircuit: true };
    }
    const host = /^\/assets\/host-github\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (host) {
      return { url: pathToFileURL(path.join(HOST_GITHUB, host[1])).href, shortCircuit: true };
    }
    const apiClient = /^\/assets\/api-client\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (apiClient) {
      return { url: pathToFileURL(path.join(API_CLIENT, apiClient[1])).href, shortCircuit: true };
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
    const asset = /^\/assets\/([a-z0-9-]+\.ts)$/.exec(specifier);
    if (asset) {
      return { url: pathToFileURL(path.join(PUBLIC, asset[1])).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const { window, document, root, saved, tick, fire } = installDom({
  html: '<!doctype html><html><body><div id="ou-board-app"></div></body></html>',
  rootId: 'ou-board-app',
  // linkedom has no layout: the panel is as wide as its --ou-voice-width says, else 340
  // and a list's items are 100 tall, one under the other
  rect: (element, board) => ({
    width: Number.parseInt(board.style.getPropertyValue('--ou-voice-width')) || 340,
    top: element.parentElement ? [...element.parentElement.children].indexOf(element) * 100 : 0,
    height: 100,
  }),
});
