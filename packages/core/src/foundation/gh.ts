/** gh as the logged-in gh user: config.json decides whether GITHUB_TOKEN is dropped from the environment (ghEnv). */
import { runGh as run } from '../adapters/github.ts';
import { ghEnv } from './settings.ts';

/** Runs gh with these arguments and resolves to its stdout (see adapters/github.ts). */
export const runGh: typeof run = (args, options = {}) =>
  run(args, { ...options, env: options.env ?? ghEnv() });
