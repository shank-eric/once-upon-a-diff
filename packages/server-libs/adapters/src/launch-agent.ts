/*
 * The bridge's LaunchAgent on this Mac: the plist file in ~/Library/LaunchAgents and the `launchctl` calls that load, unload and
 * read it. Every side effect of the feature is here; core/features/launch-agent holds the plist's text and the install steps.
 * Each call takes a Runner, so a test passes its own and never touches launchd.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, removeFile, writeText } from './stores/fs/files.ts';
import { runCommand, type Runner } from './os.ts';

/** The job's label, and so its file's name. scripts/lib/respawn-bridge.sh names it too (a test keeps the two equal). */
export const LAUNCH_LABEL = 'dev.onceupon.bridge';

const LAUNCHCTL_MS = 15_000;

/** The plist's path under an agents folder (`~/Library/LaunchAgents`). */
export const launchAgentFile = (agentsDir: string): string =>
  path.join(agentsDir, `${LAUNCH_LABEL}.plist`);

/** The launchd domain of this user's login session. */
const domainOf = (uid: number): string => `gui/${uid}`;

/** Writes the plist (making its folder), readable by all and changeable by the user, as launchd wants. */
export function writeLaunchAgent(file: string, xml: string): void {
  ensureDir(path.dirname(file), 0o755);
  writeText(file, xml, 0o644);
}

export function removeLaunchAgent(file: string): void {
  removeFile(file);
}

export const launchAgentFileExists = (file: string): boolean => existsSync(file);

/** What launchd says of the job. `available` is false when there is no `launchctl` (not a Mac). */
export interface LaunchJob {
  available: boolean;
  loaded: boolean;
  pid: number | null;
}

/** Loads the job from its file, first unloading it when it is loaded, so installing again refreshes it. Resolves an error line, or null. */
export async function loadLaunchAgent(
  file: string,
  uid: number,
  run: Runner = runCommand,
): Promise<string | null> {
  await run('launchctl', ['bootout', `${domainOf(uid)}/${LAUNCH_LABEL}`], LAUNCHCTL_MS);
  const result = await run('launchctl', ['bootstrap', domainOf(uid), file], LAUNCHCTL_MS);
  return result.code === 0 ? null : (result.stderr || result.stdout || 'launchctl failed').trim();
}

/** Unloads the job; quiet when it was not loaded. */
export async function unloadLaunchAgent(uid: number, run: Runner = runCommand): Promise<void> {
  await run('launchctl', ['bootout', `${domainOf(uid)}/${LAUNCH_LABEL}`], LAUNCHCTL_MS);
}

/** Whether the job is loaded and the pid it runs under, read from `launchctl print`. */
export async function launchJob(uid: number, run: Runner = runCommand): Promise<LaunchJob> {
  const result = await run(
    'launchctl',
    ['print', `${domainOf(uid)}/${LAUNCH_LABEL}`],
    LAUNCHCTL_MS,
  );
  // a program that is not there (not a Mac) fails with no output; a job launchd doesn't know says so on stderr
  if (result.code !== 0 && !result.stdout && !result.stderr) {
    return { available: false, loaded: false, pid: null };
  }
  if (result.code !== 0) {
    return { available: true, loaded: false, pid: null };
  }
  const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1];
  return { available: true, loaded: true, pid: pid ? Number(pid) : null };
}

/** What the plist on disk says, read with `plutil` (never by hand); null when it can't be read. */
export async function readLaunchAgent(
  file: string,
  run: Runner = runCommand,
): Promise<{ workingDirectory: string | null; program: string | null } | null> {
  const result = await run('plutil', ['-convert', 'json', '-o', '-', file], LAUNCHCTL_MS);
  if (result.code !== 0) {
    return null;
  }
  try {
    const plist = JSON.parse(result.stdout) as {
      WorkingDirectory?: string;
      ProgramArguments?: string[];
    };
    return {
      workingDirectory: plist.WorkingDirectory ?? null,
      program: plist.ProgramArguments?.[0] ?? null,
    };
  } catch {
    return null;
  }
}
