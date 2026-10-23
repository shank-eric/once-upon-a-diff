#!/usr/bin/env node
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. This plain-JS entry
 * checks the Node version first, so an old Node says what's wrong instead of
 * failing to load TypeScript, then runs the CLI in once-upon.ts.
 */
import { requireNode } from './node-version.mjs';

requireNode();
await import('./once-upon.ts');
