/**
 * Where the bridge keeps things, and its port and token.
 *
 *   ~/.diff-story/                 DIFF_STORY_HOME overrides it
 *     config.json                  {port, token, roots, ...personal settings (readSettings)}, mode 600
 *     house-rules.md               optional: your own rules, which the skills read and follow
 *     prefs.json                   page settings that hold across stories and restarts: {hideWhitespace, diffView}
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
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      cfg = {};
    }
  }
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

/** The folders to look for checkouts in: DIFF_STORY_DEV_DIR (tests), else checkout_dirs, else ~/Development. */
function checkoutDirsOf(dirs) {
  if (process.env.DIFF_STORY_DEV_DIR) {
    return [process.env.DIFF_STORY_DEV_DIR];
  }
  return dirs.length ? dirs : [path.join(os.homedir(), 'Development')];
}

const PLATFORM_OPENER = { darwin: ['open'], win32: ['explorer'] };

/**
 * Optional personal settings in config.json, all off or neutral by default:
 *   display_name            the reviewer's name in lines the bridge writes for Claude ("where Sam's reading stopped")
 *   time_zone               an IANA zone for times the CLI prints (default: the system's), time_zone_label its label
 *   checkout_dirs           folders to look in for a repo's checkout (default ["~/Development"]; DIFF_STORY_DEV_DIR overrides)
 *   open_command            argv to open a URL or file, e.g. ["open"] (default: open, xdg-open or start by platform)
 *   gh_unset_github_token   true to drop GITHUB_TOKEN before calling gh, so gh's own (keychain) login is used
 *   house_rules             a Markdown file of your own rules the skills load (default ~/.diff-story/house-rules.md)
 * Read without creating config.json, so a missing file just means the defaults.
 */
export function readSettings(home = homeDir()) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) || {};
  } catch {
    cfg = {};
  }
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
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(path.join(home, 'prefs.json'), 'utf8')) || {};
  } catch {
    saved = {};
  }
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
