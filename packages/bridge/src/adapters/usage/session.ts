/*
 * The usage capture's V8 coverage session, the one adapter that talks to `node:inspector`, and what is read beside it: the
 * checkout it runs from, what usage/settings.json asks for, and the coverage shapes. The entry shims start it through
 * instrumentation/usage-probe.ts (`begin`), before any other module of this repo runs, so it imports nothing from this repo
 * and is never reported (UNMEASURED): it runs before the counting starts, and nothing it does counts against the code measured.
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

/** The checkout this code runs from: <root>/packages/bridge/src/adapters/usage/session.ts. */
export const CHECKOUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** The files that start the measuring: they run before it does, so they are never reported. */
export const UNMEASURED = [
  'packages/bridge/instrumentation/usage-probe.ts',
  'packages/bridge/src/adapters/usage/session.ts',
  'packages/bridge/bin/once-upon.mjs',
  'packages/bridge/bin/node-version.mjs',
  'skills/once-upon/bin/story.mjs',
];

export const homeOf = (env: NodeJS.ProcessEnv) =>
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

/** Starts counting in this process (throws when the inspector cannot; `begin` catches that). */
export function startCounting(detailed: boolean): void {
  running = startSession(detailed);
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
