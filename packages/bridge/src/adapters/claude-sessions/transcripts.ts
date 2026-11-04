/**
 * Where a Claude Code session's transcript is: `<projects dir>/<cwd with every non-alphanumeric character as "-">/<session
 * id>.jsonl`. Blank sessions and session titles both read transcripts and look for them the same way.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** A session with no transcript is looked for in the other project folders at most this often. */
export const RESCAN_MS = 10000;

/** Claude Code's project folder name for a working directory. */
export const projectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

export async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** The session's transcript in whichever project folder has it (its cwd may have changed since it started). */
export async function findIn(projectsDir: string, sessionId: string): Promise<string | null> {
  let folders: string[];
  try {
    folders = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = path.join(projectsDir, folder, `${sessionId}.jsonl`);
    if ((await sizeOf(file)) !== null) {
      return file;
    }
  }
  return null;
}
