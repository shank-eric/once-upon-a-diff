/*
 * Layer check with dependency-cruiser (`yarn depcruise`). It mirrors eslint.boundaries.mjs and AGENTS.md "Structure"
 * (packages/bridge/test/layer-rules-agree.test.ts fails when the two disagree on what a layer may import),
 * and adds what ESLint cannot see: import cycles, and the whole graph (an import through a re-export still counts).
 * Source only: tests, scripts and config cross packages on purpose, so they are not cruised.
 *
 * The browser imports its modules by URL (`/assets/panel/overlay.ts`). The bridge serves them from the packages, and
 * tsconfig.depcruise.json maps each URL back to its file (the same `paths` as packages/web/public/tsconfig.json), so the cruise takes that
 * tsconfig to resolve them. A package import (`@once-upon-a-diff/panel/overlay`) resolves through the workspace
 * symlink and the package's `exports`.
 *
 * Packages and layers, as paths from the repo root (a rule's `from`/`to` match these):
 *   bridge   packages/bridge/src/{server (+routes), cli} over services over adapters (BRIDGE is the whole package)
 *   web      packages/web/public (the pages, an app)
 *   extension packages/extension/src (an app)
 *   panel, host-github, api-client, ui, protocol (+ protocol/src/domain), test-kit
 */

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
const UI_PKG = '^packages/ui/';
const PROTOCOL = '^packages/protocol/';
const DOMAIN = '^packages/protocol/src/domain/';
const TEST_KIT = '^packages/test-kit/';

// code that ships to a browser (no Node built-ins)
const BROWSER = `^packages/(panel|host-github|api-client|ui|protocol|extension/src)/|${WEB}`;

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
    top: 'packages/panel/src/overlay\\.ts',
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
      severity: 'warn', // 19 runtime cycles exist today (listed in the card notes): visible, not blocking, until they are broken
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
      'only an adapter runs a program or reaches the network (the HTTP app has node:http, to listen). Covers the imports a graph can see; the rest stays ESLint-only (eslint.boundaries.mjs): fs writes (an import of node:fs cannot tell a read from a write), fetch, process.kill, module loaders, and the /assets/ specifier rules',
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
      'bridge-not-the-client',
      'the bridge serves the client packages, it does not import them: the client and the server meet at the protocol',
      { path: BRIDGE },
      { path: `${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}` },
    ),
    rule(
      'bridge-is-server-only',
      'the bridge is server code: only the server and Node tests import it',
      {
        path: `${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}|${PROTOCOL}|${TEST_KIT}`,
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
      'protocol-is-bottom',
      'the protocol is the bottom of the client and server: it imports no other package of this repo',
      { path: PROTOCOL },
      {
        path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}|${TEST_KIT}`,
      },
    ),
    rule(
      'protocol-names-itself-by-path',
      'the protocol names its own files by relative path: by name it imports valibot only',
      { path: PROTOCOL },
      { path: PROTOCOL, dependencyTypesNot: ['local'] },
    ),
    rule(
      'protocol-imports-only-valibot',
      'the protocol imports nothing but itself and valibot (an npm package or an unresolved import is refused)',
      { path: PROTOCOL },
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
      'protocol-no-unresolved',
      'the protocol imports nothing but itself and valibot: an import that resolves to nothing is refused',
      { path: PROTOCOL },
      { couldNotResolve: true },
    ),
    rule(
      'domain-imports-nothing',
      'the domain is pure rules: it imports nothing, not even the rest of the protocol',
      { path: DOMAIN },
      { pathNot: DOMAIN },
    ),
    rule(
      'api-client-below-panel-and-pages',
      'the api-client imports the protocol and nothing else of this repo',
      { path: API_CLIENT },
      { path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${UI_PKG}|${TEST_KIT}` },
    ),
    rule(
      'ui-below-panel-and-pages',
      'ui sits below the panel, the pages and the extension: it imports the protocol and the vendored Preact, never an app, the server, the panel, a host adapter or the api-client',
      { path: UI_PKG },
      { path: `${BRIDGE}|${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${TEST_KIT}` },
    ),
    rule(
      'ui-imports-only-the-protocol',
      'ui imports nothing from npm (the vendored Preact resolves through the tsconfig paths, and no npm package is its own): an npm package or an unresolved import is refused',
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
      'ui-no-unresolved',
      'an import in ui that resolves to nothing is refused',
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
      'the panel is handed a host adapter (panel/src/host.ts), it never imports one, or an app, or the server',
      { path: PANEL },
      { path: `${HOST}|${WEB}|${EXTENSION}|${BRIDGE}|${TEST_KIT}` },
    ),
    rule(
      'host-implements-the-panel-port',
      'a host adapter implements the panel’s port (host.ts, diff-types.ts): not the composition root or a region',
      { path: HOST },
      {
        path: PANEL,
        pathNot: '^packages/panel/src/(host|diff-types)\\.ts$',
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
      'schemas.ts imports valibot, which no page or extension loads: only the server and the protocol itself import it',
      { path: `${WEB}|${EXTENSION}|${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}` },
      { path: '^packages/protocol/src/schemas\\.ts$' },
    ),
    rule(
      'pages-are-an-app',
      'the pages are an app: nothing imports them, and they do not import the extension or the server',
      {
        path: `${PANEL}|${HOST}|${API_CLIENT}|${UI_PKG}|${PROTOCOL}|${BRIDGE}|${EXTENSION}|${TEST_KIT}`,
      },
      { path: WEB, pathNot: '^packages/web/public/(vendor|types)/' },
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
      'the extension meets the server over HTTP, not by import',
      { path: EXTENSION },
      { path: `${BRIDGE}|${WEB}` },
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
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '/vendor/|\\.d\\.m?ts$|^packages/panel/types/|^packages/web/public/types/' },
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mjs', '.js', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
