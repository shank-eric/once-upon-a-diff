/*
 * The files the bridge serves without a token: the local page's scripts,
 * CSS and icon, the panel's modules, stylesheets and shared helpers from the shared
 * package (@once-upon-a-diff/shared), and the route table and client from the protocol
 * package. TypeScript modules go out as JavaScript, their types stripped the way Node
 * strips the bridge's own, so the browser runs the same lines with no build step.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
/** The shared package's sources (src/), wherever the workspace links it from. */
const SHARED = path.dirname(fileURLToPath(import.meta.resolve('@once-upon-a-diff/shared/overlay')));
/** The protocol package's sources (src/). */
const PROTOCOL = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/protocol/routes')),
);
const SCRIPT = 'text/javascript; charset=utf-8';
const STYLESHEET = 'text/css; charset=utf-8';
const PNG = 'image/png';
/** The panel's modules and stylesheets and the shared helpers, served from the shared package's src/<folder>/ for the local page. */
const SHARED_MODULE = /^\/assets\/(panel|util)\/([a-z0-9-]+\.(?:ts|css))$/;
/**
 * The protocol's modules a page may load: the route table, the typed client and the domain's id patterns. Not schemas.ts, which
 * imports valibot (the bridge checks bodies, the pages don't) and has nothing for a page to run.
 */
const PROTOCOL_MODULE = /^\/assets\/protocol\/(routes|client|domain\/patterns)\.ts$/;
/** The local page's own modules and stylesheets, from public/local/. */
const LOCAL_MODULE = /^\/assets\/local\/([a-z0-9-]+\.(?:ts|css))$/;

const ASSETS: Record<string, string> = {
  '/assets/overlay.ts': path.join(SHARED, 'overlay.ts'),
  '/assets/local.ts': path.join(PUBLIC, 'local.ts'),
  '/assets/board.ts': path.join(PUBLIC, 'board.ts'),
  '/assets/split.ts': path.join(PUBLIC, 'split.ts'),
  '/assets/narrow.ts': path.join(PUBLIC, 'narrow.ts'),
  '/assets/syntax.ts': path.join(PUBLIC, 'syntax.ts'),
  '/assets/highlight.mjs': path.join(PUBLIC, 'vendor/highlight.mjs'),
  '/assets/preact.mjs': path.join(PUBLIC, 'vendor/preact.mjs'),
  '/assets/local.css': path.join(PUBLIC, 'local.css'),
  // the extension's icon (a blue tile that reads on light and dark tabs); /favicon.ico is what a browser asks for with no <link>
  '/assets/icon.png': path.join(PUBLIC, 'icon.png'),
  '/favicon.ico': path.join(PUBLIC, 'icon.png'),
};

/** Each stripped module and the mtime of the file it came from, so an edit shows on the next load. */
const stripped = new Map<string, { mtime: number; code: string }>();

/**
 * A TypeScript module as the browser runs it. node:module's stripTypeScriptTypes is the stripping Node runs the
 * bridge with, but as an API it's still marked experimental, so its one warning is kept out of the bridge's log.
 */
function strippedModule(file: string): string {
  const mtime = statSync(file).mtimeMs;
  const cached = stripped.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.code;
  }
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  let code: string;
  try {
    code = stripTypeScriptTypes(readFileSync(file, 'utf8'));
  } finally {
    process.emitWarning = emitWarning;
  }
  stripped.set(file, { mtime, code });
  return code;
}

/** [contents, content type] for one of the files. */
function served(file: string): [string | Buffer, string] {
  if (file.endsWith('.png')) {
    return [readFileSync(file), PNG];
  }
  if (file.endsWith('.css')) {
    return [readFileSync(file), STYLESHEET];
  }
  return [file.endsWith('.ts') ? strippedModule(file) : readFileSync(file), SCRIPT];
}

/** [contents, content type] for an asset path, or null when it isn't one. Throws 404 for a missing shared module. */
export function assetFor(pathname: string): [string | Buffer, string] | null {
  if (ASSETS[pathname]) {
    return served(ASSETS[pathname]);
  }
  const sharedModule = SHARED_MODULE.exec(pathname);
  const localModule = LOCAL_MODULE.exec(pathname);
  const protocolModule = PROTOCOL_MODULE.exec(pathname);
  if (!sharedModule && !localModule && !protocolModule) {
    return null;
  }
  let file: string;
  if (sharedModule) {
    file = path.join(SHARED, sharedModule[1], sharedModule[2]);
  } else if (protocolModule) {
    file = path.join(PROTOCOL, `${protocolModule[1]}.ts`);
  } else {
    file = path.join(PUBLIC, 'local', (localModule as RegExpExecArray)[1]);
  }
  if (!existsSync(file)) {
    throw new HttpError(404, 'no such module');
  }
  return served(file);
}
