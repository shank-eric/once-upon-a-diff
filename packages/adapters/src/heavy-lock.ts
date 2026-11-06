/*
 * The heavy-run lock: heavy commands (a full test suite, a browser run, a whole-repo typecheck or lint, deploy gates) take
 * turns machine-wide, whichever repo or agent runs them, so parallel ones don't use up the memory.
 *
 * The lock is a folder, `$ONCE_UPON_HEAVY_LOCK` or `${XDG_CACHE_HOME:-~/.cache}/heavy-run.lock`, made with mkdir (only one
 * process can make it), holding `pid` (the holder's) and `who` (`<name> (3:40 PM): <command>`). A lock whose pid is gone was
 * left by a crash and is taken over. A waiter polls every `$ONCE_UPON_HEAVY_POLL` seconds (default 5). The folder and its
 * two files are the format the shell script this replaced used, so an old run and a new one still take turns.
 *
 * The command runs in the caller's folder with its stdio. `$ONCE_UPON_PATH`, when set and not empty, is the PATH the command
 * gets (and is not passed on): a caller that must run once-upon under `fnm exec --using=24` passes its own PATH this way, so
 * the command runs under the Node the caller's shell picked, not under Node 24. A signal to this process goes on to the
 * command, and the lock is freed when the command ends. The command also gets the umask the caller had (`ONCE_UPON_CALLER_UMASK`,
 * which bin/once-upon.ts records before it sets its own 0077), so what it creates keeps the modes it would have had without us.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive } from './os.ts';

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

/** Where the lock is. */
export function heavyLockPath(env: NodeJS.ProcessEnv = process.env): string {
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

const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/** Takes the lock, waiting for a holder to finish (`waiting` hears who, once). */
async function take(
  lock: string,
  who: string,
  pollMs: number,
  waiting: (holder: string) => void,
): Promise<void> {
  mkdirSync(path.dirname(lock), { recursive: true });
  let said = false;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const pid = Number(readFileSafe(path.join(lock, 'pid')).trim());
    if (pid > 0 && !pidAlive(pid)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!said) {
      waiting(readFileSafe(path.join(lock, 'who')).trim() || 'another heavy run');
      said = true;
    }
    await wait(pollMs);
  }
  writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  writeFileSync(path.join(lock, 'who'), `${who}\n`);
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
 * 128 plus the signal's number when a signal ended it, 127 when it can't be started.
 */
export async function runHeavy(
  name: string,
  command: string[],
  say: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const lock = heavyLockPath(env);
  const poll = Number(env.ONCE_UPON_HEAVY_POLL);
  const pollMs = (poll > 0 ? poll : 5) * 1000;
  await take(lock, `${name} (${clock(new Date())}): ${command.join(' ')}`, pollMs, (holder) =>
    say(`once-upon heavy: waiting for ${holder}`),
  );
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
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv });
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
        say(`once-upon heavy: can't run ${command[0]}: ${err.message}`);
        done(127);
      });
      child.on('close', (code, signal) => {
        const number = signal ? (os.constants.signals[signal] ?? signalled) : signalled;
        done(code ?? 128 + number);
      });
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
