/*
 * The files the bridge serves without a token: the local page's scripts and
 * CSS, and the panel's modules and shared helpers from src/js/shared/.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const SHARED = path.resolve(HERE, '../../src/js/shared');
const SCRIPT = 'text/javascript; charset=utf-8';
/** The panel's modules and the shared helpers, served from src/js/shared/<folder>/ for the local page. */
const SHARED_MODULE = /^\/assets\/(panel|util)\/([a-z0-9-]+\.js)$/;

const ASSETS = {
  '/assets/overlay.js': [path.join(SHARED, 'overlay.js'), SCRIPT],
  '/assets/local.js': [path.join(PUBLIC, 'local.js'), SCRIPT],
  '/assets/split.js': [path.join(PUBLIC, 'split.js'), SCRIPT],
  '/assets/narrow.js': [path.join(PUBLIC, 'narrow.js'), SCRIPT],
  '/assets/syntax.js': [path.join(PUBLIC, 'syntax.js'), SCRIPT],
  '/assets/highlight.mjs': [path.join(PUBLIC, 'vendor/highlight.mjs'), SCRIPT],
  '/assets/local.css': [path.join(PUBLIC, 'local.css'), 'text/css; charset=utf-8'],
};

/** [contents, content type] for an asset path, or null when it isn't one. Throws 404 for a missing shared module. */
export function assetFor(pathname) {
  if (ASSETS[pathname]) {
    const [file, type] = ASSETS[pathname];
    return [readFileSync(file), type];
  }
  const sharedModule = SHARED_MODULE.exec(pathname);
  if (!sharedModule) {
    return null;
  }
  const file = path.join(SHARED, sharedModule[1], sharedModule[2]);
  if (!existsSync(file)) {
    throw new HttpError(404, 'no such module');
  }
  return [readFileSync(file), SCRIPT];
}
