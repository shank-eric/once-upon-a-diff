/*
 * What the doctor needs to know of the bridge's LaunchAgent: whether its file is there, launchd has it loaded and under which
 * pid, and what the file runs. Read through the adapters' Runner, so a test passes its own.
 */
import {
  launchAgentFile,
  launchAgentFileExists,
  launchJob,
  readLaunchAgent,
} from '@once-upon-a-diff/adapters/launch-agent';
import { runCommand, type Runner } from '@once-upon-a-diff/adapters/os';
import { defaultAgentsDir } from './install.ts';

export interface LaunchAgentFacts {
  /** false when there is no `launchctl` (not a Mac): nothing to say */
  available: boolean;
  file: string;
  fileExists: boolean;
  loaded: boolean;
  pid: number | null;
  workingDirectory: string | null;
  program: string | null;
  uid: number;
}

export async function readLaunchAgentFacts(
  agentsDir: string = defaultAgentsDir(),
  uid: number = process.getuid?.() ?? 0,
  run: Runner = runCommand,
): Promise<LaunchAgentFacts> {
  const file = launchAgentFile(agentsDir);
  const job = await launchJob(uid, run);
  const fileExists = launchAgentFileExists(file);
  const plist = fileExists ? await readLaunchAgent(file, run) : null;
  return {
    ...job,
    file,
    fileExists,
    workingDirectory: plist?.workingDirectory ?? null,
    program: plist?.program ?? null,
    uid,
  };
}
