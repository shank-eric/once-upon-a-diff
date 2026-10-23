// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/**
 * Where the bridge keeps things, and its port and token.
 *
 *   ~/.once-upon/                   ONCE_UPON_HOME overrides it
 *     config.json                  {port, token, ...personal settings (readSettings)}, mode 600
 *     house-rules.md               optional: your own rules, which the skills read and follow
 *     prefs.json                   page settings that hold across stories and restarts: {hideWhitespace, diffView}
 *     inbox.jsonl                  questions, notes and answers, one JSON object a line
 *     cursors/<consumer>.json      how far each reader (a Claude session, a hook) has read the inbox
 *     state/<story id>/            what the bridge records per story: ui.json, position.json, viewed.json, notes.json,
 *                                  fix-settings.json, working.json
 *     <owner>-<repo>-<N>/          a story once-upon published (chapters.json, file-map.json, meta.json)
 *     local-<repo>-<branch>/       a local-commits story made by `once-upon local`
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '@once-upon-a-diff/shared/util/bridge-port';
import { readJson } from '../util/json-file.ts';

export function homeDir() {
  return process.env.ONCE_UPON_HOME || path.join(os.homedir(), '.once-upon');
}

/** One of a story's state files, <home>/state/<key>/<name>, with its folder made. */
export function stateFile(home, key, name) {
  const dir = path.join(home, 'state', key);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

export const newToken = () => randomBytes(24).toString('base64url');

/** Reads config.json, creating it (with a fresh random token) the first time. */
export function loadConfig(home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');
  /** @type {{token?: string, port?: number, [key: string]: unknown}} */
  const cfg = readJson(file, {}) || {};
  let changed = false;
  if (!cfg.token) {
    cfg.token = newToken();
    changed = true;
  }
  if (!cfg.port) {
    cfg.port = DEFAULT_PORT;
    changed = true;
  }
  if (changed) {
    saveConfig(cfg, home);
  }
  return cfg;
}

/** The folders to look for checkouts in: ONCE_UPON_DEV_DIR (tests), else checkout_dirs, else ~/Development. */
function checkoutDirsOf(dirs) {
  if (process.env.ONCE_UPON_DEV_DIR) {
    return [process.env.ONCE_UPON_DEV_DIR];
  }
  return dirs.length ? dirs : [path.join(os.homedir(), 'Development')];
}

const PLATFORM_OPENER = { darwin: ['open'], win32: ['explorer'] };

/**
 * Optional personal settings in config.json, all off or neutral by default:
 *   display_name            the reviewer's name in lines the bridge writes for Claude ("where Sam's reading stopped")
 *   time_zone               an IANA zone for times the CLI prints (default: the system's), time_zone_label its label
 *   checkout_dirs           folders to look in for a repo's checkout (default ["~/Development"]; ONCE_UPON_DEV_DIR overrides)
 *   open_command            argv to open a URL or file, e.g. ["open"] (default: open, xdg-open or start by platform)
 *   gh_unset_github_token   true to drop GITHUB_TOKEN before calling gh, so gh's own (keychain) login is used
 *   house_rules             a Markdown file of your own rules the skills load (default ~/.once-upon/house-rules.md)
 * Read without creating config.json, so a missing file just means the defaults.
 */
export function readSettings(home = homeDir()) {
  const cfg = readJson(path.join(home, 'config.json'), {}) || {};
  const expand = (dirPath) =>
    dirPath.startsWith('~/') ? path.join(os.homedir(), dirPath.slice(2)) : dirPath;
  const dirs = Array.isArray(cfg.checkout_dirs)
    ? cfg.checkout_dirs.filter((dir) => typeof dir === 'string' && dir).map(expand)
    : [];
  return {
    displayName:
      typeof cfg.display_name === 'string' && cfg.display_name.trim()
        ? cfg.display_name.trim()
        : null,
    timeZone: typeof cfg.time_zone === 'string' && cfg.time_zone ? cfg.time_zone : undefined,
    timeZoneLabel: typeof cfg.time_zone_label === 'string' ? cfg.time_zone_label : null,
    checkoutDirs: checkoutDirsOf(dirs),
    openCommand:
      Array.isArray(cfg.open_command) && cfg.open_command.length
        ? cfg.open_command.map(String)
        : null,
    unsetGithubToken: cfg.gh_unset_github_token === true,
  };
}

/** "Sam's" with a display_name, else "the reviewer's". */
export function readerOf(home = homeDir()) {
  const name = readSettings(home).displayName;
  return name ? `${name}'s` : "the reviewer's";
}

/** The environment for a gh call: GITHUB_TOKEN dropped only when config.json asks for it. */
export function ghEnv(home = homeDir(), base = process.env) {
  const env = { ...base };
  if (readSettings(home).unsetGithubToken) {
    delete env.GITHUB_TOKEN;
  }
  return env;
}

/** argv that opens a URL or file: open_command, else the platform's usual opener. */
export function openArgv(target, home = homeDir()) {
  const cmd = readSettings(home).openCommand || PLATFORM_OPENER[process.platform] || ['xdg-open'];
  return [...cmd, target];
}

/** A time for the CLI's lines, in time_zone (default the system's), labelled time_zone_label or the zone's short name. */
export function formatTime(iso, home = homeDir()) {
  if (!iso) {
    return '';
  }
  const { timeZone, timeZoneLabel } = readSettings(home);
  /** @type {Intl.DateTimeFormatOptions} */
  const opts = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone };
  if (timeZoneLabel !== null) {
    return new Date(iso).toLocaleString('en-US', opts) + (timeZoneLabel ? ` ${timeZoneLabel}` : '');
  }
  return new Date(iso).toLocaleString('en-US', { ...opts, timeZoneName: 'short' });
}

export function saveConfig(cfg, home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Page settings the bridge keeps for every story, read on each request so a change needs no restart.
 * Only known keys are kept: {hideWhitespace: boolean, diffView: 'unified' | 'split'}.
 */
export const PREF_DEFAULTS = Object.freeze({ hideWhitespace: false, diffView: 'unified' });

export function readPrefs(home = homeDir()) {
  const saved = readJson(path.join(home, 'prefs.json'), {}) || {};
  return {
    ...PREF_DEFAULTS,
    hideWhitespace: saved.hideWhitespace === true,
    diffView: saved.diffView === 'split' ? 'split' : 'unified',
  };
}

export function writePrefs(patch, home = homeDir()) {
  const next = { ...readPrefs(home) };
  if ('hideWhitespace' in patch) {
    next.hideWhitespace = patch.hideWhitespace === true;
  }
  if ('diffView' in patch) {
    next.diffView = patch.diffView === 'split' ? 'split' : 'unified';
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, 'prefs.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}
