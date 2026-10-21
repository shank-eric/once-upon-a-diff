/*
 * The one way the bridge runs gh: as the logged-in gh user (ghEnv drops
 * GITHUB_TOKEN when config.json says so), with DIFF_STORY_GH standing in for
 * gh in tests.
 */
import { execFile } from 'node:child_process';
import { ghEnv } from '../config.mjs';

/** The gh binary: DIFF_STORY_GH when set (the tests' fake gh), else gh on PATH. */
export const ghBinary = () => process.env.DIFF_STORY_GH || 'gh';

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
