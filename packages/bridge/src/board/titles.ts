/**
 * Session titles: Claude Code writes a session's title into its transcript as an `ai-title` line (`{"type": "ai-title",
 * "aiTitle": "…"}`), again and again as the session goes, so the latest is near the end. It is what iTerm's tab shows,
 * so the board titles a card by it when the tab's name says nothing (a generic or cut-short name) or there is no tab,
 * before the registry's derived name ("sideprojects-73"). A session that has only had messages from other sessions has
 * none, and keeps the registry's name.
 *
 * It stays cheap: only the transcript's tail is read, a little first and more only when that has none; the answer is
 * kept per session id and file size, and a session with no transcript is looked for at most every RESCAN_MS.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { RESCAN_MS, findIn, projectFolder, sizeOf } from './blank.ts';

/** How much of the transcript's end is read: the first span almost always has the title, the second covers long turns. */
const TAILS = [64 * 1024, 2 * 1024 * 1024];

const AI_TITLE = /"type"\s*:\s*"ai-title"/;

/** The last `ai-title` in the transcript's tail, or null. A partial first line (cut by the read) is skipped. */
async function titleIn(file: string, size: number): Promise<string | null> {
  const handle = await open(file, 'r');
  try {
    for (const span of TAILS) {
      const start = Math.max(0, size - span);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) {
        lines.shift();
      }
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!AI_TITLE.test(lines[index])) {
          continue;
        }
        try {
          const line: { type?: unknown; aiTitle?: unknown } = JSON.parse(lines[index]);
          if (
            line?.type === 'ai-title' &&
            typeof line.aiTitle === 'string' &&
            line.aiTitle.trim()
          ) {
            return line.aiTitle.trim();
          }
        } catch {
          /* a line that isn't JSON (one still being written) says nothing */
        }
      }
      if (start === 0) {
        return null;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

interface Known {
  /** where the transcript is, null when none was found */
  file: string | null;
  size: number;
  title: string | null;
  /** when the project folders were last searched for it (ms), for a session with no transcript */
  looked: number;
}

/** The transcript titles of the board's sessions, with what it has learned kept per session id. */
export class SessionTitles {
  private known = new Map<string, Known>();
  /** how many transcripts were read, for tests */
  reads = 0;

  /** The session's latest title, or null. Never rejects: a transcript it can't read has none. */
  async titleOf(
    projectsDir: string,
    sessionId: string,
    cwd: string,
    now: number,
  ): Promise<string | null> {
    const kept = this.known.get(sessionId);
    let file = kept?.file ?? path.join(projectsDir, projectFolder(cwd), `${sessionId}.jsonl`);
    let size = await sizeOf(file);
    let searched = false;
    if (size === null) {
      file = '';
      if (!kept || now - kept.looked >= RESCAN_MS) {
        searched = true;
        file = (await findIn(projectsDir, sessionId)) || '';
        size = file ? await sizeOf(file) : null;
      }
    }
    if (size === null || !file) {
      this.known.set(sessionId, {
        file: null,
        size: -1,
        title: null,
        looked: searched ? now : (kept?.looked ?? now),
      });
      return null;
    }
    if (kept && kept.file === file && kept.size === size) {
      return kept.title;
    }
    let title: string | null;
    try {
      this.reads++;
      title = await titleIn(file, size);
    } catch {
      title = null;
    }
    // a read that finds none keeps the last one found: the title doesn't go away
    title = title ?? kept?.title ?? null;
    this.known.set(sessionId, { file, size, title, looked: now });
    return title;
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
