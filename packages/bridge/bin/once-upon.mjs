#!/usr/bin/env node
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. This plain-JS entry
 * checks the Node version first, so an old Node says what's wrong instead of
 * failing to load TypeScript, then runs the CLI in once-upon.ts.
 */
import { requireNode } from './node-version.mjs';

requireNode();
// start counting before any other module of this repo loads, so their top-level code is counted too
// (the usage capture: src/services/usage/; off with `once-upon usage off`)
const usage = await import('../src/adapters/usage/boot.ts');
if (usage.begin(process.argv.slice(2))) {
  (await import('../src/services/usage/capture.ts')).installUsage(process.argv.slice(2));
}
await import('./once-upon.ts');
