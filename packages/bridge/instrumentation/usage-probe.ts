/*
 * The usage probe: what the entry shims (bin/once-upon.mjs, skills/once-upon/bin/story.mjs) start before any other module of
 * this repo runs, so their top-level code is counted too. It is instrumentation, not a layer: only the shims load it, and
 * nothing in src/ imports it. It starts the coverage session in adapters/usage/session.ts, which the services use to take,
 * stop and restart it.
 */
import {
  homeOf,
  isLinkedWorktree,
  isRunning,
  readMode,
  startCounting,
} from '../src/adapters/usage/session.ts';

/**
 * Starts counting for this process, unless the capture is off (ONCE_UPON_USAGE=0 or the settings file), the command is
 * `usage ...` (a report must not count itself) or this is a linked worktree (ONCE_UPON_USAGE=force overrides that, for
 * the tests). Returns whether it started. Never throws: the tool must run whatever the inspector does.
 */
export function begin(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (isRunning()) {
      return true;
    }
    const mode = readMode(homeOf(env), env);
    const command = argv.find((word) => !word.startsWith('-'));
    if (mode === 'off' || command === 'usage') {
      return false;
    }
    if (env.ONCE_UPON_USAGE !== 'force' && isLinkedWorktree()) {
      return false;
    }
    startCounting(mode === 'lines');
    return true;
  } catch {
    return false;
  }
}
