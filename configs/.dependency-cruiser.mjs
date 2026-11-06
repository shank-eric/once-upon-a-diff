/*
 * The one home for which package, layer or region may import which, and for import cycles (`yarn depcruise`, run by
 * `yarn lint`). See AGENTS.md "Structure". It sees the whole graph, so an import through a re-export still counts.
 * ESLint keeps style and configs/eslint.side-effects.mjs (only an adapter runs a program, writes a file or reaches the network).
 * Source only: tests, scripts and config cross packages on purpose, so they are not cruised.
 *
 * The browser imports its modules by URL (`/assets/panel/shell/overlay.ts`). The bridge serves them from the packages, and
 * configs/tsconfig.depcruise.json maps each URL back to its file (the same `paths` as packages/client/web/public/tsconfig.json, except that the pages' own files are listed one by one, not by
 * an /assets/* catch-all, so /assets/vendor/preact.mjs resolves to nothing: the one Preact is /assets/preact.mjs; a new top-level page
 * needs a line there), so the cruise takes that tsconfig to resolve them. A package import (`@once-upon-a-diff/panel/shell/overlay`) resolves through the workspace
 * symlink and the package's `exports`.
 * Its `paths` are relative to the repo root, not to configs/: depcruise resolves them against the folder it runs from (`yarn depcruise` runs at the root).
 *
 * Packages and layers, as paths from the repo root (a rule's `from`/`to` match these):
 *   the engine, bottom to top (configs/layers.mjs, the one list): adapters (every side effect), foundation, stories, state,
 *   core, board (packages/server-libs/<name>/src). A package imports only the ones under it. state keeps two tiers inside it (records, then
 *   queues) and core two (features, then orchestration), whose folders never import each other. usage (packages/server-libs/usage/src) sits
 *   beside the stack: it imports adapters and foundation, and only the apps and the shell import it. board is the server's
 *   alone
 *   server   packages/server/server/src (the HTTP app, with routes/) and cli packages/server/cli/src (the CLI): apps over the engine, apart from each other
 *   bridge   packages/server/bridge (the shell): bin/once-upon.ts is the one file that knows both apps, instrumentation (the usage probe
 *            the entry shims preload) and the integration tests. BRIDGE below is the whole server side: the shell, the engine and both apps
 *   web      packages/client/web/public (the pages, an app)
 *   extension packages/client/extension/src (an app)
 *   panel, github-page, bridge-client, ui-kit, contracts, terms (imports nothing), test-kit
 */

import { fileURLToPath } from 'node:url';
import { PACKAGES, TIERS } from './layers.mjs';

const ENGINE_NAMES = [...PACKAGES, 'usage'];
const BRIDGE = '^packages/(server|server-libs)/';
const SHELL = '^packages/server/bridge/';
const SERVER = '^packages/server/server/src/';
const CLI = '^packages/server/cli/src/';
const ROUTES = '^packages/server/server/src/routes/';
const srcOf = (names) => `^packages/server-libs/(${names.join('|')})/src/`;
// the engine libraries (every engine package, usage included): they sit under the apps
const ENGINE = srcOf(ENGINE_NAMES);
const ADAPTERS = srcOf(['adapters']);
const USAGE = srcOf(['usage']);
const USAGE_ADAPTERS = '^packages/server-libs/usage/src/adapters/';
// what only an adapter may do: every engine package but adapters, except usage's own adapters folder
const NOT_ADAPTERS = `${srcOf(ENGINE_NAMES.filter((name) => name !== 'adapters'))}`;
const HEALTH_CHECK = '^packages/server-libs/adapters/src/bridge-health\\.ts$';
const DOCTOR = '^packages/server-libs/core/src/orchestration/bridge/doctor\\.ts$';
// what a client needs to call the bridge: the route table (the routes, and the kit and each area's routes it is built from)
const ROUTE_TABLE = '^packages/domain/contracts/src/(routes|route-kit|[a-z-]+/routes)\\.ts$';
const WEB = '^packages/client/web/public/';
const EXTENSION = '^packages/client/extension/';
const PANEL = '^packages/client/panel/';
const GITHUB_PAGE = '^packages/client/github-page/';
const BRIDGE_CLIENT = '^packages/client-libs/bridge-client/';
const UI_PKG = '^packages/client-libs/ui-kit/';
const CONTRACTS = '^packages/domain/contracts/';
const TERMS = '^packages/domain/terms/';
const TEST_KIT = '^packages/domain/test-kit/';
const INSTRUMENTATION = '^packages/server/bridge/instrumentation/';

// code that ships to a browser (no Node built-ins)
const BROWSER = `^packages/(client/(panel|github-page|extension/src)|client-libs/(bridge-client|ui-kit)|domain/(contracts|terms))/|${WEB}`;

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
    root: 'packages/client/panel/src',
    regions: ['ask', 'drafts', 'fixes', 'reading', 'rebuild'],
    top: 'packages/client/panel/src/shell/overlay\\.ts',
  },
  {
    name: 'board',
    root: 'packages/client/web/public/board',
    regions: BOARD_REGIONS,
    top: 'packages/client/web/public/board\\.ts',
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
  { path: '^packages/client/web/public/board/(shared|worktree-text)\\.ts$' },
  {
    path: `^packages/client/web/public/board(\\.ts$|/(${BOARD_REGIONS.join('|')})/)`,
  },
);

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'a cycle between modules: break it by moving what both need into a third module',
      severity: 'error',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },

    ...regionRules,
    boardSharedRule,

    // the engine (configs/layers.mjs), bottom to top, and the two apps over it. A package imports only the ones under it; usage
    // is beside them (usage-for-apps-only), and board is the server's alone
    rule(
      'adapters-are-bottom',
      'the adapters sit below every other engine package: they import none of them',
      { path: ADAPTERS },
      { path: srcOf(PACKAGES.slice(1)) },
    ),
    ...PACKAGES.slice(1, -1).map((name, index) =>
      rule(
        `${name}-imports-only-below`,
        `an engine package imports only the packages under it: ${name} never imports ${PACKAGES.slice(index + 2).join(', ')}`,
        { path: srcOf([name]) },
        { path: srcOf(PACKAGES.slice(index + 2)) },
      ),
    ),
    rule(
      'core-below-apps',
      'the engine sits below the apps: no engine package imports the HTTP app, the CLI nor the shell',
      { path: ENGINE },
      { path: [SERVER, CLI, SHELL] },
    ),
    rule(
      'apps-use-the-engine-not-adapters',
      'the HTTP app and the CLI go through the packages over the adapters, and only those call an adapter',
      { path: [SERVER, CLI] },
      { path: ADAPTERS },
    ),
    rule(
      'usage-for-apps-only',
      'usage (the dev instrumentation) is imported by the apps and the shell, never by an engine package: it sits beside the stack, not in it',
      { path: srcOf(PACKAGES) },
      { path: USAGE },
    ),
    rule(
      'usage-imports-only-the-floor',
      'usage imports the adapters and the foundation and nothing above them',
      { path: USAGE },
      { path: srcOf(PACKAGES.slice(2)) },
    ),
    rule(
      'usage-adapters-are-bottom',
      'usage/src/adapters/ is the side-effect folder of usage and imports none of its other files (session.ts imports nothing of this repo at all: the shell preloads it)',
      { path: USAGE_ADAPTERS },
      { path: USAGE, pathNot: USAGE_ADAPTERS },
    ),
    rule(
      'board-is-the-servers',
      'board is the server’s alone: no cli, core or other engine file imports it (the shell reaches it only through the server, which the shell loads)',
      { pathNot: [SERVER, '^packages/server-libs/board/'] },
      { path: '^packages/server-libs/board/' },
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
      'apps-not-the-shell',
      'bin/once-upon.ts in the shell is the one file that knows both apps: neither app, nor core, imports the shell',
      { path: [SERVER, CLI] },
      { path: SHELL },
    ),
    // the tiers inside state and core: each imports only the tiers under it, and the folders of one tier stay apart
    ...Object.entries(TIERS).flatMap(([pkg, tiers]) => [
      ...tiers
        .slice(0, -1)
        .map((name, index) =>
          rule(
            `${pkg}-${name}-below`,
            `a tier imports only the tiers under it: in ${pkg}, ${name} never imports ${tiers.slice(index + 1).join(', ')}`,
            { path: `^packages/server-libs/${pkg}/src/${name}/` },
            { path: `^packages/server-libs/${pkg}/src/(${tiers.slice(index + 1).join('|')})/` },
          ),
        ),
      rule(
        `${pkg}-tier-siblings-apart`,
        `folders in one tier of ${pkg} do not import each other: move what both need down a tier`,
        { path: `^packages/server-libs/${pkg}/src/(${tiers.join('|')})/([^/]+)/` },
        {
          path: `^packages/server-libs/${pkg}/src/$1/`,
          pathNot: `^packages/server-libs/${pkg}/src/$1/$2/`,
        },
      ),
    ]),
    rule(
      'listening-through-service',
      'listening has one way in: the CLI, the HTTP app and the board import features/listeners/service.ts, not the listener files behind it. The queues below it read heartbeats directly',
      {
        path: [
          '^packages/(server/(cli|server)|server-libs/board)/src/',
          '^packages/server-libs/core/src/orchestration/',
        ],
      },
      {
        path: [
          '^packages/server-libs/state/src/records/listeners/',
          '^packages/server-libs/core/src/features/listeners/(?!service\\.ts$)',
        ],
      },
    ),
    rule(
      'only-adapters-run-programs-or-network',
      'only an adapter runs a program or reaches the network (the HTTP app has node:http, to listen). Covers the imports a graph can see; the rest stays ESLint-only (configs/eslint.side-effects.mjs): fs writes (an import of node:fs cannot tell a read from a write), fetch, process.kill and module loaders',
      { path: [NOT_ADAPTERS, SERVER, CLI], pathNot: USAGE_ADAPTERS },
      {
        dependencyTypes: ['core'],
        path: '^(node:)?(child_process|net|https|http2|dgram|tls|dns|worker_threads|vm)(/|$)',
      },
    ),
    rule(
      'only-adapters-run-programs-or-network-http',
      'only the HTTP app (server/, not server/routes/) has node:http, to listen',
      { path: [NOT_ADAPTERS, CLI, ROUTES], pathNot: USAGE_ADAPTERS },
      { dependencyTypes: ['core'], path: '^(node:)?http$' },
    ),
    // the CLI never calls the server (ADR-15). Which imports could make a call are named here; what the graph cannot see (a
    // fetch, a socket, a signal, a program) is packages/server/bridge/test/cli-never-calls-server.test.ts, the real guard
    rule(
      'health-check-is-the-doctors',
      'the doctor’s health check (adapters/bridge-health.ts) is the one call the CLI or the engine makes to the running bridge, and orchestration/bridge/doctor.ts is its one importer: the CLI never calls the server (ADR-15), it reads and writes the shared files through core',
      { pathNot: `${DOCTOR}|${HEALTH_CHECK}` },
      { path: HEALTH_CHECK },
    ),
    rule(
      'cli-and-core-have-no-route-table',
      'the route table is how a client calls the bridge: the CLI and the engine never import it as a value (a type from it, such as RouteName, is fine). The CLI never calls the server (ADR-15)',
      { path: `${CLI}|${ENGINE}` },
      { path: ROUTE_TABLE, dependencyTypesNot: ['type-only'] },
    ),
    rule(
      'instrumentation-is-for-the-shims',
      'instrumentation (the usage probe) is preloaded by the entry shims (bin/once-upon.mjs, skills/once-upon/bin/story.mjs) and by tests: nothing in src/ imports it (it imports the session adapter, never the other way)',
      { path: [ENGINE, SERVER, CLI] },
      { path: INSTRUMENTATION },
    ),
    rule(
      'bridge-not-the-client',
      'the bridge serves the client packages, it does not import them: the client and the server meet at the contracts package',
      { path: BRIDGE },
      { path: `${PANEL}|${GITHUB_PAGE}|${BRIDGE_CLIENT}|${UI_PKG}` },
    ),
    rule(
      'bridge-is-server-only',
      'the bridge is server code: only the server and Node tests import it',
      {
        path: `${WEB}|${EXTENSION}|${PANEL}|${GITHUB_PAGE}|${BRIDGE_CLIENT}|${UI_PKG}|${CONTRACTS}|${TERMS}|${TEST_KIT}`,
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
      'the contracts package is the bottom of the client and server: it imports no other package of this repo but the terms package',
      { path: CONTRACTS },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${GITHUB_PAGE}|${BRIDGE_CLIENT}|${UI_PKG}|${TEST_KIT}`,
      },
    ),
    rule(
      'contracts-names-itself-by-path',
      'the contracts package names its own files by relative path: by name it imports valibot and the terms package only',
      { path: CONTRACTS },
      { path: CONTRACTS, dependencyTypesNot: ['local'] },
    ),
    rule(
      'contracts-imports-only-valibot',
      'the contracts package imports nothing but itself, the terms package and valibot (an npm package or an unresolved import is refused)',
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
      'the contracts package imports nothing but itself, the terms package and valibot: an import that resolves to nothing is refused',
      { path: CONTRACTS },
      { couldNotResolve: true },
    ),
    rule(
      'terms-imports-nothing',
      'the terms package is pure rules: it imports nothing, not another package of this repo, not npm, not even one of its own files by name',
      { path: TERMS },
      {},
    ),
    rule(
      'bridge-client-below-panel-and-pages',
      'the bridge-client imports the contracts package and the terms package and nothing else of this repo',
      { path: BRIDGE_CLIENT },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${GITHUB_PAGE}|${UI_PKG}|${TEST_KIT}`,
        pathNot: '^packages/client/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'ui-kit-below-panel-and-pages',
      'ui-kit sits below the panel, the pages and the extension: it imports the contracts package, the terms package and the vendored Preact, never an app, the server, the panel, a host adapter or the bridge-client',
      { path: UI_PKG },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${GITHUB_PAGE}|${BRIDGE_CLIENT}|${TEST_KIT}`,
        pathNot: '^packages/client/web/public/vendor/preact\\.mjs$',
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
      { path: `${PANEL}|${EXTENSION}|${GITHUB_PAGE}` },
      { path: '^packages/client-libs/bridge-client/src/use-poll\\.ts$' },
    ),
    rule(
      'panel-is-host-agnostic',
      'the panel is handed a host adapter (panel/src/host/host.ts), it never imports one (github-page is the one), or an app, or the server',
      { path: PANEL },
      {
        path: `${GITHUB_PAGE}|${WEB}|${EXTENSION}|${BRIDGE}|${TEST_KIT}`,
        pathNot: '^packages/client/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'github-page-implements-the-panel-port',
      'github-page, the host adapter, implements the panel’s port (host.ts, diff-types.ts): not the composition root or a region',
      { path: GITHUB_PAGE },
      {
        path: PANEL,
        pathNot: '^packages/client/panel/src/host/(host|diff-types)\\.ts$',
      },
    ),
    rule(
      'github-page-below-apps',
      'github-page, the host adapter, sits below the apps and the server',
      { path: GITHUB_PAGE },
      { path: `${WEB}|${EXTENSION}|${BRIDGE}|${TEST_KIT}` },
    ),
    rule(
      'schemas-are-server-side',
      "the schema files (schemas.ts, schema-kit.ts and each area's schemas.ts) import valibot, which no page or extension loads: only the server and the contracts package itself import them",
      { path: `${WEB}|${EXTENSION}|${PANEL}|${GITHUB_PAGE}|${BRIDGE_CLIENT}|${UI_PKG}` },
      { path: '^packages/domain/contracts/src/(schemas|schema-kit|[a-z-]+/schemas)\\.ts$' },
    ),
    rule(
      'pages-are-an-app',
      'the pages are an app: nothing imports them, and they do not import the extension or the server',
      // the panel, ui-kit, the bridge-client and the extension have their own rules over WEB (they may name the vendored Preact, by its URL only)
      { path: `${GITHUB_PAGE}|${CONTRACTS}|${BRIDGE}|${TEST_KIT}` },
      { path: WEB },
    ),
    rule(
      'preact-by-its-url-only',
      'the vendored Preact is named /assets/preact.mjs by the panel, ui-kit, the bridge-client hook and the extension’s components, so a page has one Preact: not by a relative path or a package name',
      { path: `${PANEL}|${UI_PKG}|${BRIDGE_CLIENT}|${EXTENSION}` },
      {
        path: '^packages/client/web/public/vendor/preact\\.mjs$',
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
      { path: `${BRIDGE}|${WEB}`, pathNot: '^packages/client/web/public/vendor/preact\\.mjs$' },
    ),
    // the /assets/ spelling: the browser imports by URL, the extension's bundle and the packages by name
    rule(
      'client-names-packages-not-page-urls',
      'the panel, ui-kit and the bridge-client hook are shared by the extension and the pages: the one page URL they name is the vendored Preact (/assets/preact.mjs), and they import packages, never a page module',
      { path: `${PANEL}|${UI_PKG}|^packages/client-libs/bridge-client/src/use-poll\\.ts$` },
      {
        dependencyTypes: ['aliased-tsconfig-paths'],
        pathNot: '^packages/client/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'no-page-urls-at-all',
      'github-page is served at /assets/ for the pages, and the bridge-client’s client.ts and poll.ts are shared with the panel and the extension: they name packages, not an /assets/ URL (use-poll.ts, the pages’ hook, may name the vendored Preact)',
      { path: `${GITHUB_PAGE}|^packages/client-libs/bridge-client/src/(?!use-poll\\.ts$)` },
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
    // the five folders (configs/layers.mjs GROUPS): domain is the floor, the client and the server never import each other, libs never import apps
    rule(
      'domain-is-the-floor',
      'packages/domain (the terms, the contracts, the test kit) sits under every other group: it imports nothing from them, only its own folder and npm (valibot, linkedom)',
      { path: '^packages/domain/' },
      { path: '^packages/(server|server-libs|client|client-libs)/' },
    ),
    rule(
      'client-side-not-server-side',
      'the client side (client, client-libs) imports nothing of the server side (server, server-libs): they meet at the contracts package, and the bridge serves client files by name (import.meta.resolve), which is not an import',
      { path: '^packages/(client|client-libs)/' },
      { path: '^packages/(server|server-libs)/' },
    ),
    rule(
      'server-side-not-client-side',
      'the server side (server, server-libs) imports nothing of the client side (client, client-libs): it serves their files, it does not import them',
      { path: '^packages/(server|server-libs)/' },
      { path: '^packages/(client|client-libs)/' },
    ),
    rule(
      'libs-not-apps',
      'a libs folder sits under its apps: client-libs imports nothing in client (but the vendored Preact the pages serve) and server-libs nothing in server',
      { path: '^packages/(client|server)-libs/' },
      {
        path: ['^packages/client/', '^packages/server/'],
        pathNot: '^packages/client/web/public/vendor/preact\\.mjs$',
      },
    ),
    rule(
      'shipped-code-not-the-test-kit',
      'the test kit is dev-only: tests import it, nothing that ships does',
      { path: '^packages/[^/]+/[^/]+/(src|public|bin)/', pathNot: TEST_KIT },
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
