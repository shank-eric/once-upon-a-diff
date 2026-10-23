/*
 * The one way the bridge runs gh: as the logged-in gh user (ghEnv drops
 * GITHUB_TOKEN when config.json says so), with ONCE_UPON_GH standing in for
 * gh in tests.
 */
import { execFile } from 'node:child_process';
import { ghEnv } from '../config/settings.mjs';

/** The gh binary: ONCE_UPON_GH when set (the tests' fake gh), else gh on PATH. */
export const ghBinary = () => process.env.ONCE_UPON_GH || 'gh';

/**
 * Runs gh with these arguments and resolves to its stdout.
 * Rejects with the first line of stderr (or of the error) when gh fails.
 */
export function runGh(args, { timeout = 20000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const env = ghEnv();
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
