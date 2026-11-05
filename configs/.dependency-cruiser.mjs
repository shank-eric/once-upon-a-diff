/*
 * The one home for which package, layer or region may import which, and for import cycles (`yarn depcruise`, run by
 * `yarn lint`). See AGENTS.md "Structure". It sees the whole graph, so an import through a re-export still counts.
 * ESLint keeps style and configs/eslint.side-effects.mjs (only an adapter runs a program, writes a file or reaches the network).
 * Source only: tests, scripts and config cross packages on purpose, so they are not cruised.
 *
 * The browser imports its modules by URL (`/assets/panel/shell/overlay.ts`). The bridge serves them from the packages, and
 * configs/tsconfig.depcruise.json maps each URL back to its file (the same `paths` as packages/web/public/tsconfig.json, except that the pages' own files are listed one by one, not by
 * an /assets/* catch-all, so /assets/vendor/preact.mjs resolves to nothing: the one Preact is /assets/preact.mjs; a new top-level page
 * needs a line there), so the cruise takes that tsconfig to resolve them. A package import (`@once-upon-a-diff/panel/shell/overlay`) resolves through the workspace
 * symlink and the package's `exports`.
 * Its `paths` are relative to the repo root, not to configs/: depcruise resolves them against the folder it runs from (`yarn depcruise` runs at the root).
 *
 * Packages and layers, as paths from the repo root (a rule's `from`/`to` match these):
 *   bridge   packages/bridge/src/{server (+routes), cli} over services over adapters (BRIDGE is the whole package)
 *            packages/bridge/instrumentation (the usage probe the entry shims preload: outside the layers)
 *   web      packages/web/public (the pages, an app)
 *   extension packages/extension/src (an app)
 *   panel, host-github, api-client, ui-kit, contracts, domain (imports nothing), test-kit
 */

import { fileURLToPath } from 'node:url';

const BRIDGE = '^packages/bridge/';
const SERVER = '^packages/bridge/src/server/';
const CLI = '^packages/bridge/src/cli/';
const ROUTES = '^packages/bridge/src/server/routes/';
const SERVICES = '^packages/bridge/src/services/';
const ADAPTERS = '^packages/bridge/src/adapters/';
const WEB = '^packages/web/public/';
const EXTENSION = '^packages/extension/';
const PANEL = '^packages/panel/';
const HOST = '^packages/host-github/';
const API_CLIENT = '^packages/api-client/';
const UI_PKG = '^packages/ui-kit/';
const CONTRACTS = '^packages/contracts/';
const DOMAIN = '^packages/domain/';
const TEST_KIT = '^packages/test-kit/';
const INSTRUMENTATION = '^packages/bridge/instrumentation/';

// code that ships to a browser (no Node built-ins)
const BROWSER = `^packages/(panel|host-github|api-client|ui-kit|contracts|domain|extension/src)/|${WEB}`;

const rule = (name, comment, importer, imported) => ({
  name,
  comment,
  severity: 'error',
  from: importer,
  to: imported,
});

const BOARD_REGIONS = ['header', 'columns', 'backlog', 'worktrees', 'voice'];

// regions: sibling folders of one feature that do not import each other, nor the composition root above them
const REGION_SETS = [
  {
    name: 'panel',
    root: 'packages/panel/src',
    regions: ['ask', 'drafts', 'fixes', 'reading', 'rebuild'],
    top: 'packages/panel/src/shell/overlay\\.ts',
  },
  {
    name: 'board',
    root: 'packages/web/public/board',
    regions: BOARD_REGIONS,
    top: 'packages/web/public/board\\.ts',
  },
];
const regionRules = REGION_SETS.flatMap(({ name, root, regions, top }) => {
  const any = `^${root}/(${regions.join('|')})/`;
  return [
    rule(
      `${name}-regions-apart`,
      'regions do not import each other: a region takes what it shares from the feature’s shared files, and the page or panel composes the regions',
      { path: any },
      { path: any, pathNot: `^${root}/$1/` },
    ),
    rule(
      `${name}-region-not-the-root`,
      'the composition root imports the regions: a region does not import it',
      { path: any },
      { path: `^${top}$` },
    ),
  ];
});

// the board's shared files sit below its regions and its page
const boardSharedRule = rule(
  'board-shared-below-the-regions',
  'board/shared.ts and board/worktree-text.ts sit below the regions and board.ts, which import them',
  { path: '^packages/web/public/board/(shared|worktree-text)\\.ts$' },
  {
    path: `^packages/web/public/board(\\.ts$|/(${BOARD_REGIONS.join('|')})/)`,
  },
);

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'a cycle between modules: break it by moving what both need into a third module',
      severity: 'warn', // 17 runtime cycles exist today: visible, not blocking, until they are broken
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },

    ...regionRules,
    boardSharedRule,

    // the bridge: server (HTTP) and cli over services over adapters
    rule(
      'adapters-are-bottom',
      'the adapters sit below the services: they import neither the services nor an app',
      { path: ADAPTERS },
      { path: [SERVICES, SERVER, CLI] },
    ),
    rule(
      'services-below-apps',
      'the services sit below the apps: they import neither the HTTP app nor the CLI',
      { path: SERVICES },
      { path: [SERVER, CLI] },
    ),
    rule(
      'apps-use-services',
      'the HTTP app and the CLI go through the services, and only the services call an adapter',
      { path: [SERVER, CLI] },
      { path: ADAPTERS },
    ),
    rule(
      'http-cli-apart',
      'the HTTP app and the CLI are separate apps: neither imports the other',
      { path: SERVER },
      { path: CLI },
    ),
    rule(
      'cli-not-http',
      'the HTTP app and the CLI are separate apps: neither imports the other',
      { path: CLI },
      { path: SERVER },
    ),
    rule(
      'only-adapters-run-programs-or-network',
      'only an adapter runs a program or reaches the network (the HTTP app has node:http, to listen). Covers the imports a graph can see; the rest stays ESLint-only (configs/eslint.side-effects.mjs): fs writes (an import of node:fs cannot tell a read from a write), fetch, process.kill and module loaders',
      { path: [SERVICES, SERVER, CLI] },
      {
        dependencyTypes: ['core'],
        path: '^(node:)?(child_process|net|https|http2|dgram|tls|dns|worker_threads|vm)(/|$)',
      },
    ),
    rule(
      'only-adapters-run-programs-or-network-http',
      'only the HTTP app (server/, not server/routes/) has node:http, to listen',
      { path: [SERVICES, CLI, ROUTES] },
      { dependencyTypes: ['core'], path: '^(node:)?http$' },
    ),
    rule(
      'instrumentation-is-for-the-shims',
      'instrumentation (the usage probe) is preloaded by the entry shims (bin/once-upon.mjs, skills/once-upon/bin/story.mjs) and by tests: nothing in src/ imports it (it imports the session adapter, never the other way)',
      { path: '^packages/bridge/src/' },
      { path: INSTRUMENTATION },
    ),
    rule(
      'bridge-not-the-client',
      'the bridge serves the client packages, it does not import them: the client and the server meet at the contracts package',
      { path: BRIDGE },
      { path: `${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}` },
    ),
    rule(
      'bridge-is-server-only',
      'the bridge is server code: only the server and Node tests import it',
      {
        path: `${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}|${CONTRACTS}|${DOMAIN}|${TEST_KIT}`,
      },
      { path: BRIDGE },
    ),

    // the client side
    rule(
      'browser-no-node',
      'code that ships to a browser cannot use Node built-ins',
      { path: BROWSER },
      { dependencyTypes: ['core'] },
    ),
    rule(
      'contracts-is-bottom',
      'the contracts package is the bottom of the client and server: it imports no other package of this repo but the domain',
      { path: CONTRACTS },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}|${TEST_KIT}`,
      },
    ),
    rule(
      'contracts-names-itself-by-path',
      'the contracts package names its own files by relative path: by name it imports valibot and the domain only',
      { path: CONTRACTS },
      { path: CONTRACTS, dependencyTypesNot: ['local'] },
    ),
    rule(
      'contracts-imports-only-valibot',
      'the contracts package imports nothing but itself, the domain and valibot (an npm package or an unresolved import is refused)',
      { path: CONTRACTS },
      {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
        ],
        pathNot: 'node_modules/valibot/',
      },
    ),
    rule(
      'contracts-no-unresolved',
      'the contracts package imports nothing but itself, the domain and valibot: an import that resolves to nothing is refused',
      { path: CONTRACTS },
      { couldNotResolve: true },
    ),
    rule(
      'domain-imports-nothing',
      'the domain package is pure rules: it imports nothing, not another package of this repo, not npm, not even one of its own files by name',
      { path: DOMAIN },
      {},
    ),
    rule(
      'api-client-below-panel-and-pages',
      'the api-client imports the contracts package and the domain and nothing else of this repo',
      { path: API_CLIENT },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${UI_PKG}|${TEST_KIT}`,
        pathNot: '^packages/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'ui-kit-below-panel-and-pages',
      'ui-kit sits below the panel, the pages and the extension: it imports the contracts package, the domain and the vendored Preact, never an app, the server, the panel, a host adapter or the api-client',
      { path: UI_PKG },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${TEST_KIT}`,
        pathNot: '^packages/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'ui-kit-imports-only-the-contracts',
      'ui-kit imports nothing from npm (the vendored Preact resolves through the tsconfig paths, and no npm package is its own): an npm package or an unresolved import is refused',
      { path: UI_PKG },
      {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
        ],
      },
    ),
    rule(
      'ui-kit-no-unresolved',
      'an import in ui-kit that resolves to nothing is refused',
      { path: UI_PKG },
      { couldNotResolve: true },
    ),
    rule(
      'poll-hook-is-the-pages',
      'use-poll.ts is the pages’ Preact hook: the panel, the extension and the host adapter use poll.ts',
      { path: `${PANEL}|${EXTENSION}|${HOST}` },
      { path: '^packages/api-client/src/use-poll\\.ts$' },
    ),
    rule(
      'panel-is-host-agnostic',
      'the panel is handed a host adapter (panel/src/host/host.ts), it never imports one, or an app, or the server',
      { path: PANEL },
      {
        path: `${HOST}|${WEB}|${EXTENSION}|${BRIDGE}|${TEST_KIT}`,
        pathNot: '^packages/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'host-implements-the-panel-port',
      'a host adapter implements the panel’s port (host.ts, diff-types.ts): not the composition root or a region',
      { path: HOST },
      {
        path: PANEL,
        pathNot: '^packages/panel/src/host/(host|diff-types)\\.ts$',
      },
    ),
    rule(
      'host-below-apps',
      'a host adapter sits below the apps and the server',
      { path: HOST },
      { path: `${WEB}|${EXTENSION}|${BRIDGE}|${TEST_KIT}` },
    ),
    rule(
      'schemas-are-server-side',
      "the schema files (schemas.ts, schema-kit.ts and each area's schemas.ts) import valibot, which no page or extension loads: only the server and the contracts package itself import them",
      { path: `${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}` },
      { path: '^packages/contracts/src/(schemas|schema-kit|[a-z-]+/schemas)\\.ts$' },
    ),
    rule(
      'pages-are-an-app',
      'the pages are an app: nothing imports them, and they do not import the extension or the server',
      // the panel, ui-kit, the api-client and the extension have their own rules over WEB (they may name the vendored Preact, by its URL only)
      { path: `${HOST}|${CONTRACTS}|${BRIDGE}|${TEST_KIT}` },
      { path: WEB },
    ),
    rule(
      'preact-by-its-url-only',
      'the vendored Preact is named /assets/preact.mjs by the panel, ui-kit, the api-client hook and the extension’s components, so a page has one Preact: not by a relative path or a package name',
      { path: `${PANEL}|${UI_PKG}|${API_CLIENT}|${EXTENSION}` },
      {
        path: '^packages/web/public/vendor/preact\\.mjs$',
        dependencyTypesNot: ['aliased-tsconfig-paths'],
      },
    ),
    rule(
      'pages-not-the-extension',
      'the pages and the extension are separate apps',
      { path: WEB },
      { path: `${EXTENSION}|${BRIDGE}` },
    ),
    rule(
      'extension-is-an-app',
      'the extension is an app: nothing imports it, and it does not import the server or the pages',
      { pathNot: EXTENSION },
      { path: EXTENSION },
    ),
    rule(
      'extension-not-the-server',
      'the extension meets the server over HTTP, not by import (the vendored Preact, which its bundle names by URL like the panel does, is the one file of the pages it takes)',
      { path: EXTENSION },
      { path: `${BRIDGE}|${WEB}`, pathNot: '^packages/web/public/vendor/preact\\.mjs$' },
    ),
    // the /assets/ spelling: the browser imports by URL, the extension's bundle and the packages by name
    rule(
      'client-names-packages-not-page-urls',
      'the panel, ui-kit and the api-client hook are shared by the extension and the pages: the one page URL they name is the vendored Preact (/assets/preact.mjs), and they import packages, never a page module',
      { path: `${PANEL}|${UI_PKG}|^packages/api-client/src/use-poll\\.ts$` },
      {
        dependencyTypes: ['aliased-tsconfig-paths'],
        pathNot: '^packages/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'no-page-urls-at-all',
      'host-github is served at /assets/ for the pages, and the api-client’s client.ts and poll.ts are shared with the panel and the extension: they name packages, not an /assets/ URL (use-poll.ts, the pages’ hook, may name the vendored Preact)',
      { path: `${HOST}|^packages/api-client/src/(?!use-poll\\.ts$)` },
      { dependencyTypes: ['aliased-tsconfig-paths'] },
    ),
    rule(
      'contracts-names-no-page-urls',
      'the contracts package names its own files by relative path, not by an /assets/ URL',
      { path: CONTRACTS },
      { dependencyTypes: ['aliased-tsconfig-paths'] },
    ),
    rule(
      'no-unresolved',
      'an import that resolves to nothing (a mistyped path, an /assets/ URL no tsconfig path maps, a package path its exports do not expose) is refused',
      {},
      { couldNotResolve: true },
    ),
    rule(
      'shipped-code-not-the-test-kit',
      'the test kit is dev-only: tests import it, nothing that ships does',
      { path: '^packages/[^/]+/(src|public|bin)/', pathNot: TEST_KIT },
      { path: TEST_KIT },
    ),
    rule(
      'test-kit-is-below',
      'the test kit sits below every package: it imports Node and linkedom only',
      { path: TEST_KIT },
      { path: '^packages/', pathNot: TEST_KIT },
    ),
  ],
  options: {
    // the vendored files are leaves: an import of one is a dependency the rules see, but its own imports are not followed
    doNotFollow: { path: 'node_modules|/vendor/' },
    tsConfig: { fileName: fileURLToPath(new URL('./tsconfig.depcruise.json', import.meta.url)) },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mjs', '.js', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
