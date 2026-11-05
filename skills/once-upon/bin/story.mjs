/**
 * The skill's story helper, behind the same Node version check as the
 * once-upon CLI, so an old Node says what's wrong instead of failing to load
 * TypeScript. story.ts is the helper itself.
 */
import { requireNode } from '../../../packages/core/src/foundation/node-version.mjs';

requireNode();
// the usage capture (packages/core/src/records/usage/) counts this helper's code too, before any module of it loads
const usage = await import('../../../packages/bridge/instrumentation/usage-probe.ts');
if (usage.begin(['story'])) {
  (await import('../../../packages/core/src/records/usage/capture.ts')).installUsage(['story']);
}
await import('./story.ts');
