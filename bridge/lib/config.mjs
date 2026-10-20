/**
 * Where the bridge keeps things, and its port and token.
 *
 *   ~/.diff-story/                 DIFF_STORY_HOME overrides it
 *     config.json                  {port, token, roots}, mode 600
 *     inbox.jsonl                  questions, positions, notes and answers, one JSON object a line
 *     cursors/<consumer>.json      how far each reader (a Claude session, a hook) has read the inbox
 *     state/<story id>/            what the bridge records per story: ui.json, position.json, viewed.json, notes.json
 *     <owner>-<repo>-<N>/          a story pr-story published (chapters.json, file-map.json, meta.json)
 *     local-<repo>-<branch>/       a local-commits story made by `diff-story local`
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4823;

export function homeDir() {
  return process.env.DIFF_STORY_HOME || path.join(os.homedir(), '.diff-story');
}

/** pr-story's scratch layout: /private/tmp/claude-<uid>/<project>/<session>/scratchpad/pr-story/<repo>-<N>/ */
export function scratchBases() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return [...new Set([`/private/tmp/claude-${uid}`, path.join(os.tmpdir(), `claude-${uid}`)])];
}

export const newToken = () => randomBytes(24).toString('base64url');

/** Reads config.json, creating it (with a fresh random token) the first time. */
export function loadConfig(home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { cfg = {}; }
  }
  let changed = false;
  if (!cfg.token) { cfg.token = newToken(); changed = true; }
  if (!cfg.port) { cfg.port = DEFAULT_PORT; changed = true; }
  if (changed) saveConfig(cfg, home);
  return cfg;
}

export function saveConfig(cfg, home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
