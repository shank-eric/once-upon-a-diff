/**
 * Session titles: Claude Code writes a session's title into its transcript as an `ai-title` line (`{"type": "ai-title",
 * "aiTitle": "…"}`), again and again as the session goes, but it does not change it, so the board prefers fresher signs
 * (a rename, then your latest prompt; see titleIn). The ai-title is what iTerm's tab shows,
 * so the board titles a card by it when the tab's name says nothing (a generic or cut-short name) or there is no tab,
 * before the registry's derived name ("sideprojects-73"). A session that has only had messages from other sessions has
 * none, and keeps the registry's name.
 *
 * It stays cheap: only the transcript's tail is read, a little first and more only when that has none; the answer is
 * kept per session id and file size, and a session with no transcript is looked for at most every RESCAN_MS.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { RESCAN_MS, findIn, projectFolder, sizeOf } from './transcripts.ts';

/** How much of the transcript's end is read: the first span almost always has the title, the second covers long turns. */
const TAILS = [64 * 1024, 2 * 1024 * 1024];

const TITLE_LINE = /"type"\s*:\s*"(ai-title|agent-name|last-prompt)"/;

/** A prompt shorter than this ("yes", "go ahead") says nothing about what the session is doing. */
const MIN_PROMPT = 20;
const MAX_TITLE = 70;

/** A card title from a prompt: its first line, cut at a word. Null for a slash command, a pasted tag or a short reply. */
export function promptTitle(prompt: string): string | null {
  const first = prompt.trim().split('\n')[0].replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (first.length < MIN_PROMPT || /^[/<[]/.test(first)) {
    return null;
  }
  if (first.length <= MAX_TITLE) {
    return first;
  }
  const cut = first.slice(0, MAX_TITLE);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_TITLE / 2)).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The session's title from the transcript's tail, the freshest sign first. Claude Code writes its `ai-title` early and
 * repeats it unchanged, so it goes stale as the work moves on: a name you gave it (`/rename`, an `agent-name` line) wins,
 * then your latest real prompt (a `last-prompt` line that isn't a slash command or a short reply), then the ai-title.
 * A partial first line (cut by the read) is skipped.
 */
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
      let named: string | null = null;
      let prompted: string | null = null;
      let generated: string | null = null;
      for (let index = lines.length - 1; index >= 0 && !named; index--) {
        const match = TITLE_LINE.exec(lines[index]);
        if (!match) {
          continue;
        }
        let line: { aiTitle?: unknown; agentName?: unknown; lastPrompt?: unknown };
        try {
          line = JSON.parse(lines[index]);
        } catch {
          continue; // a line that isn't JSON (one still being written) says nothing
        }
        const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
        if (match[1] === 'agent-name') {
          named = text(line.agentName) || null;
        } else if (match[1] === 'last-prompt') {
          prompted = prompted ?? promptTitle(text(line.lastPrompt));
        } else {
          generated = generated ?? (text(line.aiTitle) || null);
        }
      }
      const found = named ?? prompted ?? generated;
      if (found || start === 0) {
        return found;
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
