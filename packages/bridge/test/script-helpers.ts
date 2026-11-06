/** Runs a repo script (scripts/*.sh, extras/*) in a child process, with the environment a test chooses. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CLI_BIN = path.join(ROOT, 'packages/bridge/bin/once-upon.mjs');

export type ScriptRun = { code: number | null; stdout: string; stderr: string };

/** `env` is the whole environment except PATH, which keeps node reachable; null removes a name. */
export function runScript(
  file: string,
  args: string[],
  env: Record<string, string | null> = {},
  input?: string,
): Promise<ScriptRun> {
  const full: Record<string, string | undefined> = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === null) {
      delete full[name];
    } else {
      full[name] = value;
    }
  }
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: full, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Waits until `ready()` holds (a detached child finishing its write), up to `timeoutMs`. */
export async function until(ready: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    if (ready()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ready();
}

/** An executable file with `body` (a shell script), made where a test says. */
export function writeExecutable(file: string, body: string): void {
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

export { existsSync };
