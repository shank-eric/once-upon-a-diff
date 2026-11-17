/**
 * Whether Claude Code's `<config dir>/settings.json` mentions a hook script by name (`once-upon doctor`'s check that
 * `extras/hooks/listen-pending.sh` is wired). Reads only: the settings are the user's, and nothing here edits them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** true when the settings text names `needle`, false when it does not or there is no file, 'unreadable' when it cannot be read. */
export function settingsMention(configDir: string, needle: string): boolean | 'unreadable' {
  try {
    return readFileSync(path.join(configDir, 'settings.json'), 'utf8').includes(needle);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unreadable';
  }
}
