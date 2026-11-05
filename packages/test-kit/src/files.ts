import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoLiveTimers } from './timers.ts';

// every test that makes a temp folder (the bridge's, the core's and the git helpers' do) is a process the guard watches for what it leaves running
assertNoLiveTimers();

/** A new empty folder in the system's temp dir, named for what it is for. */
export const tmp = (name: string): string =>
  mkdtempSync(path.join(os.tmpdir(), `once-upon-${name}-`));

/** Writes `value` as pretty JSON, making the folders above the file. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}
