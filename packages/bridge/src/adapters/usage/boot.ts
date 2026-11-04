/*
 * V8 coverage for the usage capture: the one adapter that talks to `node:inspector`. It imports nothing from this repo, so
 * the entry shims (bin/once-upon.mjs, skills/once-upon/bin/story.mjs) can load it and start counting before any other
 * module runs, and nothing it does is counted against the code being measured (the reduction skips this file and the shims).
 *
 * Function level by default (precise coverage with no block ranges, which costs next to nothing); `lines` mode adds block
 * ranges, which measured about 2.4x CPU on hot code, so it is an opt-in (`once-upon usage on --lines`).
 * The inspector's callbacks run synchronously on the main thread, so a take works inside an `exit` or signal handler.
 */
import inspector from 'node:inspector';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type UsageMode = 'off' | 'function' | 'lines';

/** One function's ranges, as V8 reports them. */
export interface CoverageFunction {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: { startOffset: number; endOffset: number; count: number }[];
}
/** One script's coverage since the last take. */
export interface ScriptCoverage {
  url: string;
  functions: CoverageFunction[];
}

/** The checkout this code runs from: <root>/packages/bridge/src/adapters/usage/boot.ts. */
export const CHECKOUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** The files that start the measuring: they run before it does, so they are never reported. */
export const UNMEASURED = [
  'packages/bridge/src/adapters/usage/boot.ts',
  'packages/bridge/bin/once-upon.mjs',
  'packages/bridge/bin/node-version.mjs',
  'skills/once-upon/bin/story.mjs',
];

const homeOf = (env: NodeJS.ProcessEnv) =>
  env.ONCE_UPON_HOME || path.join(os.homedir(), '.once-upon');
export const usageDirOf = (home: string) => path.join(home, 'usage');

/**
 * What usage/settings.json asks for ('function' when it is missing or unreadable), and 'off' when ONCE_UPON_USAGE=0.
 * Read without any other module of this repo, so the shims can ask before anything is loaded.
 */
export function readMode(
  home = homeOf(process.env),
  env: NodeJS.ProcessEnv = process.env,
): UsageMode {
  if (env.ONCE_UPON_USAGE === '0') {
    return 'off';
  }
  try {
    const file = path.join(usageDirOf(home), 'settings.json');
    const mode = (JSON.parse(readFileSync(file, 'utf8')) as { mode?: unknown }).mode;
    return mode === 'off' || mode === 'lines' ? mode : 'function';
  } catch {
    return 'function';
  }
}

/** Whether this checkout is a linked worktree (its .git is a file): agents run those all day, and that is not the user's use. */
export function isLinkedWorktree(root = CHECKOUT): boolean {
  try {
    return statSync(path.join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

interface Running {
  session: inspector.Session;
  detailed: boolean;
  startedAt: number;
}
let running: Running | null = null;

function post<T>(session: inspector.Session, method: string, params?: object): T {
  let answer: unknown;
  let failure: Error | null = null;
  session.post(method, params, (err, result) => {
    failure = err;
    answer = result;
  });
  if (failure) {
    throw failure;
  }
  return answer as T;
}

function startSession(detailed: boolean): Running {
  const session = new inspector.Session();
  session.connect();
  post(session, 'Profiler.enable');
  post(session, 'Profiler.startPreciseCoverage', { callCount: false, detailed });
  return { session, detailed, startedAt: Date.now() };
}

/**
 * Starts counting for this process, unless the capture is off (ONCE_UPON_USAGE=0 or the settings file), the command is
 * `usage ...` (a report must not count itself) or this is a linked worktree (ONCE_UPON_USAGE=force overrides that, for
 * the tests). Returns whether it started. Never throws: the tool must run whatever the inspector does.
 */
export function begin(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (running) {
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
    running = startSession(mode === 'lines');
    return true;
  } catch {
    running = null;
    return false;
  }
}

/** Whether counting is on in this process. */
export const isRunning = (): boolean => running !== null;
/** Whether the running session keeps block ranges. */
export const isDetailed = (): boolean => running?.detailed === true;
/** When counting started (ms), or 0. */
export const startedAtMs = (): number => running?.startedAt ?? 0;

/** What ran in this checkout's own files since the last take (and resets the counters). */
export function take(): ScriptCoverage[] {
  if (!running) {
    return [];
  }
  const { result } = post<{ result: ScriptCoverage[] }>(
    running.session,
    'Profiler.takePreciseCoverage',
  );
  const prefix = pathToFileURL(CHECKOUT).href + '/';
  return result.filter(
    (script) => script.url.startsWith(prefix) && !script.url.includes('/node_modules/'),
  );
}

/** Stops counting. */
export function stop(): void {
  if (!running) {
    return;
  }
  try {
    post(running.session, 'Profiler.stopPreciseCoverage');
    running.session.disconnect();
  } catch {
    /* already gone */
  }
  running = null;
}

/** Counts again with block ranges on or off (a mode change while the bridge runs). */
export function restart(detailed: boolean): void {
  stop();
  try {
    running = startSession(detailed);
  } catch {
    running = null;
  }
}
