/*
 * Package boundaries, enforced by `yarn lint` (eslint.config.mjs spreads this in last).
 *
 * The layer map (ADR-15): apps know their host and nothing imports them; features
 * don't import each other; client and server meet only at the protocol; Node
 * built-ins stay out of anything that ships to the browser.
 *
 * Today's packages and where they sit:
 *   packages/bridge/src      server (Node)
 *   packages/bridge/public   the board and local pages (browser, will become apps/web)
 *   packages/shared          the panel and its helpers (browser-safe)
 *   packages/protocol/src    the wire types, route table and schemas (no DOM, no Node, imports no package but valibot)
 *   packages/protocol/src/domain  pure rules: imports nothing at all
 *   packages/extension/src   the Chrome extension (app)
 * Tests, scripts and config files are Node and cross packages on purpose, so no layer
 * names them. packages/bridge/test/boundary-lint.test.ts probes every rule below.
 *
 * Every layer is one entry in LAYERS, and each entry turns into one ESLint block. ESLint
 * REPLACES a rule's options when a later block matches the same file, it does not merge
 * them, so two blocks over the same files would silently drop the first one's rules.
 * That is why the lists below are built once and shared:
 *
 *   - Each restriction is named once (a const below) and layers list the ones they want.
 *   - A layer nested inside another (shared/util inside shared) extends its parent's
 *     lists with `...PARENT.paths`, and its files are carved out of the parent's `files`
 *     with `ignores`, so no file matches two blocks.
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
const SHARED_PACKAGE = {
  regex: '^@once-upon-a-diff/shared(/|$)',
  message:
    'inside packages/shared, imports stay relative (the local page loads those files into the browser)',
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
const ASSET_URL = {
  regex: '^/assets/',
  message: 'shared is served at /assets/ for the pages, so it must not import through that URL',
};

// folders, from the repo root
const BRIDGE_SRC = './packages/bridge/src';
const BRIDGE_PUBLIC = './packages/bridge/public';
const SHARED_UTIL = './packages/shared/src/util';
const SHARED_PANEL = './packages/shared/src/panel';
const EXTENSION_SRC = './packages/extension/src';
const PROTOCOL_SRC = './packages/protocol/src';
const PROTOCOL_DOMAIN = './packages/protocol/src/domain';

// restrictions (a `from` folder with the reason it is off limits)
const NOT_THE_PAGES = { from: BRIDGE_PUBLIC, message: 'the server does not import the pages' };
const NOT_THE_EXTENSION = { from: EXTENSION_SRC, message: 'nothing imports an app' };
const NOT_THE_SERVER = {
  from: BRIDGE_SRC,
  message: 'the pages, shared and the extension meet the server over HTTP, not by import',
};
const NOT_THE_BRIDGE = { from: './packages/bridge', message: 'shared sits below the bridge' };
const NOT_THE_BRIDGE_PACKAGE = {
  from: './packages/bridge',
  message: 'the protocol sits below the bridge',
};
const NOT_THE_SHARED_PACKAGE = {
  from: './packages/shared',
  message: 'the protocol sits below shared',
};
const NOT_THE_SCHEMAS = {
  from: './packages/protocol/src/schemas.ts',
  message: NOT_THE_SCHEMAS_MESSAGE,
};
const NOT_THE_PANEL = { from: SHARED_PANEL, message: 'shared/util is below shared/panel' };

const SHARED = {
  paths: [NOT_THE_BRIDGE, NOT_THE_EXTENSION, NOT_THE_SCHEMAS],
  specifiers: [BRIDGE, EXTENSION, SHARED_PACKAGE, ASSET_URL, SCHEMAS],
};

const LAYERS = [
  {
    name: 'server',
    files: ['packages/bridge/src/**/*.ts'],
    targets: [BRIDGE_SRC],
    paths: [NOT_THE_PAGES, NOT_THE_EXTENSION],
    specifiers: [EXTENSION],
  },
  {
    name: 'pages',
    files: ['packages/bridge/public/**/*.ts'],
    ignores: ['packages/bridge/public/vendor/**'],
    targets: [BRIDGE_PUBLIC],
    paths: [NOT_THE_SERVER, NOT_THE_SCHEMAS],
    specifiers: [BRIDGE, EXTENSION, SCHEMAS],
    browser: true,
  },
  {
    // the protocol: types, the route table, the schemas and the typed client. It reaches no other package.
    name: 'protocol',
    files: ['packages/protocol/src/**/*.ts'],
    ignores: ['packages/protocol/src/domain/**'],
    targets: [PROTOCOL_SRC],
    paths: [NOT_THE_BRIDGE_PACKAGE, NOT_THE_SHARED_PACKAGE, NOT_THE_EXTENSION],
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
    // shared/util is a layer of its own inside shared: it extends shared's lists and adds the panel
    name: 'shared-util',
    files: ['packages/shared/src/util/**/*.ts'],
    targets: [SHARED_UTIL],
    paths: [...SHARED.paths, NOT_THE_PANEL],
    specifiers: [...SHARED.specifiers],
    browser: true,
  },
  {
    name: 'shared',
    files: ['packages/shared/src/**/*.ts', 'packages/shared/types/**/*.ts'],
    ignores: ['packages/shared/src/util/**'],
    targets: ['./packages/shared/src', './packages/shared/types'],
    ...SHARED,
    browser: true,
  },
  {
    name: 'extension',
    files: ['packages/extension/src/**/*.ts'],
    targets: [EXTENSION_SRC],
    paths: [NOT_THE_SERVER, NOT_THE_SCHEMAS],
    specifiers: [BRIDGE, SCHEMAS],
    browser: true,
  },
];

/*
 * Layers still to come, written the way they will read. Move each into LAYERS as its split
 * lands, and keep the probe test in step.
 *
 *   panel:      files packages/panel/src/**. paths: web, extension, board-view. browser: true.
 *   board-view: files packages/board-view/src/**. paths: web, extension, panel. browser: true.
 *   ui:         files packages/ui/src/**. paths: panel, board-view, web, extension. browser: true.
 *   web:        files packages/web/src/**. paths: bridge/src, board-core. browser: true.
 *   board-core: files packages/board-core/src/**. paths: web, extension, panel, board-view, ui.
 *   nothing imports an app: add { from: './packages/web/src', message: 'nothing imports an app' }
 *               to every layer's paths (NOT_THE_EXTENSION is the one for the extension today).
 */

const escapeSlashes = (source) => source.replaceAll('/', '\\/');

const layerBlock = ({ files, ignores = [], targets, paths, specifiers, browser = false }) => {
  const syntax = specifiers.flatMap(({ regex, message }) => {
    const pattern = `/${escapeSlashes(regex)}/`;
    return [
      { selector: `ImportExpression[source.value=${pattern}]`, message },
      { selector: `TSImportType[argument.literal.value=${pattern}]`, message },
    ];
  });
  return {
    files,
    ignores,
    rules: {
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
        { patterns: specifiers.map(({ regex, message }) => ({ regex, message })) },
      ],
      'no-restricted-syntax': ['error', ...syntax],
      'import/no-nodejs-modules': browser ? 'error' : 'off',
    },
  };
};

export default LAYERS.map(layerBlock);
