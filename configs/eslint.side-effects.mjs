/*
 * Side-effect rules, enforced by `yarn lint` (eslint.config.mjs spreads this in last): only an adapter runs a program, writes a
 * file or reaches the network. Which package, layer or region may import which, and import cycles, are dependency-cruiser's
 * (configs/.dependency-cruiser.mjs, `yarn depcruise`, run by `yarn lint`); this file holds no layer or package rule.
 *
 * Where it applies (the adapters, packages/adapters/src, and usage's own adapters folder, packages/usage/src/adapters, are the one
 * place that may do any of this):
 *   packages/server/src/         the HTTP app: it has node:http, to listen, and nothing else on the network
 *   packages/server/src/routes/  the HTTP app's handlers: not even node:http (they get a Call)
 *   packages/cli/src/            the CLI app
 *   packages/<package>/src/      every other engine package (named in configs/layers.mjs, and usage): no program, no file write and
 *                                no network of their own
 * packages/bridge/test/side-effects-lint.test.ts probes every rule below.
 *
 * ESLint REPLACES a rule's options when a later block matches the same file, it does not merge them, so each file is in one
 * block and the lists below are built once and shared.
 *
 * Mechanisms:
 *   - no-restricted-imports matches the specifier of a static import (child_process, the network, threads and vm, node:fs
 *     writes by name, node:module loaders).
 *   - no-restricted-syntax matches the same specifiers in a dynamic `import('...')`, which no-restricted-imports does not look
 *     at, and the whole-module forms of node:fs and node:module that would hide a write or a loader.
 *   - no-restricted-globals and no-restricted-properties catch fetch (bare, or through globalThis) and process.kill.
 */

import { PACKAGES } from './layers.mjs';

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
  'only an adapter writes files: add a function to adapters/stores/fs/ (files.ts, json-file.ts) and call that';
const FS_NAMESPACE_MESSAGE =
  'import the read functions by name from node:fs: a whole-module import hides the write calls from the lint rule';
const escapeSlashes = (source) => source.replaceAll('/', '\\/');

// node:fs may be imported for its reads, by name; the names that write, and a whole-module import, are refused
const fsPaths = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].map((name) => ({
  name,
  importNames: FS_WRITES,
  message: FS_WRITE_MESSAGE,
}));
const modulePaths = ['node:module', 'module'].map((name) => ({
  name,
  importNames: MODULE_LOADERS,
  message: MODULE_MESSAGE,
}));
const fsSyntax = [
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
];

// one block per set of files; `networkBan` is the one thing that differs (the HTTP app keeps node:http)
const sideEffectBlock = ({ files, ignores = [], networkBan }) => {
  const specifiers = [NO_CHILD_PROCESS, networkBan, NO_ESCAPE_HATCH];
  const syntax = specifiers.map(({ regex, message }) => ({
    selector: `ImportExpression[source.value=/${escapeSlashes(regex)}/]`,
    message,
  }));
  return {
    files,
    ignores,
    rules: {
      'no-restricted-globals': ['error', NOT_FETCH],
      'no-restricted-properties': ['error', ...NOT_GLOBAL_FETCH, NOT_PROCESS_KILL],
      'no-restricted-imports': [
        'error',
        {
          paths: [...fsPaths, ...modulePaths],
          patterns: specifiers.map(({ regex, message }) => ({ regex, message })),
        },
      ],
      'no-restricted-syntax': ['error', ...syntax, ...fsSyntax],
    },
  };
};

export default [
  // the rules, over the adapters: every engine package but adapters, and usage but for its adapters folder
  sideEffectBlock({
    files: [`packages/{${PACKAGES.slice(1).join(',')}}/src/**/*.ts`],
    networkBan: NO_NETWORK,
  }),
  sideEffectBlock({
    files: ['packages/usage/src/**/*.ts'],
    ignores: ['packages/usage/src/adapters/**'],
    networkBan: NO_NETWORK,
  }),
  // the HTTP app, over the services only: node:http, to listen
  sideEffectBlock({
    files: ['packages/server/src/**/*.ts'],
    ignores: ['packages/server/src/routes/**'],
    networkBan: NO_NETWORK_BUT_HTTP,
  }),
  // the routes: the HTTP app's own handlers, which never touch node:http either (they get a Call)
  sideEffectBlock({ files: ['packages/server/src/routes/**/*.ts'], networkBan: NO_NETWORK }),
  // the CLI app, over the services only
  sideEffectBlock({ files: ['packages/cli/src/**/*.ts'], networkBan: NO_NETWORK }),
];
