/*
 * The heavy-run lock: heavy commands (a full test suite, a browser run, a whole-repo typecheck or lint, deploy gates) take
 * turns machine-wide, whichever repo or agent runs them, so parallel ones don't use up the memory.
 *
 * The lock is a folder, `$ONCE_UPON_HEAVY_LOCK` or `${XDG_CACHE_HOME:-~/.cache}/heavy-run.lock`, made and kept fresh by the
 * proper-lockfile package (mkdir, so only one process can make it; the holder touches it every half of the stale age while it
 * runs, and the package removes it when the process exits). A lock nobody has touched for `$ONCE_UPON_HEAVY_STALE_MS`
 * (default a minute, at least two seconds) was left by a crash (SIGKILL) and is taken over by the next waiter: a killed
 * holder blocks the others for up to that long. The holder's name goes in `<lock>.who` beside the folder (`<name> (3:40 PM):
 * <command>`, then `pid <its pid>` on a second line), because the package's folder must stay empty; a waiter says who it waits for, once, and polls every
 * `$ONCE_UPON_HEAVY_POLL` seconds (default 5). A `.who` older than the lock folder is a crashed holder's and is not believed. A lock folder over the stale age whose
 * holder's pid still runs (it stalled, for instance across the Mac's sleep) is waited for, not taken over; a dead or missing pid keeps the stale rule.
 *
 * A run waiting for the lock keeps `<lock>-waiters/<name>.<its pid>` (removed when it has the lock; the folder goes when empty, a dead pid's file is ignored and cleared by `heavyHolders`), so a run queued behind another is still known to be at work.
 *
 * A lane is a second lock of the same kind, its own queue with at most one holder at a time, so a single-spec browser run need
 * not wait behind the main lock: `browser` is the one lane, at `$ONCE_UPON_HEAVY_LOCK_BROWSER`, else `<$ONCE_UPON_HEAVY_LOCK>-browser`
 * when that is set, else `${XDG_CACHE_HOME:-~/.cache}/heavy-run-browser.lock`. Nothing checks memory: the most that runs at once is one
 * main-lock holder and one browser-lane run.
 *
 * A file or link at the lock path is cleared away once it is over two seconds old. The folder with `pid` and `who` files
 * inside is what the shell script this replaced, and once-upon before the package, made. One at the path is taken over when its pid is gone (or it names none and is over a minute old), and waited for while
 * its pid is alive, so an old run and a new one still take turns. Once no such lock can be about, that step can go.
 *
 * The command runs in the caller's folder with its stdio. `$ONCE_UPON_PATH`, when set and not empty, is the PATH the command
 * gets (and is not passed on): a caller that must run once-upon under `fnm exec --using=24` passes its own PATH this way, so
 * the command runs under the Node the caller's shell picked, not under Node 24. A signal to this process goes on to the
 * command, and the lock is freed when the command ends. With a `logFile` the command's stdout and stderr go to that file instead
 * (made owner-only, with its folder, before the wait), and so do the lines `say` would have printed (the wait, a command that can't start): nothing reaches the caller's terminal, which is how `once-upon deploy` keeps a deploy to one line. The command also gets the umask the caller had (`ONCE_UPON_CALLER_UMASK`,
 * which bin/once-upon.ts records before it sets its own 0077), so what it creates keeps the modes it would have had without us.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { pidAlive } from './os.ts';
import { ensureDir } from './stores/fs/files.ts';
import { clearLeftover, removeLeftover } from './stores/fs/folder-lock.ts';

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

export const HEAVY_LANES = ['browser'] as const;
export type HeavyLane = (typeof HEAVY_LANES)[number];

/** Where the lock is: the main one, or a lane's own. */
function heavyLockPath(env: NodeJS.ProcessEnv = process.env, lane?: HeavyLane): string {
  if (lane === 'browser') {
    return (
      env.ONCE_UPON_HEAVY_LOCK_BROWSER ||
      (env.ONCE_UPON_HEAVY_LOCK && `${env.ONCE_UPON_HEAVY_LOCK}-browser`) ||
      path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'heavy-run-browser.lock')
    );
  }
  return (
    env.ONCE_UPON_HEAVY_LOCK ||
    path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'heavy-run.lock')
  );
}

/** `3:40 PM`, local time. */
function clock(now: Date): string {
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** A lock folder from before the package with no pid this old was left by a process that died before writing it. */
const PIDLESS_STALE_MS = 60_000;

/** A lock nobody has touched for this long was left by a crash. The holder touches it every half of this while it runs. */
const DEFAULT_STALE_MS = 60_000;

/** A file or link at the lock path (not a folder: never made by a heavy lock) this old is cleared away. */
const LEFTOVER_MS = 2_000;

const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/**
 * What a lock folder made before the package holds, if it holds that: `pid` and `who` files. 'gone' when the holder is gone
 * (its pid is dead, or it names none and the folder is over a minute old), 'live' while it runs, null for a folder without
 * them (the package's own lock). The package neither judges nor removes a folder with files in it.
 */
function oldFormatHolder(lock: string): 'gone' | 'live' | null {
  const pidText = readFileSafe(path.join(lock, 'pid')).trim();
  if (!pidText && !readFileSafe(path.join(lock, 'who')).trim()) {
    return null;
  }
  const pid = Number(pidText);
  if (pid > 0) {
    return pidAlive(pid) ? 'live' : 'gone';
  }
  return ageMs(lock) > PIDLESS_STALE_MS ? 'gone' : 'live';
}

/** The holder's `<lock>.who`, when it was written for the lock there now (one older than the folder is a crashed holder's). */
function holderFile(lock: string): string {
  try {
    const written = statSync(`${lock}.who`).mtimeMs;
    const made = statSync(lock).birthtimeMs;
    return made > written ? '' : readFileSafe(`${lock}.who`);
  } catch {
    return '';
  }
}

/** The holder's `who` text: the first line of its `.who`. */
function holderOf(lock: string): string {
  return holderFile(lock).split('\n')[0].trim();
}

/**
 * The names of the runs holding a heavy lock now (the main lock and the browser lane), read from each `.who` as `take` writes it
 * (`<name> (3:40 PM): <command>`), and of the runs waiting for one, read from `<lock>-waiters/<name>.<pid>`. A holder shows only
 * while its lock folder is there, its `.who` belongs to it and its pid (the `.who`'s second line) still runs; a waiter only
 * while its pid runs (a waiter file of a dead pid is deleted here).
 */
export function heavyHolders(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const names = new Set<string>();
  for (const lane of [undefined, 'browser'] as const) {
    const lock = heavyLockPath(env, lane);
    for (const entry of readdirSafe(`${lock}-waiters`)) {
      const match = /^(\S+)\.(\d+)$/.exec(entry);
      if (!match) {
        continue;
      }
      if (pidAlive(Number(match[2]))) {
        names.add(match[1]);
      } else {
        rmSync(path.join(`${lock}-waiters`, entry), { force: true });
      }
    }
    if (!lstatSafe(lock)?.isDirectory()) {
      continue;
    }
    const who = holderFile(lock);
    const name = /^(\S+) \(/.exec(who.split('\n')[0])?.[1];
    const pid = Number(/^pid (\d+)$/m.exec(who)?.[1]);
    if (name && pid > 0 && pidAlive(pid)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Whether the lock there is stale by age but its holder's process (the pid on the `.who`'s second line) still runs: a holder
 * that stalled, for instance across a Mac's sleep, and has not touched the lock yet. It is not taken from.
 */
function stalledHolderLives(lock: string, staleMs: number): boolean {
  if (ageMs(lock) <= staleMs) {
    return false;
  }
  const pid = Number(/^pid (\d+)$/m.exec(holderFile(lock))?.[1]);
  return pid > 0 && pidAlive(pid);
}

/** Takes the lock, waiting for a holder to finish (`waiting` hears who, once), and returns the release. */
async function take(
  lock: string,
  who: string,
  pollMs: number,
  staleMs: number,
  waiting: (holder: string) => void,
  lost: () => void,
): Promise<() => Promise<void>> {
  mkdirSync(path.dirname(lock), { recursive: true });
  let said = false;
  let waiter = '';
  try {
    return await takeLoop();
  } finally {
    if (waiter) {
      rmSync(waiter, { force: true });
      try {
        rmdirSync(path.dirname(waiter)); // only when it is empty: the last waiter out leaves nothing behind
      } catch {
        // others wait too
      }
    }
  }

  async function takeLoop(): Promise<() => Promise<void>> {
    for (;;) {
      try {
        if (stalledHolderLives(lock, staleMs)) {
          throw Object.assign(new Error('the holder is alive'), { code: 'ELOCKED' });
        }
        const release = await lockfile.lock(lock, {
          lockfilePath: lock,
          realpath: false,
          stale: staleMs,
          onCompromised: lost,
        });
        writeFileSync(`${lock}.who`, `${who.replace(/\s+/g, ' ')}\npid ${process.pid}\n`);
        return async () => {
          rmSync(`${lock}.who`, { force: true });
          try {
            await release();
          } catch {
            // taken over after a stall: nothing of ours is left to remove
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const entry = lstatSafe(lock);
        let old: 'gone' | 'live' | null = null;
        if (entry?.isDirectory()) {
          old = oldFormatHolder(lock);
        } else if (entry && clearLeftover(lock, LEFTOVER_MS)) {
          continue; // a file or a link where the folder belongs
        }
        if (old === 'gone') {
          removeLeftover(lock);
          continue;
        }
        if (code !== 'ELOCKED' && !(code === 'ENOTEMPTY' && old === 'live')) {
          throw err;
        }
      }
      if (!said) {
        const name = /^(\S+)/.exec(who)?.[1];
        if (name) {
          try {
            mkdirSync(`${lock}-waiters`, { recursive: true });
            waiter = path.join(`${lock}-waiters`, `${name}.${process.pid}`);
            writeFileSync(waiter, '');
          } catch {
            waiter = '';
          }
        }
        waiting(
          holderOf(lock) || readFileSafe(path.join(lock, 'who')).trim() || 'another heavy run',
        );
        said = true;
      }
      await wait(pollMs);
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function lstatSafe(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/** How long ago the folder was made or last changed (0 when it is gone). */
function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs `command` (a program and its arguments) once it holds the lock, and resolves to its exit code: the command's own,
 * 128 plus the signal's number when a signal ended it, 127 when it can't be started (the log, if any, says so too).
 */
export async function runHeavy(
  name: string,
  command: string[],
  say: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  logFile?: string,
  lane?: HeavyLane,
): Promise<number> {
  const lock = heavyLockPath(env, lane);
  const poll = Number(env.ONCE_UPON_HEAVY_POLL);
  const pollMs = (poll > 0 ? poll : 5) * 1000;
  const stale = Number(env.ONCE_UPON_HEAVY_STALE_MS);
  const staleMs = stale > 0 ? stale : DEFAULT_STALE_MS;
  let logFd: number | undefined;
  if (logFile) {
    ensureDir(path.dirname(logFile));
    logFd = openSync(logFile, 'a', 0o600);
  }
  const tell = (line: string) =>
    logFd === undefined ? say(line) : writeFileSync(logFd, line + '\n');
  let release: () => Promise<void>;
  try {
    release = await take(
      lock,
      `${name} (${clock(new Date())}): ${command.join(' ')}`,
      pollMs,
      staleMs,
      (holder) => tell(`once-upon heavy${lane ? ` (${lane} lane)` : ''}: waiting for ${holder}`),
      () => tell('once-upon heavy: the lock was taken over while this run held it (it stalled)'),
    );
  } catch (err) {
    if (logFd !== undefined) {
      closeSync(logFd);
    }
    throw err;
  }
  const childEnv = { ...env };
  if (childEnv.ONCE_UPON_PATH) {
    childEnv.PATH = childEnv.ONCE_UPON_PATH;
  }
  delete childEnv.ONCE_UPON_PATH;
  const callerUmask = /^[0-7]{1,4}$/.test(childEnv.ONCE_UPON_CALLER_UMASK ?? '')
    ? parseInt(childEnv.ONCE_UPON_CALLER_UMASK as string, 8)
    : null;
  delete childEnv.ONCE_UPON_CALLER_UMASK;
  if (callerUmask !== null) {
    process.umask(callerUmask);
  }
  let signalled = 0;
  const forward = (signal: keyof typeof SIGNALS, child: ReturnType<typeof spawn>) => () => {
    signalled ||= SIGNALS[signal];
    child.kill(signal);
  };
  try {
    return await new Promise<number>((resolve) => {
      const child = spawn(command[0], command.slice(1), {
        stdio: logFd === undefined ? 'inherit' : ['inherit', logFd, logFd],
        env: childEnv,
      });
      const handlers = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]).map(
        (signal) => [signal, forward(signal, child)] as const,
      );
      for (const [signal, handler] of handlers) {
        process.on(signal, handler);
      }
      const done = (code: number) => {
        for (const [signal, handler] of handlers) {
          process.off(signal, handler);
        }
        resolve(code);
      };
      child.on('error', (err) => {
        const line = `once-upon heavy: can't run ${command[0]}: ${err.message}`;
        tell(line);
        done(127);
      });
      child.on('close', (code, signal) => {
        const number = signal ? (os.constants.signals[signal] ?? signalled) : signalled;
        done(code ?? 128 + number);
      });
    });
  } finally {
    await release();
    if (logFd !== undefined) {
      closeSync(logFd);
    }
  }
}
