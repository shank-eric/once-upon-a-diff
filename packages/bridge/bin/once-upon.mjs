#!/usr/bin/env node
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. This plain-JS entry
 * checks the Node version first, so an old Node says what's wrong instead of
 * failing to load TypeScript, then runs the CLI in once-upon.ts.
 */
import { requireNode } from '../../core/src/foundation/node-version.mjs';

requireNode();
// start counting before any other module of this repo loads, so their top-level code is counted too
// (the usage capture: packages/core/src/records/usage/; off with `once-upon usage off`)
const usage = await import('../instrumentation/usage-probe.ts');
if (usage.begin(process.argv.slice(2))) {
  (await import('@once-upon-a-diff/core/records/usage/capture')).installUsage(
    process.argv.slice(2),
  );
}
await import('./once-upon.ts');
