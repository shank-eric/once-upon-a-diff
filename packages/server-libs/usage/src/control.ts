/*
 * What the `usage` command needs from the capture's adapters, through the services (the CLI never calls an adapter itself):
 * the checkout it measures, the mode, the stored files and their switches.
 */
import { clearUsage, readUsageJson, usageFileSize, writeUsageJson } from './adapters/usage-file.ts';
import { CHECKOUT, isLinkedWorktree, readMode, type UsageMode } from './adapters/session.ts';

export { CHECKOUT, clearUsage, isLinkedWorktree, readMode, readUsageJson, usageFileSize };
export type { UsageMode };

/** Turns the capture on (function level, or lines with block ranges) or off. */
export const writeMode = (home: string, mode: UsageMode): void =>
  writeUsageJson(home, 'settings.json', {
    ...readUsageJson<Record<string, unknown>>(home, 'settings.json'),
    mode,
  });
