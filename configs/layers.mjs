/*
 * The engine's layers and the five folders the packages sit in: the one list of their names. configs/.dependency-cruiser.mjs
 * derives its order and tier rules from it, configs/eslint.side-effects.mjs its source globs, and packages/server/bridge/test/layer-rules.test.ts and package-layout.test.ts read it,
 * so a new package, a new tier or a missing one is a visible edit here.
 */

/**
 * The five folders under packages/ and the packages each holds (packages/<group>/<name>). Server side: `server` (the apps and the
 * shell), `server-libs` (the engine and usage). Client side: `client` (the panel, pages, extension) and `client-libs` (what they
 * share). `domain` is the floor under both: pure rules, the contracts and the test kit. A package imports within its group, down
 * to its libs and into `domain`; the server side never imports the client side or the other way (configs/.dependency-cruiser.mjs).
 * @type {Record<string, string[]>}
 */
export const GROUPS = {
  server: ['server', 'cli', 'bridge'],
  'server-libs': ['adapters', 'foundation', 'stories', 'state', 'core', 'board', 'usage'],
  client: ['panel', 'extension', 'web', 'github-page'],
  'client-libs': ['bridge-client', 'ui-kit'],
  domain: ['contracts', 'terms', 'test-kit'],
};

/** Every package's folder under packages/, by name: `dirOf('core')` is `server-libs/core`. @type {(name: string) => string} */
export const dirOf = (name) => {
  const group = Object.keys(GROUPS).find((one) => GROUPS[one].includes(name));
  if (!group) {
    throw new Error(`no group holds the package ${name}`);
  }
  return `${group}/${name}`;
};

/**
 * The engine packages, bottom to top (packages/server-libs/<name>/src): a package imports only the ones before it. `usage` is not in the
 * order: it sits beside them (it imports adapters and foundation, and only the apps and the shell import it).
 * @type {string[]}
 */
export const PACKAGES = ['adapters', 'foundation', 'stories', 'state', 'core', 'board'];

/**
 * The packages that keep tiers inside, and each one's folders bottom to top (packages/server-libs/<name>/src/<tier>/): a tier imports
 * only the tiers under it, and the folders of one tier never import each other.
 * @type {Record<string, string[]>}
 */
export const TIERS = {
  state: ['records', 'queues'],
  core: ['features', 'orchestration'],
};
