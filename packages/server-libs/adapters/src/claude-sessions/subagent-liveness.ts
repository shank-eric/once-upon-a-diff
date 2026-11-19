/**
 * When a running subagent last wrote: Claude Code keeps each one's transcript at `<projects dir>/<proj>/<launching session
 * id>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` beside it holding the Agent tool's description (the house form
 * `<name>: <task>` names our run). A transcript that keeps changing is a subagent that is working, so the board reads a run's
 * liveness from the newest write of its transcripts (board/stages/dead-runs.ts).
 *
 * That layout is Claude Code's own, not a contract, so every miss is "no answer", never a guess: a run is left out of the
 * result when its session's folder is not found (the launching session was cleared or resumed under a new id, or the folder
 * is gone), when no transcript of the run's name was written since it started (a restarted name is not judged by its earlier
 * run's file), when a meta cannot be read or does not name the run (an uppercase letter or an underscore in the name, a
 * description without `name:`), or when a file cannot be read. Whoever asks then falls back to its own rule, never to "dead".
 *
 * It stays cheap: the session folder is found by prefix once (and looked for again at most every RESCAN_MS), its transcripts are
 * listed at most every LIST_MS per session, and a meta is read once; between listings it is one `stat` per matching transcript.
 *
 * The same folder also answers `subagentsOf`: every subagent of a session, registered or not, for the board's light rows. A
 * subagent is done when its meta says `finished: true`; one without that (a version that never writes it, or a subagent that
 * was killed) is running while its transcript was written within `quietMs`, so a done one of an older Claude Code shows as
 * running for up to `quietMs` after its last write.
 */
import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { agentId } from '@once-upon-a-diff/terms/ids';
import { heavyHolders } from '../heavy-lock.ts';
import { describedName, readSubagentMeta, runNameOf, type SubagentMeta } from '../subagent-meta.ts';
import { RESCAN_MS } from './transcripts.ts';

/** A session's subagent folder is listed again at most this often (a transcript that appears later is seen at the next listing). */
export const LIST_MS = 10000;

/** A transcript last written this long before the run started is an earlier run's (same name, restarted), not this one's. */
const SLACK_MS = 60000;

export interface LivenessQuery {
  /** the run's `sid`: the first 8 of its launching session's id */
  sid: string;
  name: string;
  /** when the run started (ms) */
  startedMs: number;
}

/** The key a result is filed under. */
export const livenessKey = (run: Pick<LivenessQuery, 'sid' | 'name'>): string =>
  agentId(run.sid, run.name);

interface Listing {
  at: number;
  files: { file: string; mtimeMs: number; birthMs: number }[];
}

/** One subagent of a session, from its transcript and meta. */
export interface SubagentFile {
  /** the transcript's name without `.jsonl`: `agent-<id>` */
  id: string;
  /** the meta's description, else null */
  description: string | null;
  /** the Agent tool's `name`, else the description's `<name>:` prefix (whatever its letters), else null */
  name: string | null;
  agentType: string | null;
  state: 'running' | 'done';
  /** when the transcript was created (its last write when the file system has no creation time) */
  startedMs: number;
  /** its last write, once it is done */
  endedMs: number | null;
}

export class SubagentLiveness {
  /** the launching session's `subagents` folder per sid, once found */
  private folders = new Map<string, string>();
  /** when a sid's folder was last looked for and not found */
  private missed = new Map<string, number>();
  private listings = new Map<string, Listing>();
  /** the last `lastWrite` answer, for a caller that cannot wait for a new one (the board's Finish) */
  private answered: ReadonlyMap<string, number> = new Map();
  /** the run name a transcript's meta gives ('' when it gives none): read once, a missing meta is read again next time */
  private names = new Map<string, string>();
  /** the meta of a transcript as of the transcript write and the meta file's own mtime it was read at: a finished one is final, an unfinished one is read again when either changes (Claude marks `finished` in the meta after the last transcript write) */
  private metas = new Map<
    string,
    { meta: SubagentMeta | null; atMtime: number; atMetaMtime: number }
  >();

  /**
   * The newest write (ms) of each run's transcripts, filed under `livenessKey`. A run with no transcript found has no entry;
   * a run whose newest write cannot be told is left out too (never 0 or NaN). A run holding a heavy lock under its name is at
   * work however quiet its transcript (it waits for the command in the background), so it counts as writing now.
   */
  async lastWrite(
    projectsDir: string,
    runs: LivenessQuery[],
    nowMs: number,
  ): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    const holding = heavyHolders();
    for (const run of runs) {
      if (holding.has(run.name)) {
        found.set(livenessKey(run), nowMs);
        continue;
      }
      try {
        const last = await this.lastWriteOf(projectsDir, run, nowMs);
        if (last !== null) {
          found.set(livenessKey(run), last);
        }
      } catch {
        // a folder or file that cannot be read gives no answer for this run
      }
    }
    this.answered = found;
    return found;
  }

  /** What the last `lastWrite` found (empty before the first), so a sync caller judges runs as the last board build did. */
  lastAnswer(): ReadonlyMap<string, number> {
    return this.answered;
  }

  private async lastWriteOf(
    projectsDir: string,
    run: LivenessQuery,
    nowMs: number,
  ): Promise<number | null> {
    const folder = await this.folderOf(projectsDir, run.sid, nowMs);
    if (!folder) {
      return null;
    }
    const since = run.startedMs - SLACK_MS;
    // a listed mtime can only be older than the file's now, so a file that was already old when listed is an earlier run's
    const mine = (await this.list(folder, nowMs)).files.filter(
      ({ file, mtimeMs }) => mtimeMs >= since && this.nameOf(file) === run.name,
    );
    let newest: number | null = null;
    for (const { file } of mine) {
      const mtimeMs = await mtimeOf(file);
      if (mtimeMs !== null && (newest === null || mtimeMs > newest)) {
        newest = mtimeMs;
      }
    }
    return newest;
  }

  /**
   * Every subagent of the session whose id starts with `sid` (first 8), newest first: the transcripts written within `keepMs`, each
   * running (not marked finished, written within `quietMs`) or done. Nothing found, or a folder that cannot be read, is no rows.
   */
  async subagentsOf(
    projectsDir: string,
    sid: string,
    nowMs: number,
    limits: { quietMs: number; keepMs: number },
  ): Promise<SubagentFile[]> {
    try {
      const folder = await this.folderOf(projectsDir, sid, nowMs);
      if (!folder) {
        return [];
      }
      const rows: SubagentFile[] = [];
      for (const { file, mtimeMs, birthMs } of (await this.list(folder, nowMs)).files) {
        if (nowMs - mtimeMs > limits.keepMs) {
          continue;
        }
        const meta = this.metaOf(file, mtimeMs);
        const running = !meta?.finished && nowMs - mtimeMs <= limits.quietMs;
        rows.push({
          id: path.basename(file, '.jsonl'),
          description: meta?.description ?? null,
          name: describedName(meta),
          agentType: meta?.agentType ?? null,
          state: running ? 'running' : 'done',
          startedMs: birthMs,
          endedMs: running ? null : mtimeMs,
        });
      }
      return rows.sort((left, right) => right.startedMs - left.startedMs);
    } catch {
      return [];
    }
  }

  private metaOf(file: string, mtimeMs: number): SubagentMeta | null {
    const known = this.metas.get(file);
    if (known?.meta?.finished) {
      return known.meta;
    }
    const metaMtime = metaMtimeOf(file);
    if (known && known.atMtime === mtimeMs && known.atMetaMtime === metaMtime) {
      return known.meta;
    }
    const meta = readSubagentMeta(file);
    this.metas.set(file, { meta, atMtime: mtimeMs, atMetaMtime: metaMtime });
    return meta;
  }

  /** The `subagents` folder of the session whose id starts with `sid`, in whichever project folder has it. */
  private async folderOf(projectsDir: string, sid: string, nowMs: number): Promise<string | null> {
    const known = this.folders.get(sid);
    if (known) {
      return known;
    }
    if (nowMs - (this.missed.get(sid) ?? -Infinity) < RESCAN_MS) {
      return null;
    }
    let projects: string[] = [];
    try {
      projects = await readdir(projectsDir);
    } catch {
      // no projects folder: nothing to find
    }
    for (const project of projects) {
      let sessions: string[];
      try {
        sessions = await readdir(path.join(projectsDir, project));
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (session.startsWith(sid)) {
          const subagents = path.join(projectsDir, project, session, 'subagents');
          if ((await mtimeOf(subagents)) !== null) {
            this.folders.set(sid, subagents);
            return subagents;
          }
        }
      }
    }
    this.missed.set(sid, nowMs);
    return null;
  }

  private async list(folder: string, nowMs: number): Promise<Listing> {
    const cached = this.listings.get(folder);
    if (cached && nowMs - cached.at < LIST_MS) {
      return cached;
    }
    const files: Listing['files'] = [];
    for (const entry of await readdir(folder)) {
      if (!entry.endsWith('.jsonl')) {
        continue;
      }
      const file = path.join(folder, entry);
      const found = await statOf(file);
      if (found) {
        files.push({ file, ...found });
      }
    }
    const listing = { at: nowMs, files };
    this.listings.set(folder, listing);
    return listing;
  }

  private nameOf(file: string): string | null {
    const known = this.names.get(file);
    if (known !== undefined) {
      return known || null;
    }
    const meta = readSubagentMeta(file);
    if (!meta) {
      return null;
    }
    const name = runNameOf(meta) ?? '';
    this.names.set(file, name);
    return name || null;
  }
}

/** A file's last write and creation (ms; the creation falls back to the last write), or null when it cannot be read or says nothing usable. */
async function statOf(file: string): Promise<{ mtimeMs: number; birthMs: number } | null> {
  try {
    const { mtimeMs, birthtimeMs } = await stat(file);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
      return null;
    }
    return {
      mtimeMs,
      birthMs: Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : mtimeMs,
    };
  } catch {
    return null;
  }
}

/** A file's last write (ms), or null when it cannot be read or says nothing usable. */
async function mtimeOf(file: string): Promise<number | null> {
  return (await statOf(file))?.mtimeMs ?? null;
}

/** The mtime of the meta file beside a transcript, -1 when it is missing. */
function metaMtimeOf(transcript: string): number {
  try {
    return statSync(`${transcript.slice(0, -'.jsonl'.length)}.meta.json`).mtimeMs;
  } catch {
    return -1;
  }
}
