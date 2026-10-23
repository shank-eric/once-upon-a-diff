/*
 * The files the bridge serves without a token: the local page's scripts and
 * CSS, and the panel's modules, stylesheets and shared helpers from the shared
 * package (@once-upon-a-diff/shared). TypeScript modules go out as
 * JavaScript, their types stripped the way Node strips the bridge's own, so
 * the browser runs the same lines with no build step.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
/** The shared package's sources (src/), wherever the workspace links it from. */
const SHARED = path.dirname(fileURLToPath(import.meta.resolve('@once-upon-a-diff/shared/overlay')));
const SCRIPT = 'text/javascript; charset=utf-8';
const STYLESHEET = 'text/css; charset=utf-8';
/** The panel's modules and stylesheets and the shared helpers, served from the shared package's src/<folder>/ for the local page. */
const SHARED_MODULE = /^\/assets\/(panel|util)\/([a-z0-9-]+\.(?:ts|css))$/;
/** The local page's own modules and stylesheets, from public/local/. */
const LOCAL_MODULE = /^\/assets\/local\/([a-z0-9-]+\.(?:js|ts|css))$/;

const ASSETS = {
  '/assets/overlay.ts': path.join(SHARED, 'overlay.ts'),
  '/assets/local.js': path.join(PUBLIC, 'local.js'),
  '/assets/split.js': path.join(PUBLIC, 'split.js'),
  '/assets/narrow.js': path.join(PUBLIC, 'narrow.js'),
  '/assets/syntax.js': path.join(PUBLIC, 'syntax.js'),
  '/assets/highlight.mjs': path.join(PUBLIC, 'vendor/highlight.mjs'),
  '/assets/local.css': path.join(PUBLIC, 'local.css'),
};

/** Each stripped module and the mtime of the file it came from, so an edit shows on the next load. */
const stripped = new Map();

/**
 * A TypeScript module as the browser runs it. node:module's stripTypeScriptTypes is the stripping Node runs the
 * bridge with, but as an API it's still marked experimental, so its one warning is kept out of the bridge's log.
 */
function strippedModule(file) {
  const mtime = statSync(file).mtimeMs;
  const cached = stripped.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.code;
  }
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  let code;
  try {
    code = stripTypeScriptTypes(readFileSync(file, 'utf8'));
  } finally {
    process.emitWarning = emitWarning;
  }
  stripped.set(file, { mtime, code });
  return code;
}

/** [contents, content type] for one of the files. */
function served(file) {
  if (file.endsWith('.css')) {
    return [readFileSync(file), STYLESHEET];
  }
  return [file.endsWith('.ts') ? strippedModule(file) : readFileSync(file), SCRIPT];
}

/** [contents, content type] for an asset path, or null when it isn't one. Throws 404 for a missing shared module. */
export function assetFor(pathname) {
  if (ASSETS[pathname]) {
    return served(ASSETS[pathname]);
  }
  const sharedModule = SHARED_MODULE.exec(pathname);
  const localModule = LOCAL_MODULE.exec(pathname);
  if (!sharedModule && !localModule) {
    return null;
  }
  const file = sharedModule
    ? path.join(SHARED, sharedModule[1], sharedModule[2])
    : path.join(PUBLIC, 'local', localModule[1]);
  if (!existsSync(file)) {
    throw new HttpError(404, 'no such module');
  }
  return served(file);
}
