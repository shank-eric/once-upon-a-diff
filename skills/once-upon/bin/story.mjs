/**
 * The skill's story helper, behind the same Node version check as the
 * once-upon CLI, so an old Node says what's wrong instead of failing to load
 * TypeScript. story.ts is the helper itself.
 */
import { requireNode } from '../../../packages/bridge/bin/node-version.mjs';

requireNode();
// the usage capture (packages/bridge/src/services/usage/) counts this helper's code too, before any module of it loads
const usage = await import('../../../packages/bridge/src/adapters/usage/boot.ts');
if (usage.begin(['story'])) {
  (await import('../../../packages/bridge/src/services/usage/capture.ts')).installUsage(['story']);
}
await import('./story.ts');
