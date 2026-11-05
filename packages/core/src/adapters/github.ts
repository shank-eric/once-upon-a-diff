/*
 * GitHub, through the gh CLI: the one place the bridge runs it, with ONCE_UPON_GH standing in for gh in tests. The
 * services call it through core/src/foundation/gh.ts, which hands it the environment config.json asks for (GITHUB_TOKEN
 * dropped, so gh answers as the logged-in user).
 */
import { execFile } from 'node:child_process';

/** The gh binary: ONCE_UPON_GH when set (the tests' fake gh), else gh on PATH. */
export const ghBinary = () => process.env.ONCE_UPON_GH || 'gh';

/**
 * Runs gh with these arguments and resolves to its stdout.
 * Rejects with the first line of stderr (or of the error) when gh fails.
 */
export function runGh(
  args: string[],
  {
    timeout = 20000,
    maxBuffer = 32 * 1024 * 1024,
    env = process.env,
  }: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghBinary(), args, { env, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim().split('\n')[0]));
      } else {
        resolve(stdout);
      }
    });
  });
}
