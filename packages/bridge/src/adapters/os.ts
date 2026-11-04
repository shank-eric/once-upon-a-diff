/*
 * This Mac: running programs, process ids, ports, host names and the browser. The services reach it through these, so
 * a lint rule can keep `child_process` and the network out of them (eslint.boundaries.mjs).
 */
import { execFile, execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { existsSync } from 'node:fs';

/** Runs a command and resolves to its stdout, or null when it fails or runs past the limit. */
export function run(
  cmd: string,
  args: string[],
  timeout = 4000,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, env: env || process.env },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** What a command answered. `timedOut` is a kill at the time limit (the answer is then not an answer). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr?: string;
  timedOut: boolean;
}

/** Runs a program with a time limit; never rejects. A test passes its own to count calls or hold one up. */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** 0 on success, the process's exit code when it has one, else 1 (killed, not found). */
function exitCodeOf(failed: NodeJS.ErrnoException | null): number {
  if (!failed) {
    return 0;
  }
  return typeof failed.code === 'number' ? failed.code : 1;
}

export const runCommand: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        const failed = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: exitCodeOf(failed),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: !!failed?.killed,
        });
      },
    );
  });

/** Whether a process with this pid exists (one we may not signal still does). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether something listens on the port: a port already listening can't be bound again. */
export function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

export function listenerPid(port: number): { pid: string; command: string } | null {
  try {
    const pid = execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0];
    if (!pid) {
      return null;
    }
    const command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
    return { pid, command };
  } catch {
    return null;
  }
}

type Health = { status: number; body: { name?: string; version?: string } | null };

/**
 * The bridge's /api/health answer, or null when nothing answered within 2s. This stays an HTTP call on purpose: it is
 * the one check that walks the same road as the browser (127.0.0.1, the port, the token), and a 401 can only come from
 * the running bridge, which holds the token it started with. Everything else on this machine that isn't a browser reads
 * and writes files and stores instead.
 */
export async function fetchHealth(port: number, token: string | undefined): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json().catch(() => null)) as Health['body'];
    return { status: response.status, body };
  } catch {
    return null;
  }
}

export const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The pid's start time as `ps` says it, in the form the registry's procStart has, or null when ps can't say. */
export function startOf(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return collapse(out) || null;
  } catch {
    return null;
  }
}

/** Is cmd runnable as typed (a path that exists, or a name on PATH)? */
export function onPath(cmd: string | null | undefined): boolean {
  if (!cmd) {
    return false;
  }
  if (cmd.includes('/')) {
    return existsSync(cmd);
  }
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Starts a program and does not wait for it or its answer (the browser a page link opens in). */
export function spawnDetached(cmd: string, args: string[]): void {
  execFile(cmd, args, () => {});
}

/** The addresses a host name resolves to, or rejects. */
export async function addressesOf(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}

/** Runs `fn` when this process gets the signal. A listener replaces the signal's default (SIGUSR2's default is to end the process). */
export function onSignal(signal: NodeJS.Signals, handler: () => void): void {
  process.on(signal, handler);
}

/** Sends a signal to a process, false when it could not be sent (gone, or not ours). */
export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** A process's command line, or null when it is gone. */
export function commandOf(pid: number): string | null {
  try {
    return (
      execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
    );
  } catch {
    return null;
  }
}
