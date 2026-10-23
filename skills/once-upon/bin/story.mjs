/**
 * The skill's story helper, behind the same Node version check as the
 * once-upon CLI, so an old Node says what's wrong instead of failing to load
 * TypeScript. story.ts is the helper itself.
 */
import { requireNode } from '../../../packages/bridge/bin/node-version.mjs';

requireNode();
await import('./story.ts');
