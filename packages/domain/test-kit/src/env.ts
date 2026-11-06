/**
 * Isolation for a test that touches the bridge's files: import this first. Tests never look in (or move stories into) the
 * real ~/Development checkouts, never read the real ~/.claude (the board's registry and transcripts are found under it by
 * default), never read the real ~/.once-upon (its config.json names the real Larmor checkout, so no test runs the real
 * voice_ctl or reads ~/.larmor), and take the proxy name as reaching this machine, so no test depends on the machine's DNS.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoLiveTimers } from './timers.ts';

assertNoLiveTimers();

process.env.ONCE_UPON_DEV_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-dev-'));
export const CLAUDE_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-claude-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
// the bridge's home holds config.json, whose board_larmor_dir names the real Larmor checkout (voice_ctl, and through it
// ~/.larmor): a test that does not make its own home gets this empty one, never Eric's ~/.once-upon
export const HOME_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-home-'));
process.env.ONCE_UPON_HOME = HOME_DIR;
process.env.ONCE_UPON_NO_HOST_CHECK = '1';
