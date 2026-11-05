/*
 * The wire types the bridge and its clients share, as the panel, the extension and the local page take them: the story
 * and the bridge's answers. The bridge builds them, so these types are the contract between the two sides. This file is
 * the index: each area's types are in its own folder (story/, panel/, review/, bridge/, github/, board/), and every
 * name is exported from here, so `@once-upon-a-diff/protocol/types` is the one place to import them from. Types only:
 * nothing here runs.
 */

export type * from './board/agent-types.ts';
export type * from './board/card-types.ts';
export type * from './board/types.ts';
export type * from './bridge/types.ts';
export type * from './github/types.ts';
export type * from './panel/types.ts';
export type * from './review/types.ts';
export type * from './story/types.ts';
