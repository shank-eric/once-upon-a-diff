/*
 * Package boundaries, enforced by `yarn lint` (eslint.config.mjs spreads this in last).
 *
 * The layer map (ADR-15): apps know their host and nothing imports them; features
 * don't import each other; client and server meet only at the protocol; Node
 * built-ins stay out of anything that ships to the browser.
 *
 * Today's packages and where they sit:
 *   packages/bridge/src      server (Node), in four layers (below the apps, an app imports only what is below it):
 *     server/                the HTTP app, and server/routes/ (over the services; node:http only outside the routes)
 *     cli/                   the CLI app (over the services, in process)
 *     services/              the rules and the stores' use: stories, inbox, sessions, listeners, backlog, worktrees, voice,
 *                            review, board (over the adapters; no programs, no fs writes, no network of their own)
 *     adapters/              every side effect, one module per outside system: github (gh), git, iterm (it2), larmor,
 *                            claude-sessions, stores (JSON files, atomic writes, backlog.jsonl, the ledger and notes
 *                            reads), os (programs, pids, ports, the browser). The only place that may run a program,
 *                            write a file or reach the network
 *   packages/web/public      the board and local pages (browser app). public/board/ holds the board page's regions, each a folder
 *                            (header, columns, backlog, worktrees, voice) that imports no other region, only board/shared.ts and the
 *                            helpers (local/, util, the protocol); board.ts, over them, is the page
 *   packages/panel/src       the story panel (browser, host-agnostic): imports the protocol only, never an app, the bridge or the
 *                            host adapters. overlay.ts composes it; its regions are folders (ask, drafts, fixes, reading,
 *                            rebuild) that import no other region and not overlay.ts, only the panel's shared files (context,
 *                            host, bridge-options, shell, dom, ...)
 *   packages/host-github/src the host adapter for GitHub (browser): the diff-page reader and the URL routing, which the extension
 *                            and the local page inject into the panel. It implements the panel's port (host.ts, diff-types.ts),
 *                            so it imports the panel's port files, never overlay.ts or a region. The panel never imports it
 *   packages/api-client/src  the typed client over a host's transport and the poll (browser): imports the protocol's route table and
 *                            nothing else of this repo, and no page URL but /assets/preact.mjs (use-poll.ts is a Preact hook, so only a page
 *                            loads it, and only it names /assets/preact.mjs). The panel, the pages and the extension import it; the server and the protocol never do
 *   packages/protocol/src    the wire types, route table and schemas (no DOM, no Node, imports no package but valibot)
 *   packages/protocol/src/domain  pure rules: imports nothing at all (the helpers the bridge, the pages and the panel share)
 *   packages/extension/src   the Chrome extension (app)
 *   packages/test-kit/src    dev-only test helpers (temp files, git repos, story fixtures, a DOM): imports Node and linkedom only, and
 *                            only tests import it. Every layer above bans it, so nothing that ships can reach it
 * Tests, scripts and config files are Node and cross packages on purpose, so no layer
 * names them. packages/bridge/test/boundary-lint.test.ts probes every rule below.
 *
 * Every layer is one entry in LAYERS, and each entry turns into one ESLint block. ESLint
 * REPLACES a rule's options when a later block matches the same file, it does not merge
 * them, so two blocks over the same files would silently drop the first one's rules.
 * That is why the lists below are built once and shared:
 *
 *   - Each restriction is named once (a const below) and layers list the ones they want.
 *   - A layer nested inside another (the domain inside the protocol) is carved out of the
 *     parent's `files` with `ignores`, so no file matches two blocks.
 *
 * To add a layer (panel, board-view, ui, web, board-core):
 *   1. Add a `files` glob and an entry to LAYERS (see FUTURE at the bottom).
 *   2. List what it must not reach in `paths` (folders, resolved after relative imports)
 *      and `specifiers` (package names and URL paths as written in the import).
 *   3. Set `browser: true` when it ships to the browser: Node built-ins are then banned.
 *   4. If it overlaps an existing layer, extend that layer's lists and add the new files
 *      to the parent's `ignores`. Do not write a second block over the same files.
 *   5. Add a case to the probe test, one that must fire and one that must pass.
 *
 * Three mechanisms, because ESLint sees a specifier, not a package:
 *   - import/no-restricted-paths resolves the file a relative import lands on.
 *   - no-restricted-imports matches the specifier of a static package import.
 *   - no-restricted-syntax matches the same specifiers in a dynamic `import('...')` and in a
 *     type-position `import('...')`, which no-restricted-imports does not look at.
 *   - import/no-nodejs-modules bans Node built-ins, `node:` or bare, in browser code.
 */

// specifiers, as regular expression sources (the bridge's package is named once-upon-a-diff)
const BRIDGE = {
  regex: '^once-upon-a-diff(/|$)',
  message: 'the bridge is server code: only the server and Node tests import it',
};
const EXTENSION = {
  regex: '^@once-upon-a-diff/extension(/|$)',
  message: 'the extension is an app: nothing imports an app',
};
const WEB = {
  regex: '^@once-upon-a-diff/web(/|$)',
  message: 'the pages are an app: nothing imports an app',
};
const PANEL = {
  regex: '^@once-upon-a-diff/panel(/|$)',
  message:
    'the panel is client code above the protocol: only the apps, the host adapters (for its port) and tests import it',
};
const API_CLIENT = {
  regex: '^@once-upon-a-diff/api-client(/|$)',
  message:
    'the api-client is client code above the protocol: only the panel, the pages, the extension and tests import it',
};
// the Preact hook (use-poll.ts) is a page's: nothing that is bundled into the extension or shared with the panel loads it
const USE_POLL = {
  regex: '^@once-upon-a-diff/api-client/use-poll(\\.ts)?$',
  message:
    'use-poll.ts is a Preact hook, which only a page loads (it imports /assets/preact.mjs): the panel, the extension and host adapters use poll.ts',
};
const NOT_THE_USE_POLL = {
  from: './packages/api-client/src/use-poll.ts',
  message: USE_POLL.message,
};
// a URL on the pages' side: the vendored Preact (/assets/preact.mjs) is the one the hook may name, and the client and poll name none
const PAGE_URL = {
  regex: '^/assets/(?!preact\\.mjs$)',
  message:
    'the api-client sits below the pages: its hook names the vendored Preact (/assets/preact.mjs) and packages, never a page module',
};
const ANY_PAGE_URL = {
  regex: '^/assets/',
  message:
    'client.ts and poll.ts are shared with the panel and the extension: only use-poll.ts (a page’s hook) names /assets/ URLs, and only the vendored Preact',
};
const HOST_ADAPTERS = {
  regex: '^@once-upon-a-diff/host-github(/|$)',
  message:
    'the panel is host-agnostic: it is handed a host adapter (packages/panel/src/host.ts), never imports one',
};
const HOST_PACKAGE = {
  regex: '^@once-upon-a-diff/host-github(/|$)',
  message:
    'a host adapter implements the panel’s port: the server, the protocol and the panel never import one, only the apps',
};
const PANEL_COMPOSITION = {
  regex: '^@once-upon-a-diff/panel/(overlay|ask|drafts|fixes|reading|rebuild)(/|$)',
  message:
    'a host adapter implements the panel’s port (host.ts, diff-types.ts): it never imports the composition root or a region',
};
const BOARD_PAGE_URL = {
  regex: '^/assets/board\\.ts$',
  message: 'board.ts is the page over its regions: a region does not import it',
};
const NOT_THE_SCHEMAS_MESSAGE =
  'schemas.ts is server side: it imports valibot, which no page or extension loads (routes.ts takes its types with import type)';
const SCHEMAS = {
  regex: '^(@once-upon-a-diff/protocol|/assets/protocol)/schemas(\\.ts)?$',
  message: NOT_THE_SCHEMAS_MESSAGE,
};
// any bare or absolute specifier but valibot (the protocol's one dependency); relative ones stay inside the package
const PROTOCOL_IMPORTS = {
  regex: '^(?!valibot$)[^.]',
  message: 'protocol imports nothing but itself and valibot',
};
const NOTHING = {
  regex: '.',
  message:
    'the domain imports nothing, not even the rest of the protocol (the protocol imports the domain)',
};
const TEST_KIT = {
  regex: '^@once-upon-a-diff/test-kit(/|$)',
  message: 'the test kit is dev-only: tests import it, nothing that ships does',
};
const ASSET_URL = {
  regex: '^/assets/',
  message:
    'host-github is served at /assets/ for the pages, so it must not import through that URL: it names packages',
};

// folders, from the repo root
const BRIDGE_SRC = './packages/bridge/src';
const WEB_PUBLIC = './packages/web/public';
const HOST_GITHUB_SRC = './packages/host-github/src';
const API_CLIENT_SRC = './packages/api-client/src';
const PANEL_SRC = './packages/panel/src';
const PANEL_OVERLAY = './packages/panel/src/overlay.ts';
const WEB_BOARD = './packages/web/public/board';
const WEB_BOARD_PAGE = './packages/web/public/board.ts';
const EXTENSION_SRC = './packages/extension/src';
const TEST_KIT_SRC = './packages/test-kit/src';
const PROTOCOL_SRC = './packages/protocol/src';
const PROTOCOL_DOMAIN = './packages/protocol/src/domain';

// restrictions (a `from` folder with the reason it is off limits)
// what only an adapter may do (the services, the apps and the routes go through one)
const NO_CHILD_PROCESS = {
  regex: '^(node:)?child_process$',
  message:
    'only an adapter runs programs: add a function to adapters/os.ts (or the adapter for that tool)',
};
const NO_NETWORK = {
  regex: '^(node:)?(net|https?|http2|dgram|tls|dns(/promises)?)$',
  message:
    'only an adapter touches the network: add a function to adapters/os.ts (or the adapter for that service)',
};
// the HTTP app listens, so it has node:http, and nothing else on the network
const NO_NETWORK_BUT_HTTP = {
  regex: '^(node:)?(net|https|http2|dgram|tls|dns(/promises)?)$',
  message: 'only an adapter touches the network (the HTTP app has node:http, to listen)',
};
// threads and code evaluation: another way to reach child_process, the network or a file write without naming it
const NO_ESCAPE_HATCH = {
  regex: '^(node:)?(worker_threads|vm)$',
  message:
    'only an adapter may start threads or evaluate code: add a function to the adapter that needs it',
};
// node:module may be imported for what only reads (stripTypeScriptTypes), but not to load a module by name
const MODULE_MODULES = '^(node:)?module$';
const MODULE_LOADERS = ['createRequire', 'register', 'registerHooks', 'Module'];
const MODULE_MESSAGE =
  'only an adapter loads modules by name (createRequire, register, hooks): import the one function you need, by name, from node:module';
const NETWORK_MESSAGE =
  'only an adapter touches the network: add a function to adapters/os.ts (or the adapter for that service)';
const NOT_FETCH = { name: 'fetch', message: NETWORK_MESSAGE };
// the global object spells the same things without the bare name
const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
const NOT_GLOBAL_FETCH = GLOBAL_OBJECTS.map((object) => ({
  object,
  property: 'fetch',
  message: NETWORK_MESSAGE,
}));
const NOT_PROCESS_KILL = {
  object: 'process',
  property: 'kill',
  message: 'only an adapter signals a process: add a function to adapters/os.ts',
};
// node:fs and node:fs/promises, whole: the names that change a file or folder (reads are fine)
const FS_MODULES = '^(node:)?fs(/promises)?$';
const FS_WRITES = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'utimes',
  'utimesSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'truncate',
  'truncateSync',
  'createWriteStream',
  'promises',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'ftruncate',
  'ftruncateSync',
  'fchmod',
  'fchmodSync',
  'fchown',
  'fchownSync',
  'lchown',
  'lchownSync',
  'futimes',
  'futimesSync',
  'lutimes',
  'lutimesSync',
];
// open and openSync stay importable (a read needs a descriptor), but the flag decides: only the literal 'r' is a read
const FS_OPEN_MESSAGE =
  "open and openSync outside an adapter must pass the literal flag 'r' and be imported without an alias: a write goes through adapters/stores/";
const FS_WRITE_MESSAGE =
  'only an adapter writes files: add a function to adapters/stores/ (files.ts, json-file.ts) and call that';
const FS_NAMESPACE_MESSAGE =
  'import the read functions by name from node:fs: a whole-module import hides the write calls from the lint rule';
const NOT_THE_PAGES = { from: WEB_PUBLIC, message: 'the pages are an app: nothing imports them' };
const NOT_THE_EXTENSION = { from: EXTENSION_SRC, message: 'nothing imports an app' };
const NOT_THE_SERVER = {
  from: BRIDGE_SRC,
  message: 'the pages, the panel and the extension meet the server over HTTP, not by import',
};
const NOT_THE_TEST_KIT = {
  from: './packages/test-kit',
  message: 'the test kit is dev-only: tests import it, nothing that ships does',
};
const NOT_THE_API_CLIENT = {
  from: './packages/api-client',
  message:
    'the api-client is client code above the protocol: the server, the protocol and the test kit never import it',
};
const NOT_THE_BRIDGE = { from: './packages/bridge', message: 'the panel sits below the bridge' };
const NOT_THE_BRIDGE_PACKAGE = {
  from: './packages/bridge',
  message: 'the protocol sits below the bridge',
};
const NOT_THE_HOST_PACKAGE = {
  from: HOST_GITHUB_SRC,
  message:
    'a host adapter implements the panel’s port: the server, the protocol and the panel never import one, only the apps',
};
const NOT_THE_SCHEMAS = {
  from: './packages/protocol/src/schemas.ts',
  message: NOT_THE_SCHEMAS_MESSAGE,
};
const BRIDGE_ADAPTERS = './packages/bridge/src/adapters';
const BRIDGE_SERVICES = './packages/bridge/src/services';
const BRIDGE_HTTP = './packages/bridge/src/server';
const BRIDGE_CLI = './packages/bridge/src/cli';
const NOT_THE_ADAPTERS = {
  from: BRIDGE_ADAPTERS,
  message: 'the apps and routes go through the services, and only the services call an adapter',
};
const NOT_THE_SERVICES = { from: BRIDGE_SERVICES, message: 'the adapters sit below the services' };
const NOT_THE_HTTP_APP = {
  from: BRIDGE_HTTP,
  message: 'the HTTP app is on top: the services, the adapters and the CLI never import it',
};
const NOT_THE_CLI_APP = {
  from: BRIDGE_CLI,
  message: 'the CLI is an app: the services, the adapters and the HTTP app never import it',
};
const NOT_THE_PANEL_PACKAGE = {
  from: PANEL_SRC,
  message:
    'the panel is client code above the protocol: only the apps, the host adapters (for its port) and tests import it',
};
const NOT_THE_HOST_ADAPTERS = {
  from: HOST_GITHUB_SRC,
  message:
    'the panel is host-agnostic: it is handed a host adapter (packages/panel/src/host.ts), never imports one',
};
const NOT_THE_OVERLAY = {
  from: PANEL_OVERLAY,
  message: 'overlay.ts composes the regions: a region does not import the composition root',
};
const NOT_THE_BOARD_PAGE = {
  from: WEB_BOARD_PAGE,
  message: 'board.ts is the page over its regions: a region does not import it',
};

const KIT_BELOW =
  'the test kit sits below every package: it imports Node and linkedom, so any package can import it in a test';

// the panel: browser code that names no host, no app and no server
const PANEL_BASE = {
  paths: [
    NOT_THE_BRIDGE,
    NOT_THE_PAGES,
    NOT_THE_EXTENSION,
    NOT_THE_HOST_ADAPTERS,
    NOT_THE_SCHEMAS,
    NOT_THE_USE_POLL,
    NOT_THE_TEST_KIT,
  ],
  specifiers: [BRIDGE, EXTENSION, WEB, HOST_ADAPTERS, SCHEMAS, USE_POLL, TEST_KIT],
};

// what a page region must not reach: the page above it, and the apps, server and schemas every page avoids
const PAGES = {
  paths: [NOT_THE_SERVER, NOT_THE_SCHEMAS, NOT_THE_TEST_KIT],
  specifiers: [BRIDGE, EXTENSION, SCHEMAS, TEST_KIT],
};

/**
 * Regions: sibling folders of one feature that do not import each other. `siblings` is every region's folder name, `urls` the
 * /assets/ prefix a page module spells its imports with (the panel names its own by relative path or package).
 * A region's block carries its layer's base lists and bans the other regions by path (relative imports) and by specifier.
 */
const regionLayers = ({
  prefix,
  root,
  names,
  base,
  urls,
  noCompositionRoot = [],
  noRootSpecifiers = [],
}) =>
  names.map((name) => {
    const others = names.filter((other) => other !== name);
    const alternation = others.join('|');
    const message = `regions do not import each other: ${name} takes what it shares from the feature's shared files, and the page or panel composes the regions`;
    return {
      name: `${prefix}-region-${name}`,
      files: [`${root.slice(2)}/${name}/**/*.ts`],
      targets: [`${root}/${name}`],
      paths: [
        ...base.paths,
        ...noCompositionRoot,
        ...others.map((other) => ({ from: `${root}/${other}`, message })),
      ],
      specifiers: [
        ...base.specifiers,
        ...noRootSpecifiers,
        ...(others.length
          ? urls.map((url) => ({ regex: `^${url}/(${alternation})(/|$)`, message }))
          : []),
      ],
      browser: true,
    };
  });
const PANEL_REGIONS = ['ask', 'drafts', 'fixes', 'reading', 'rebuild'];
const BOARD_REGIONS = ['header', 'columns', 'backlog', 'worktrees', 'voice'];

// a host adapter (host-github): it implements the panel's port, so it sees the panel's port files and nothing of the panel's
// composition (overlay.ts and the regions), the apps, the server or the schemas
const HOST_ADAPTER = {
  paths: [
    NOT_THE_BRIDGE,
    NOT_THE_PAGES,
    NOT_THE_EXTENSION,
    NOT_THE_SCHEMAS,
    NOT_THE_USE_POLL,
    NOT_THE_TEST_KIT,
    { from: PANEL_OVERLAY, message: PANEL_COMPOSITION.message },
    ...PANEL_REGIONS.map((region) => ({
      from: `${PANEL_SRC}/${region}`,
      message: PANEL_COMPOSITION.message,
    })),
  ],
  specifiers: [BRIDGE, EXTENSION, WEB, PANEL_COMPOSITION, ASSET_URL, SCHEMAS, USE_POLL, TEST_KIT],
};

// what every server layer must not reach, whatever its place in the stack
const SERVER = {
  paths: [
    NOT_THE_PAGES,
    NOT_THE_EXTENSION,
    NOT_THE_PANEL_PACKAGE,
    NOT_THE_HOST_PACKAGE,
    NOT_THE_API_CLIENT,
    NOT_THE_TEST_KIT,
  ],
  specifiers: [EXTENSION, PANEL, HOST_PACKAGE, API_CLIENT, TEST_KIT],
};

// what the api-client may not reach, whichever of its files: the server, the apps, the host adapters, the panel, the schemas
const API_CLIENT_PATHS = [
  NOT_THE_SERVER,
  NOT_THE_PAGES,
  NOT_THE_EXTENSION,
  NOT_THE_HOST_PACKAGE,
  NOT_THE_PANEL_PACKAGE,
  NOT_THE_SCHEMAS,
  NOT_THE_TEST_KIT,
];
const API_CLIENT_SPECIFIERS = [BRIDGE, EXTENSION, WEB, PANEL, HOST_PACKAGE, SCHEMAS, TEST_KIT];

const LAYERS = [
  {
    // every side effect: one module per outside system. It is the one layer that may run programs, write files and reach
    // the network, and it knows nothing of the services above it.
    name: 'adapters',
    files: ['packages/bridge/src/adapters/**/*.ts'],
    targets: [BRIDGE_ADAPTERS],
    paths: [...SERVER.paths, NOT_THE_SERVICES, NOT_THE_HTTP_APP, NOT_THE_CLI_APP],
    specifiers: [...SERVER.specifiers],
  },
  {
    // the rules, over the adapters: no program, no file write and no network of their own
    name: 'services',
    files: ['packages/bridge/src/services/**/*.ts'],
    targets: [BRIDGE_SERVICES],
    paths: [...SERVER.paths, NOT_THE_HTTP_APP, NOT_THE_CLI_APP],
    specifiers: [...SERVER.specifiers, NO_CHILD_PROCESS, NO_NETWORK, NO_ESCAPE_HATCH],
    fsWrites: true,
    globals: [NOT_FETCH],
    properties: [...NOT_GLOBAL_FETCH, NOT_PROCESS_KILL],
  },
  {
    // the HTTP app, over the services only
    name: 'http',
    files: ['packages/bridge/src/server/**/*.ts'],
    ignores: ['packages/bridge/src/server/routes/**'],
    targets: [BRIDGE_HTTP],
    paths: [...SERVER.paths, NOT_THE_ADAPTERS, NOT_THE_CLI_APP],
    specifiers: [...SERVER.specifiers, NO_CHILD_PROCESS, NO_NETWORK_BUT_HTTP, NO_ESCAPE_HATCH],
    fsWrites: true,
    globals: [NOT_FETCH],
    properties: [...NOT_GLOBAL_FETCH, NOT_PROCESS_KILL],
  },
  {
    // the routes: the HTTP app's own handlers, which never touch node:http either (they get a Call)
    name: 'http-routes',
    files: ['packages/bridge/src/server/routes/**/*.ts'],
    targets: [BRIDGE_HTTP + '/routes'],
    paths: [...SERVER.paths, NOT_THE_ADAPTERS, NOT_THE_CLI_APP],
    specifiers: [...SERVER.specifiers, NO_CHILD_PROCESS, NO_NETWORK, NO_ESCAPE_HATCH],
    fsWrites: true,
    globals: [NOT_FETCH],
    properties: [...NOT_GLOBAL_FETCH, NOT_PROCESS_KILL],
  },
  {
    // the CLI app, over the services only (the entry point, bin/once-upon.ts, is the one place that knows both apps)
    name: 'cli',
    files: ['packages/bridge/src/cli/**/*.ts'],
    targets: [BRIDGE_CLI],
    paths: [...SERVER.paths, NOT_THE_ADAPTERS, NOT_THE_HTTP_APP],
    specifiers: [...SERVER.specifiers, NO_CHILD_PROCESS, NO_NETWORK, NO_ESCAPE_HATCH],
    fsWrites: true,
    globals: [NOT_FETCH],
    properties: [...NOT_GLOBAL_FETCH, NOT_PROCESS_KILL],
  },
  {
    // the bridge's entry points (bin/once-upon.ts knows both apps, so it sits over them): the same reach as the server layers, so nothing
    // that ships imports the client packages or the test kit from here
    name: 'bridge-bin',
    files: ['packages/bridge/bin/**/*.{ts,mjs}'],
    targets: ['./packages/bridge/bin'],
    paths: [...SERVER.paths],
    specifiers: [...SERVER.specifiers],
  },
  {
    // the pages (the web app): the board's regions and shared file are carved out below, each with its own block
    name: 'pages',
    files: ['packages/web/public/**/*.ts'],
    ignores: [
      'packages/web/public/vendor/**',
      'packages/web/public/board/shared.ts',
      'packages/web/public/board/worktree-text.ts',
      ...BOARD_REGIONS.map((region) => `packages/web/public/board/${region}/**`),
    ],
    targets: [WEB_PUBLIC],
    ...PAGES,
    browser: true,
  },
  {
    // what the board's regions share (the helpers two of them draw with, and worktree-text): below the regions, which import it
    name: 'web-board-shared',
    files: ['packages/web/public/board/shared.ts', 'packages/web/public/board/worktree-text.ts'],
    targets: [`${WEB_BOARD}/shared.ts`, `${WEB_BOARD}/worktree-text.ts`],
    paths: [
      ...PAGES.paths,
      NOT_THE_BOARD_PAGE,
      ...BOARD_REGIONS.map((region) => ({
        from: `${WEB_BOARD}/${region}`,
        message: 'board/shared.ts sits below the regions, which import it',
      })),
    ],
    specifiers: [
      ...PAGES.specifiers,
      BOARD_PAGE_URL,
      {
        regex: `^/assets/board/(${BOARD_REGIONS.join('|')})(/|$)`,
        message: 'board/shared.ts sits below the regions, which import it',
      },
    ],
    browser: true,
  },
  ...regionLayers({
    prefix: 'web-board',
    root: WEB_BOARD,
    names: BOARD_REGIONS,
    base: PAGES,
    urls: ['/assets/board'],
    noCompositionRoot: [NOT_THE_BOARD_PAGE],
    noRootSpecifiers: [BOARD_PAGE_URL],
  }),
  {
    // the api-client's client and poll: shared with the panel and the extension, so no page URL at all, not even Preact
    name: 'api-client',
    files: ['packages/api-client/src/**/*.ts'],
    ignores: ['packages/api-client/src/use-poll.ts'],
    targets: [API_CLIENT_SRC],
    paths: API_CLIENT_PATHS,
    specifiers: [...API_CLIENT_SPECIFIERS, ANY_PAGE_URL],
    browser: true,
  },
  {
    // the api-client's hook: a Preact hook for a page, so it names /assets/preact.mjs (and no other page URL)
    name: 'api-client-hook',
    files: ['packages/api-client/src/use-poll.ts'],
    targets: ['./packages/api-client/src/use-poll.ts'],
    paths: API_CLIENT_PATHS,
    specifiers: [...API_CLIENT_SPECIFIERS, PAGE_URL],
    browser: true,
  },
  {
    // the protocol: types, the route table and the schemas. It reaches no other package.
    name: 'protocol',
    files: ['packages/protocol/src/**/*.ts'],
    ignores: ['packages/protocol/src/domain/**'],
    targets: [PROTOCOL_SRC],
    paths: [
      NOT_THE_BRIDGE_PACKAGE,
      NOT_THE_HOST_PACKAGE,
      NOT_THE_EXTENSION,
      NOT_THE_PAGES,
      NOT_THE_PANEL_PACKAGE,
      NOT_THE_API_CLIENT,
      NOT_THE_TEST_KIT,
    ],
    specifiers: [PROTOCOL_IMPORTS],
    browser: true,
  },
  {
    // the domain is a layer of its own inside the protocol: pure rules that import nothing, relative paths included
    name: 'domain',
    files: ['packages/protocol/src/domain/**/*.ts'],
    targets: [PROTOCOL_DOMAIN],
    paths: [{ from: './packages', message: NOTHING.message }],
    specifiers: [NOTHING],
    browser: true,
  },
  {
    // the host adapter for GitHub (the diff-page reader and the URL routing): the apps inject it into the panel, which never imports it
    name: 'host-github',
    files: ['packages/host-github/src/**/*.ts'],
    targets: [HOST_GITHUB_SRC],
    ...HOST_ADAPTER,
    browser: true,
  },
  {
    // the panel's own files (host.ts, bridge-options.ts, context.ts, shell.ts...) and its composition root, overlay.ts; the regions are carved out
    name: 'panel',
    files: ['packages/panel/src/**/*.ts', 'packages/panel/types/**/*.ts'],
    ignores: PANEL_REGIONS.map((region) => `packages/panel/src/${region}/**`),
    targets: [PANEL_SRC, './packages/panel/types'],
    ...PANEL_BASE,
    browser: true,
  },
  ...regionLayers({
    prefix: 'panel',
    root: PANEL_SRC,
    names: PANEL_REGIONS,
    base: PANEL_BASE,
    urls: ['@once-upon-a-diff/panel'],
    noCompositionRoot: [NOT_THE_OVERLAY],
    noRootSpecifiers: [
      {
        regex: '^@once-upon-a-diff/panel/overlay$',
        message: NOT_THE_OVERLAY.message,
      },
    ],
  }),
  {
    name: 'extension',
    files: ['packages/extension/src/**/*.ts'],
    targets: [EXTENSION_SRC],
    paths: [NOT_THE_SERVER, NOT_THE_SCHEMAS, NOT_THE_USE_POLL, NOT_THE_TEST_KIT],
    specifiers: [BRIDGE, SCHEMAS, USE_POLL, TEST_KIT],
    browser: true,
  },
  {
    // the test kit: below everything, it imports Node and linkedom and no package of this repo (tests import it, nothing that ships does)
    name: 'test-kit',
    files: ['packages/test-kit/src/**/*.ts'],
    targets: [TEST_KIT_SRC],
    paths: [
      { from: './packages/bridge', message: KIT_BELOW },
      { from: './packages/web', message: KIT_BELOW },
      { from: './packages/extension', message: KIT_BELOW },
      { from: './packages/panel', message: KIT_BELOW },
      { from: HOST_GITHUB_SRC, message: KIT_BELOW },
      { from: './packages/protocol', message: KIT_BELOW },
      { from: './packages/api-client', message: KIT_BELOW },
    ],
    specifiers: [
      { regex: '^(once-upon-a-diff(/|$)|@once-upon-a-diff/(?!test-kit(/|$)))', message: KIT_BELOW },
    ],
  },
];

/*
 * Layers still to come, written the way they will read. Move each into LAYERS as its split lands, and keep the probe test in step.
 *
 *   board-view: the board page as its own package, over ui and the api-client (its regions are already folders: web/public/board/).
 *   ui:         files packages/ui/src/**. paths: panel, board-view, web, extension. browser: true.
 *   board-core: files packages/board-core/src/**. paths: web, extension, panel, board-view, ui. Not a package yet: it is
 *               packages/bridge/src/services/board, which still imports about thirty modules of the other services and
 *               the adapters by path. It becomes a package when those arrive as interfaces the bridge passes in.
 */

const escapeSlashes = (source) => source.replaceAll('/', '\\/');

const layerBlock = ({
  files,
  ignores = [],
  targets,
  paths,
  specifiers,
  browser = false,
  fsWrites = false,
  globals = [],
  properties = [],
}) => {
  const syntax = specifiers.flatMap(({ regex, message }) => {
    const pattern = `/${escapeSlashes(regex)}/`;
    return [
      { selector: `ImportExpression[source.value=${pattern}]`, message },
      { selector: `TSImportType[argument.literal.value=${pattern}]`, message },
    ];
  });
  // node:fs may be imported for its reads, by name; the names that write, and a whole-module import, are refused
  const fsPaths = fsWrites
    ? ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].map((name) => ({
        name,
        importNames: FS_WRITES,
        message: FS_WRITE_MESSAGE,
      }))
    : [];
  const modulePaths = fsWrites
    ? ['node:module', 'module'].map((name) => ({
        name,
        importNames: MODULE_LOADERS,
        message: MODULE_MESSAGE,
      }))
    : [];
  const fsSyntax = fsWrites
    ? [
        ...['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].map((kind) => ({
          selector: `ImportDeclaration[source.value=/${escapeSlashes(MODULE_MODULES)}/] > ${kind}`,
          message: MODULE_MESSAGE,
        })),
        {
          selector: `ImportExpression[source.value=/${escapeSlashes(MODULE_MODULES)}/]`,
          message: MODULE_MESSAGE,
        },
        {
          selector: `ImportDeclaration[source.value=/${escapeSlashes(FS_MODULES)}/] > ImportDefaultSpecifier`,
          message: FS_NAMESPACE_MESSAGE,
        },
        {
          selector: `ImportDeclaration[source.value=/${escapeSlashes(FS_MODULES)}/] > ImportNamespaceSpecifier`,
          message: FS_NAMESPACE_MESSAGE,
        },
        {
          selector: `ImportExpression[source.value=/${escapeSlashes(FS_MODULES)}/]`,
          message: FS_NAMESPACE_MESSAGE,
        },
        // open and openSync: only the read flag, and no alias that would hide the call from the next selector
        {
          selector: `CallExpression[callee.name=/^(open|openSync)$/]:not([arguments.1.value='r'])`,
          message: FS_OPEN_MESSAGE,
        },
        {
          selector: `ImportDeclaration[source.value=/${escapeSlashes(FS_MODULES)}/] > ImportSpecifier[imported.name=/^(open|openSync)$/][local.name!=/^(open|openSync)$/]`,
          message: FS_OPEN_MESSAGE,
        },
      ]
    : [];
  return {
    files,
    ignores,
    rules: {
      'no-restricted-globals': globals.length ? ['error', ...globals] : 'off',
      'no-restricted-properties': properties.length ? ['error', ...properties] : 'off',
      'import/no-restricted-paths': [
        'error',
        {
          // folders resolve from the repo root, wherever eslint was started
          basePath: import.meta.dirname,
          zones: targets.flatMap((target) =>
            paths.map(({ from, message }) => ({ target, from, message })),
          ),
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [...fsPaths, ...modulePaths],
          patterns: specifiers.map(({ regex, message }) => ({ regex, message })),
        },
      ],
      'no-restricted-syntax': ['error', ...syntax, ...fsSyntax],
      'import/no-nodejs-modules': browser ? 'error' : 'off',
    },
  };
};

export default LAYERS.map(layerBlock);
