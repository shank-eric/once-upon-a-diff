/*
 * The files the bridge serves without a token: the pages' scripts, CSS and icon (the web package,
 * @once-upon-a-diff/web), the panel's modules and stylesheets (@once-upon-a-diff/panel), the GitHub host
 * adapter (@once-upon-a-diff/github-page), the typed client and the poll from the api-client package, the shared UI_DIR pieces
 * (@once-upon-a-diff/ui-kit), the route table from the contracts package and the pure rules from the domain package.
 * TypeScript modules go out as JavaScript, their types stripped the way Node strips the bridge's own,
 * so the browser runs the same lines with no build step. The panel, the host adapter and the domain name
 * the packages they use by package, as Node and the extension's bundler resolve them, so a served module
 * has those specifiers rewritten to the /assets/ URLs the browser can load (see forBrowser).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request.ts';

/** The web package's pages (public/), wherever the workspace links it from. */
const PUBLIC = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/web/public/board.ts')),
);
/** The panel package's sources (src/), wherever the workspace links it from. */
const PANEL = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve('@once-upon-a-diff/panel/shell/overlay'))),
  '..',
);
/** The github-page package's sources (src/): the GitHub host adapter, which the local page injects into the panel. */
const GITHUB_PAGE = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/github-page/diff-dom')),
);
/** The contracts package's sources (src/). */
const CONTRACTS = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/contracts/routes')),
);
/** The domain package's sources (src/): pure rules that import nothing. */
const DOMAIN = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/domain/patterns')),
);
/** The api-client package's sources (src/). */
const API_CLIENT = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/api-client/client')),
);
/** The ui-kit package's sources (src/): the helpers and components the pages, the panel and the extension share. */
const UI_DIR = path.dirname(
  fileURLToPath(import.meta.resolve('@once-upon-a-diff/ui-kit/clipboard')),
);
const SCRIPT = 'text/javascript; charset=utf-8';
const STYLESHEET = 'text/css; charset=utf-8';
const PNG = 'image/png';
/** The panel's modules and stylesheets, from the panel package's src/ (in its folders), for the local page. */
const PANEL_MODULE = /^\/assets\/panel\/([a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:ts|css))$/;
/** The host adapter's modules, from the github-page package's src/. */
const GITHUB_PAGE_MODULE = /^\/assets\/github-page\/([a-z0-9-]+\.ts)$/;
/** The api-client's modules a page may load: the typed client, the poll and the Preact hook over it. */
const API_CLIENT_MODULE = /^\/assets\/api-client\/(client|poll|use-poll|usage)\.ts$/;
/** The ui-kit package's modules (its components/ folder too) and its stylesheet (css/ui.css), which a page may load (the panel reaches the modules by package, which forBrowser spells as these URLs). */
const UI_MODULE = /^\/assets\/ui-kit\/([a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:ts|css))$/;
/**
 * The contracts package's modules a page may load: the route table (routes.ts, the route-kit.ts it builds with and each area's
 * routes.ts). Not the schemas (schemas.ts, schema-kit.ts and each area's schemas.ts import valibot: the bridge checks
 * bodies, the pages don't) and not the types, which a page only imports as types, erased.
 */
const CONTRACTS_MODULE = /^\/assets\/contracts\/(routes|route-kit|[a-z0-9-]+\/routes)\.ts$/;
/** The domain package's modules, all of them (pure rules that import nothing), which a page may load. */
const DOMAIN_MODULE = /^\/assets\/domain\/([a-z0-9-]+)\.ts$/;
/** The board page's own modules (its regions' folders), from public/board/. */
const BOARD_MODULE = /^\/assets\/board\/([a-z0-9-]+(?:\/[a-z0-9-]+)*\.ts)$/;
/** The local page's own modules and stylesheet (the shell, and its diff/ and ship/ folders), from public/local/. */
const LOCAL_MODULE = /^\/assets\/local\/([a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:ts|css))$/;

const ASSETS: Record<string, string> = {
  '/assets/panel/shell/overlay.ts': path.join(PANEL, 'shell/overlay.ts'),
  '/assets/board.ts': path.join(PUBLIC, 'board.ts'),
  '/assets/highlight.mjs': path.join(PUBLIC, 'vendor/highlight.mjs'),
  '/assets/preact.mjs': path.join(PUBLIC, 'vendor/preact.mjs'),
  // the extension's icon (a blue tile that reads on light and dark tabs); /favicon.ico is what a browser asks for with no <link>
  '/assets/icon.png': path.join(PUBLIC, 'icon.png'),
  '/favicon.ico': path.join(PUBLIC, 'icon.png'),
};

/** Each stripped module and the mtime of the file it came from, so an edit shows on the next load. */
const stripped = new Map<string, { mtime: number; code: string }>();

/** The specifiers a served module may name by package, and the /assets/ URL each is loaded from (the package's name is the folder). */
const PACKAGE_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(?\s*)(['"])@once-upon-a-diff\/(panel|contracts|domain|github-page|api-client|ui-kit)\/([a-z0-9/-]+)\2/g;
/** A stripped module with its package specifiers (the panel, the contracts package, the domain, the host adapter) spelled as the URLs the bridge serves them at. */
export const forBrowser = (code: string): string =>
  code.replace(
    PACKAGE_SPECIFIER,
    (_whole, lead: string, quote: string, scope: string, name: string) =>
      `${lead}${quote}/assets/${scope}/${name}.ts${quote}`,
  );

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
    code = forBrowser(stripTypeScriptTypes(readFileSync(file, 'utf8')));
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
  const panelModule = PANEL_MODULE.exec(pathname);
  const hostModule = GITHUB_PAGE_MODULE.exec(pathname);
  const boardModule = BOARD_MODULE.exec(pathname);
  const localModule = LOCAL_MODULE.exec(pathname);
  const contractsModule = CONTRACTS_MODULE.exec(pathname);
  const domainModule = DOMAIN_MODULE.exec(pathname);
  const apiClientModule = API_CLIENT_MODULE.exec(pathname);
  const uiModule = UI_MODULE.exec(pathname);
  if (
    !panelModule &&
    !hostModule &&
    !boardModule &&
    !localModule &&
    !contractsModule &&
    !domainModule &&
    !apiClientModule &&
    !uiModule
  ) {
    return null;
  }
  let file: string;
  if (panelModule) {
    file = path.join(PANEL, panelModule[1]);
  } else if (boardModule) {
    file = path.join(PUBLIC, 'board', boardModule[1]);
  } else if (hostModule) {
    file = path.join(GITHUB_PAGE, hostModule[1]);
  } else if (apiClientModule) {
    file = path.join(API_CLIENT, `${apiClientModule[1]}.ts`);
  } else if (uiModule) {
    file = path.join(UI_DIR, uiModule[1]);
  } else if (contractsModule) {
    file = path.join(CONTRACTS, `${contractsModule[1]}.ts`);
  } else if (domainModule) {
    file = path.join(DOMAIN, `${domainModule[1]}.ts`);
  } else {
    file = path.join(PUBLIC, 'local', (localModule as RegExpExecArray)[1]);
  }
  if (!existsSync(file)) {
    throw new HttpError(404, 'no such module');
  }
  return served(file);
}
