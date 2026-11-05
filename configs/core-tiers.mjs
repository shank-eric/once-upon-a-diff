/*
 * Core's tiers, bottom to top (packages/core/src/<tier>/): the one list of their names. configs/.dependency-cruiser.mjs derives its
 * tier rules from it, configs/eslint.side-effects.mjs its core file glob, and packages/core/test/core-layout.test.ts and
 * packages/bridge/test/layer-rules.test.ts read it, so a new tier or a missing one is a visible edit here.
 */
/** @type {string[]} */
export const TIERS = ['foundation', 'records', 'queues', 'features', 'orchestration'];

/**
 * The tiers that hold one folder per unit, which stay apart: every tier but the bottom, whose files may import each other.
 * @type {string[]}
 */
export const TIERS_OF_FOLDERS = TIERS.slice(1);
