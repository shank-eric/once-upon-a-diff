/*
 * Core's tiers, bottom to top (packages/core/src/<tier>/). Read by configs/.dependency-cruiser.mjs, which makes a tier import only the
 * tiers under it, and by packages/core/test/core-layout.test.ts, which pins the folders: a new tier or a missing one is a visible edit.
 */
/** @type {string[]} */
export const TIERS = ['foundation', 'records', 'queues', 'features', 'orchestration'];
