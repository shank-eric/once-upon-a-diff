/*
 * Heavy runs take turns: `once-upon heavy NAME COMMAND...` runs the command once no other heavy run holds the lock. The lock,
 * the wait and the command's run are the adapter's (adapters/src/heavy-lock.ts); this is where the CLI reaches them.
 */
import { HEAVY_LANES, runHeavy } from '@once-upon-a-diff/adapters/heavy-lock';

export { HEAVY_LANES, runHeavy };
export type { HeavyLane } from '@once-upon-a-diff/adapters/heavy-lock';
