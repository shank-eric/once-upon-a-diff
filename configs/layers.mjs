/*
 * The engine's layers: the one list of their names. configs/.dependency-cruiser.mjs derives its order and tier rules from it,
 * configs/eslint.side-effects.mjs its source globs, and packages/bridge/test/layer-rules.test.ts and package-layout.test.ts read it,
 * so a new package, a new tier or a missing one is a visible edit here.
 */

/**
 * The engine packages, bottom to top (packages/<name>/src): a package imports only the ones before it. `usage` is not in the
 * order: it sits beside them (it imports adapters and foundation, and only the apps and the shell import it).
 * @type {string[]}
 */
export const PACKAGES = ['adapters', 'foundation', 'stories', 'state', 'core', 'board'];

/**
 * The packages that keep tiers inside, and each one's folders bottom to top (packages/<name>/src/<tier>/): a tier imports
 * only the tiers under it, and the folders of one tier never import each other.
 * @type {Record<string, string[]>}
 */
export const TIERS = {
  state: ['records', 'queues'],
  core: ['features', 'orchestration'],
};
