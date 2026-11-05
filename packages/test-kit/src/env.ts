/**
 * Isolation for a test that touches the bridge's files: import this first. Tests never look in (or move stories into) the
 * real ~/Development checkouts, never read the real ~/.claude (the board's registry and transcripts are found under it by
 * default), and take the proxy name as reaching this machine, so no test depends on the machine's DNS.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoLiveTimers } from './timers.ts';

assertNoLiveTimers();

process.env.ONCE_UPON_DEV_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-dev-'));
export const CLAUDE_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-claude-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
process.env.ONCE_UPON_NO_HOST_CHECK = '1';
