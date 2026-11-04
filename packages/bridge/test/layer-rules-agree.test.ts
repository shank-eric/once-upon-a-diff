/*
 * The layer rules live in two files: eslint.boundaries.mjs (the source, per AGENTS.md "Structure") and
 * .dependency-cruiser.mjs, which mirrors it and adds what ESLint cannot see (cycles, re-exports). This test reads
 * both as data and asks each one the same question for every pair of layers: may a file here import a file there?
 * Any pair where they answer differently fails, so a rule edited in one file and not the other cannot go unnoticed.
 *
 * depcruise sees the resolved file, whatever the import spells. ESLint sees the spelling: a relative path meets its
 * path zones, and a package name (`@once-upon-a-diff/panel/context`, which its resolver cannot follow through
 * `exports`) meets only its specifier bans. So each target is asked about in both spellings, and both must agree with
 * depcruise. Besides the layers, every package's root and test folder are targets, so a rule that stops at `src/` in
 * one file and covers the whole package in the other shows up. For Node built-ins both sides are compared by module
 * name. Rules only one tool has stay out of scope: cycles, unresolved and npm imports (depcruise), fs writes, fetch,
 * process.kill and the /assets/ URL spellings (ESLint).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob, relative } from 'node:path';

const ROOT = new URL('../../../', import.meta.url);

type Zone = { target: string; from: string; except?: string[] };
type EslintBlock = {
  files: string[];
  ignores: string[];
  rules: Record<string, unknown>;
};
type Matcher = { path?: string | string[]; pathNot?: string | string[] };
type CruiseRule = {
  name: string;
  severity: string;
  from: Matcher;
  to: Matcher & {
    dependencyTypes?: string[];
    dependencyTypesNot?: string[];
    couldNotResolve?: boolean;
    circular?: boolean;
  };
};
type Manifest = { name: string; exports?: Record<string, string> };

const load = async <T>(file: string): Promise<T> => {
  const loaded = (await import(new URL(file, ROOT).href)) as { default: T };
  return loaded.default;
};

const blocks = await load<EslintBlock[]>('eslint.boundaries.mjs');
const { forbidden } = await load<{ forbidden: CruiseRule[] }>('.dependency-cruiser.mjs');

// one probe file per layer (from the repo root; the files need not exist)
const LAYERS: Record<string, string> = {
  adapters: 'packages/bridge/src/adapters/probe.ts',
  services: 'packages/bridge/src/services/probe.ts',
  http: 'packages/bridge/src/server/probe.ts',
  routes: 'packages/bridge/src/server/routes/probe.ts',
  cli: 'packages/bridge/src/cli/probe.ts',
  'bridge-bin': 'packages/bridge/bin/probe.ts',
  pages: 'packages/web/public/probe.ts',
  'board page': 'packages/web/public/board.ts',
  'board shared': 'packages/web/public/board/shared.ts',
  'board region header': 'packages/web/public/board/header/probe.ts',
  'board region columns': 'packages/web/public/board/columns/probe.ts',
  'api-client': 'packages/api-client/src/probe.ts',
  'use-poll': 'packages/api-client/src/use-poll.ts',
  ui: 'packages/ui/src/probe.ts',
  protocol: 'packages/protocol/src/probe.ts',
  schemas: 'packages/protocol/src/schemas.ts',
  domain: 'packages/protocol/src/domain/probe.ts',
  'host-github': 'packages/host-github/src/probe.ts',
  panel: 'packages/panel/src/probe.ts',
  'panel port': 'packages/panel/src/host.ts',
  overlay: 'packages/panel/src/overlay.ts',
  'panel region ask': 'packages/panel/src/ask/probe.ts',
  'panel region drafts': 'packages/panel/src/drafts/probe.ts',
  extension: 'packages/extension/src/probe.ts',
  'test-kit': 'packages/test-kit/src/probe.ts',
};
// targets only (neither tool checks the imports these folders make): each package's root and tests, for the reach of a rule
const PACKAGE_DIRS = [
  'api-client',
  'bridge',
  'extension',
  'host-github',
  'panel',
  'protocol',
  'test-kit',
  'ui',
  'web',
];
const EDGES: Record<string, string> = Object.fromEntries(
  PACKAGE_DIRS.flatMap((dir) => [
    [`${dir} root`, `packages/${dir}/probe.ts`],
    [`${dir} tests`, `packages/${dir}/test/probe.ts`],
  ]),
);
const BUILT_INS = ['child_process', 'http', 'https', 'net', 'worker_threads', 'vm', 'fs'].map(
  (name) => `node:${name}`,
);

const MANIFESTS = new Map(
  PACKAGE_DIRS.map((dir): [string, Manifest] => [
    dir,
    JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, ROOT), 'utf8')) as Manifest,
  ]),
);

// the package name that reaches a file through its package's `exports` (or any path, without them), if one does
const packageSpecifier = (file: string): string | undefined => {
  const [, dir, rest] = /^packages\/([^/]+)\/(.*)$/.exec(file) ?? [];
  const manifest = MANIFESTS.get(dir);
  if (!manifest) {
    return undefined;
  }
  if (!manifest.exports) {
    return `${manifest.name}/${rest}`;
  }
  for (const [key, value] of Object.entries(manifest.exports)) {
    const [valueHead, valueTail] = value.slice(2).split('*');
    if (rest.startsWith(valueHead) && rest.endsWith(valueTail)) {
      const middle = rest.slice(valueHead.length, rest.length - valueTail.length);
      return `${manifest.name}/${key.slice(2).replace('*', middle)}`;
    }
  }
  return undefined;
};

// the spellings a file is imported by: a relative path, and its package name when its exports reach it
const spellings = (importer: string, imported: string): string[] => {
  if (imported.startsWith('node:')) {
    return [imported];
  }
  const path = relative(importer.replace(/\/[^/]+$/, ''), imported);
  const name = packageSpecifier(imported);
  return [path.startsWith('.') ? path : `./${path}`, ...(name ? [name] : [])];
};

// ESLint: the last block over the file wins (ESLint replaces a rule's options, it does not merge them)
const eslintBlock = (file: string): EslintBlock | undefined =>
  blocks.findLast(
    ({ files, ignores }) =>
      files.some((glob) => matchesGlob(file, glob)) &&
      !ignores.some((glob) => matchesGlob(file, glob)),
  );

const inside = (file: string, folder: string): boolean => {
  const bare = folder.replace(/^\.\//, '');
  return file === bare || file.startsWith(`${bare}/`);
};

const ruleOptions = <T>(block: EslintBlock, rule: string): T | undefined => {
  const setting = block.rules[rule];
  return Array.isArray(setting) && setting[0] === 'error' ? (setting[1] as T) : undefined;
};

const eslintForbids = (importer: string, imported: string, spelling: string): boolean => {
  const block = eslintBlock(importer);
  if (!block) {
    return false;
  }
  if (spelling.startsWith('node:') && block.rules['import/no-nodejs-modules'] === 'error') {
    return true;
  }
  if (spelling.startsWith('.')) {
    const zones = ruleOptions<{ zones: Zone[] }>(block, 'import/no-restricted-paths')?.zones ?? [];
    return zones.some(
      ({ target, from, except = [] }) =>
        inside(importer, target) &&
        inside(imported, from) &&
        !except.some((path) => inside(imported, `${from}/${path.replace(/^\.\//, '')}`)),
    );
  }
  const patterns =
    ruleOptions<{ patterns: { regex: string }[] }>(block, 'no-restricted-imports')?.patterns ?? [];
  return patterns.some(({ regex }) => new RegExp(regex).test(spelling));
};

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : [value].flat();

// depcruise: only an error fails the cruise, and a rule's `to` may name the groups its `from.path` captured ($1).
// A relative spelling is a 'local' dependency to depcruise, a package name is not.
const cruiseForbids = (importer: string, imported: string, spelling: string): boolean =>
  forbidden.some(({ severity, from, to }) => {
    if (severity !== 'error' || to.circular || to.couldNotResolve) {
      return false;
    }
    const core = imported.startsWith('node:');
    if (to.dependencyTypes && !(core && to.dependencyTypes.includes('core'))) {
      return false;
    }
    if (spelling.startsWith('.') && to.dependencyTypesNot?.includes('local')) {
      return false;
    }
    if (list(from.pathNot).some((pattern) => new RegExp(pattern).test(importer))) {
      return false;
    }
    const fromPaths = list(from.path);
    const groups = fromPaths.length
      ? fromPaths.map((pattern) => new RegExp(pattern).exec(importer)).find(Boolean)
      : [];
    if (!groups) {
      return false;
    }
    const fill = (pattern: string) =>
      new RegExp(pattern.replace(/\$(\d)/g, (_, index: string) => groups[Number(index)] ?? ''));
    const toPaths = list(to.path);
    if (toPaths.length && !toPaths.some((pattern) => fill(pattern).test(imported))) {
      return false;
    }
    return !list(to.pathNot).some((pattern) => fill(pattern).test(imported));
  });

const disagreements = (): string[] => {
  const found: string[] = [];
  const targets = [
    ...Object.entries(LAYERS),
    ...Object.entries(EDGES),
    ...BUILT_INS.map((name): [string, string] => [name, name]),
  ];
  for (const [importerLayer, importer] of Object.entries(LAYERS)) {
    for (const [importedLayer, imported] of targets) {
      if (imported === importer) {
        continue;
      }
      for (const spelling of spellings(importer, imported)) {
        const cruise = cruiseForbids(importer, imported, spelling);
        const eslint = eslintForbids(importer, imported, spelling);
        if (eslint !== cruise) {
          found.push(
            `${importerLayer} -> ${importedLayer} (${spelling}): ESLint ${eslint ? 'forbids' : 'allows'}, depcruise ${cruise ? 'forbids' : 'allows'}`,
          );
        }
      }
    }
  }
  return found;
};

test('every probe file falls under a block of eslint.boundaries.mjs', () => {
  for (const [layer, file] of Object.entries(LAYERS)) {
    assert.ok(eslintBlock(file), `${layer}: no block in eslint.boundaries.mjs covers ${file}`);
  }
});

test('a package name is asked about too, where the package exports the file', () => {
  assert.deepEqual(spellings(LAYERS['host-github'], 'packages/panel/src/context.ts'), [
    '../../panel/src/context.ts',
    '@once-upon-a-diff/panel/context',
  ]);
  assert.deepEqual(spellings(LAYERS.panel, 'packages/web/public/board.ts'), [
    '../../web/public/board.ts',
    '@once-upon-a-diff/web/public/board.ts',
  ]);
  assert.deepEqual(spellings(LAYERS.pages, 'packages/bridge/bin/probe.ts'), [
    '../../bridge/bin/probe.ts',
  ]);
});

test('eslint.boundaries.mjs and .dependency-cruiser.mjs agree on what each layer may import', () => {
  assert.deepEqual(disagreements(), []);
});
