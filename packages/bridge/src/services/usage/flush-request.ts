/*
 * Asks the running bridge for fresh usage data before a report reads it: a signal (SIGUSR2), never HTTP (the CLI never calls
 * the bridge over HTTP). SIGUSR2's default is to end the process, so the signal goes only to a process that wrote
 * usage/bridge-pid.json, which it does once its handler is installed, and whose command line is still `once-upon ... serve`.
 */
import { commandOf, pidAlive, signalProcess } from '../../adapters/os.ts';
import { readUsageJson } from '../../adapters/stores/usage-file.ts';
import { BRIDGE_PID_FILE, coverageFileOf, type BridgePid } from './capture.ts';
import type { CoverageFile } from './merge.ts';
import type { ActionsFile } from './counters.ts';

export type FlushOutcome = 'flushed' | 'no-bridge' | 'no-answer';

const SERVE_RE = /\bonce-upon\b.*\bserve\b/;
const lastFlushes = (home: string) => [
  readUsageJson<CoverageFile>(home, coverageFileOf('bridge'))?.lastFlush ?? '',
  readUsageJson<ActionsFile>(home, 'actions.json')?.lastFlush ?? '',
];

/** Whether this home has a bridge that said it answers SIGUSR2, and is still that process. */
export function flushableBridge(home: string): number | null {
  const file = readUsageJson<BridgePid>(home, BRIDGE_PID_FILE);
  if (!file || !Number.isInteger(file.pid) || file.pid <= 1 || !pidAlive(file.pid)) {
    return null;
  }
  const command = commandOf(file.pid);
  return command && SERVE_RE.test(command) ? file.pid : null;
}

/** Signals the bridge and waits up to `waitMs` for its files' lastFlush to move (it always stamps one). */
export async function askBridgeToFlush(home: string, waitMs = 1000): Promise<FlushOutcome> {
  const pid = flushableBridge(home);
  if (!pid) {
    return 'no-bridge';
  }
  const before = lastFlushes(home);
  if (!signalProcess(pid, 'SIGUSR2')) {
    return 'no-bridge';
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const now = lastFlushes(home);
    if (now[0] !== before[0] && now[1] !== before[1]) {
      return 'flushed';
    }
  }
  return 'no-answer';
}
