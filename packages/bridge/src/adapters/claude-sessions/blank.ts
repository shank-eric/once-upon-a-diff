/**
 * Blank sessions: live Claude Code sessions that have had no prompt yet (new, or just cleared). The registry says nothing
 * about it, so the session's transcript does: `<projects dir>/<cwd with every non-alphanumeric character as "-">/<session
 * id>.jsonl`, one JSON object per line. A cleared session gets a new id (the registry's sessionId changes in place) and a
 * transcript that is only the clear: a mode line, a file-history snapshot, a user line with `isMeta` (the command caveat),
 * the `/clear` command as a user line, and a system line. A session is blank when its transcript is missing, or has no
 * assistant line and no real user line. A real user line is not `isMeta`, not a sidechain, and has text left once the
 * command and caveat wrappers (`<command-name>`, `<local-command-stdout>` and the like) are taken out, or an image. A slash
 * command that starts a model turn (a skill, say) is followed by an assistant line, so it is caught by that.
 *
 * It stays cheap: the transcript is read from its start in chunks and the read stops at the first deciding line; the
 * answer is kept per session id and file size, and a session found to have a prompt is not looked at again (a session id
 * never goes back to blank).
 */
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CHUNK = 64 * 1024;
/** A transcript this long with no prompt in it is not blank. */
const GIVE_UP = 4 * 1024 * 1024;
/** A session with no transcript is looked for in the other project folders at most this often. */
export const RESCAN_MS = 10000;

/** Claude Code's project folder name for a working directory. */
export const projectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const WRAPPERS =
  /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|ide_[a-z_]+)>[\s\S]*?(?:<\/\1>|$)/g;

/** Whether text has anything in it once the command and caveat wrappers are taken out. */
const hasPrompt = (text: string): boolean => text.replace(WRAPPERS, '').trim() !== '';

interface Line {
  type?: unknown;
  content?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/** Whether one transcript line shows the session has been used: an assistant line, or a real prompt. */
export function showsUse(line: Line): boolean {
  if (line.isSidechain || (line.type !== 'user' && line.type !== 'assistant')) {
    return false;
  }
  if (line.type === 'assistant') {
    return true;
  }
  if (line.isMeta) {
    return false;
  }
  const content = line.message?.content;
  if (typeof content === 'string') {
    return hasPrompt(content);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block: { type?: unknown; text?: unknown }) =>
    block?.type === 'image'
      ? true
      : block?.type === 'text' && typeof block.text === 'string' && hasPrompt(block.text),
  );
}

const USER_OR_ASSISTANT = /"type"\s*:\s*"(?:user|assistant)"/;

/** Whether the transcript shows use. A partial last line (still being written) is ignored. */
async function usedIn(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, total);
      if (!bytesRead) {
        return false;
      }
      total += bytesRead;
      const all = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const end = all.lastIndexOf(0x0a);
      carry = end === -1 ? all : all.subarray(end + 1);
      if (end !== -1) {
        for (const text of all.subarray(0, end).toString('utf8').split('\n')) {
          if (!USER_OR_ASSISTANT.test(text)) {
            continue;
          }
          try {
            if (showsUse(JSON.parse(text) as Line)) {
              return true;
            }
          } catch {
            /* a line that isn't JSON says nothing */
          }
        }
      }
      if (total >= GIVE_UP || carry.length >= GIVE_UP) {
        return true;
      }
    }
  } finally {
    await handle.close();
  }
}

interface Known {
  /** where the transcript is, null when none was found */
  file: string | null;
  size: number;
  blank: boolean;
  /** when the project folders were last searched for it (ms), for a session with no transcript */
  looked: number;
}

/** The blank check for the board's sessions, with what it has learned kept per session id. */
export class BlankSessions {
  private known = new Map<string, Known>();
  /** how many transcripts were read, for tests */
  reads = 0;

  /** Whether the session has had no prompt yet. Never rejects: a transcript it can't read counts as used. */
  async isBlank(
    projectsDir: string,
    sessionId: string,
    cwd: string,
    now: number,
  ): Promise<boolean> {
    const kept = this.known.get(sessionId);
    if (kept && !kept.blank) {
      return false;
    }
    let file = kept?.file ?? path.join(projectsDir, projectFolder(cwd), `${sessionId}.jsonl`);
    let size = await sizeOf(file);
    let searched = false;
    if (size === null) {
      file = '';
      if (!kept || now - kept.looked >= RESCAN_MS) {
        searched = true;
        file = (await findIn(projectsDir, sessionId)) || '';
        size = file ? await sizeOf(file) : null;
      } else {
        size = null;
      }
    }
    if (size === null || !file) {
      // `looked` moves only when a search ran, so the board's polls, which come sooner than RESCAN_MS, don't starve the next one
      this.known.set(sessionId, {
        file: null,
        size: -1,
        blank: true,
        looked: searched ? now : (kept?.looked ?? now),
      });
      return true;
    }
    if (kept && kept.file === file && kept.size === size) {
      return true;
    }
    let blank: boolean;
    try {
      this.reads++;
      blank = !(await usedIn(file));
    } catch {
      blank = false;
    }
    this.known.set(sessionId, { file, size, blank, looked: now });
    return blank;
  }

  /** Forgets the sessions that are no longer live. */
  keep(ids: Set<string>): void {
    for (const id of this.known.keys()) {
      if (!ids.has(id)) {
        this.known.delete(id);
      }
    }
  }
}

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
