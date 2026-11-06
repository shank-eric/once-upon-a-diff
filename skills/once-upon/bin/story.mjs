/**
 * The skill's story helper, behind the same Node version check as the
 * once-upon CLI, so an old Node says what's wrong instead of failing to load
 * TypeScript. story.ts is the helper itself.
 */
import { requireNode } from '../../../packages/foundation/src/node-version.mjs';

requireNode();
// the usage capture (packages/usage/src/) counts this helper's code too, before any module of it loads
const usage = await import('../../../packages/bridge/instrumentation/usage-probe.ts');
if (usage.begin(['story'])) {
  (await import('../../../packages/usage/src/capture.ts')).installUsage(['story']);
}
await import('./story.ts');
