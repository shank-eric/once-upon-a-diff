import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { run, type LiveSession } from '../sources.ts';

interface Registry {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  name?: unknown;
  status?: unknown;
  statusUpdatedAt?: unknown;
  startedAt?: unknown;
  procStart?: unknown;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The registry's live sessions: files whose pid is running, with their ttys. */
export async function liveSessions(dir: string): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const found: (LiveSession & { procStart: string | null })[] = [];
  for (const name of names) {
    let reg: Registry;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      // `null`, a number or a string is valid JSON but not a registry file: it drops only itself
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      reg = parsed as Registry;
    } catch {
      continue;
    }
    const pid = Number(reg.pid);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof reg.sessionId !== 'string' ||
      typeof reg.cwd !== 'string'
    ) {
      continue;
    }
    found.push({
      pid,
      session: reg.sessionId,
      cwd: reg.cwd,
      name: typeof reg.name === 'string' && reg.name ? reg.name : null,
      tty: null,
      status: typeof reg.status === 'string' ? reg.status : 'idle',
      statusAt: typeof reg.statusUpdatedAt === 'number' ? reg.statusUpdatedAt : null,
      startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : null,
      procStart: typeof reg.procStart === 'string' ? collapse(reg.procStart) : null,
    });
  }
  if (!found.length) {
    return [];
  }
  // ps in UTC with a fixed locale answers the pid's tty and start time in the registry's procStart form; no ps (or a
  // pid it doesn't list) falls back to a plain liveness check
  const listing = await run(
    'ps',
    ['-o', 'pid=,tty=,lstart=', '-p', found.map((live) => live.pid).join(',')],
    4000,
    { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  );
  const rows = new Map<number, { tty: string; start: string }>();
  for (const line of (listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) {
      rows.set(Number(match[1]), { tty: match[2], start: collapse(match[3]) });
    }
  }
  return found
    .filter((live) => {
      const row = rows.get(live.pid);
      if (row) {
        return !live.procStart || live.procStart === row.start;
      }
      if (listing !== null) {
        return false;
      }
      try {
        process.kill(live.pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    })
    .map(({ procStart: _procStart, ...live }) => ({
      ...live,
      tty: rows.get(live.pid)?.tty.replace(/^\?+$/, '') || null,
    }));
}

/** A lane's name for a folder, given the GitHub repo its origin points at (null when unknown): the repo's name, else the folder's own. */
export function laneOf(cwd: string, repo: string | null): string {
  return repo ? repo.split('/')[1] : path.basename(cwd) || cwd;
}
