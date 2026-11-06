/**
 * Where the bridge keeps things, and its port and token.
 *
 *   ~/.once-upon/                   ONCE_UPON_HOME overrides it
 *     config.json                  {port, token, ...personal settings (readSettings)}, mode 600
 *     house-rules.md               optional: your own rules, which the skills read and follow
 *     prefs.json                   page settings that hold across stories and restarts: {hideWhitespace, diffView,
 *                                  layout}
 *     inbox.jsonl                  questions, notes and answers, one JSON object a line
 *     cursors/<consumer>.json      how far each reader (a Claude session, a hook) has read the inbox
 *     state/<story id>/            what the bridge records per story: ui.json, position.json, viewed.json, notes.json,
 *                                  fix-settings.json, working.json
 *     <owner>-<repo>-<N>/          a story once-upon published (chapters.json, file-map.json, meta.json)
 *     local-<repo>-<branch>/       a local-commits story made by `once-upon local`
 */
import { spawnDetached } from '@once-upon-a-diff/adapters/os';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '@once-upon-a-diff/domain/bridge-port';
import { readJson, writeFileAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import type { ShipMode } from '@once-upon-a-diff/contracts/types';
import {
  ownerOnly,
  ensureDir,
  restrictFile,
  copyFile,
} from '@once-upon-a-diff/adapters/stores/fs/files';

/** config.json: the port and token, and any personal settings (readSettings). */
export interface Config {
  token: string;
  port: number;
  [key: string]: unknown;
}

/** The page settings in prefs.json. */
export interface Prefs {
  hideWhitespace: boolean;
  diffView: 'unified' | 'split';
  /** the story panel's size, the last one dragged on any page (absent until one is) */
  layout?: Layout;
}

/** The story panel's width and its questions dock's height, in pixels. */
export interface Layout {
  width?: number;
  chatHeight?: number;
}

/** A size worth keeping: a finite number of pixels, rounded, within reason; else undefined. */
const sizeOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 10000
    ? Math.round(value)
    : undefined;

/** The sizes in a saved or posted layout, or undefined when it has none. */
function layoutOf(value: unknown): Layout | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { width, chatHeight } = value as Record<string, unknown>;
  const layout: Layout = {};
  if (sizeOf(width) !== undefined) {
    layout.width = sizeOf(width);
  }
  if (sizeOf(chatHeight) !== undefined) {
    layout.chatHeight = sizeOf(chatHeight);
  }
  return Object.keys(layout).length ? layout : undefined;
}

export function homeDir(): string {
  return process.env.ONCE_UPON_HOME || path.join(os.homedir(), '.once-upon');
}

/** One of a story's state files, <home>/state/<key>/<name>, with its folder made. */
export function stateFile(home: string, key: string, name: string): string {
  const dir = path.join(home, 'state', key);
  ensureDir(dir);
  return path.join(dir, name);
}

export const newToken = () => randomBytes(24).toString('base64url');

/** The extension's ID wherever it's loaded unpacked from: the manifest's fixed key (packages/extension/wxt.config.ts). */
export const UNPACKED_EXTENSION_ID = 'faaibhigocihefldbmdgchcnnclalkmo';
const EXTENSION_ID = /^[a-p]{32}$/;

/** Reads config.json, creating it (with a fresh random token) the first time. */
export function loadConfig(home = homeDir()): Config {
  ownerOnly(home);
  const file = path.join(home, 'config.json');
  let cfg = readJson<Partial<Config>>(file, null);
  let changed = false;
  if (existsSync(file) && (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))) {
    // a crash or a bad edit left it empty or unparseable: saving a fresh one would wipe every setting in it
    const keep = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFile(file, keep);
    console.error(
      `once-upon: ${file} is empty or not JSON. Kept a copy at ${keep} and started a fresh one (new token).`,
    );
    cfg = null;
  }
  cfg ??= {};
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
  return cfg as Config; // both filled in above
}

/** One `ship` entry: a glob on owner/name (case-insensitive, `*` matches within one part) and what it picks. */
export interface ShipRule {
  pattern: string;
  mode: ShipMode;
}

const SHIP_PATTERN = /^[A-Za-z0-9_.*-]{1,100}\/[A-Za-z0-9_.*-]{1,100}$/;

/** The rules in config.json's `ship` object, in file order; anything that isn't "push" or "pr" for a repo pattern is dropped. */
function shipRulesOf(value: unknown): ShipRule[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const rules: ShipRule[] = [];
  for (const [pattern, mode] of Object.entries(value)) {
    const wanted = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    if (SHIP_PATTERN.test(pattern) && (wanted === 'push' || wanted === 'pr')) {
      rules.push({ pattern, mode: wanted });
    }
  }
  return rules;
}

/** What the `ship` rules say about a repo (owner/name): the first rule whose glob matches it, or null. */
export function shipRuleFor(repo: string | null | undefined, rules: ShipRule[]): ShipMode | null {
  if (!repo) {
    return null;
  }
  for (const rule of rules) {
    const source = rule.pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    if (new RegExp(`^${source}$`, 'i').test(repo)) {
      return rule.mode;
    }
  }
  return null;
}

/** The folders to look for checkouts in: ONCE_UPON_DEV_DIR (tests), else checkout_dirs, else ~/Development. */
function checkoutDirsOf(dirs: string[]): string[] {
  if (process.env.ONCE_UPON_DEV_DIR) {
    return [process.env.ONCE_UPON_DEV_DIR];
  }
  return dirs.length ? dirs : [path.join(os.homedir(), 'Development')];
}

const PLATFORM_OPENER: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['open'],
  win32: ['explorer'],
};

/** Repos whose branches the board's worktree cleanup never deletes, whatever config.json says (the owner's packrat rule). */
export const ALWAYS_KEEP_BRANCHES = ['everfi-frontend'];

/** Branches that are not a unit of work of their own. */
export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk']);

/** The names the bridge answers when a reverse proxy forwards them (puma-dev's *.test and *.fidev.net). */
const DEFAULT_HOSTS = ['once-upon.test', 'once-upon.fidev.net'];

/**
 * Optional personal settings in config.json, all off or neutral by default:
 *   display_name            the reviewer's name in lines the bridge writes for Claude ("where Sam's reading stopped")
 *   time_zone               an IANA zone for times the CLI prints (default: the system's), time_zone_label its label
 *   checkout_dirs           folders to look in for a repo's checkout (default ["~/Development"]; ONCE_UPON_DEV_DIR overrides)
 *   open_command            argv to open a URL or file, e.g. ["open"] (default: open, xdg-open or start by platform)
 *   gh_unset_github_token   true to drop GITHUB_TOKEN before calling gh, so gh's own (keychain) login is used
 *   house_rules             a Markdown file of your own rules the skills load (default ~/.once-upon/house-rules.md)
 *   listen_idle_minutes     how long a `wait --repo` keeps listening with no page showing one of the repo's stories (default 10;
 *                           it logs when it stops, to <home>/listeners.log). A page in a background tab still counts: it
 *                           sends a "still open" signal about once a minute, so only a closed tab runs the window out
 *   story_listener_idle_minutes  how long a `wait --story` keeps listening with no page showing its story (default 10; a
 *                           background tab counts as showing it, as above)
 *   allowed_hosts           host names the bridge answers besides 127.0.0.1 and localhost (a reverse proxy such as puma-dev
 *                           forwards the name you typed); only these exact names, which keeps DNS rebinding out
 *                           (default ["once-upon.test", "once-upon.fidev.net"])
 *   public_host             the allowed name the extension's Open board button opens the board on, over https (default: the first
 *                           allowed host; "" or "none" prints the 127.0.0.1 address)
 *   board_status_source     "iterm" or "registry": where the agent board reads each session's status (default: iterm when
 *                           the it2 CLI is found, else registry, Claude Code's own busy/idle)
 *   board_it2_path          the it2 CLI's path when it isn't on PATH or in iTerm2's app folder
 *   board_sessions_dir      Claude Code's live-session registry (default $CLAUDE_CONFIG_DIR/sessions or ~/.claude/sessions)
 *   board_projects_dir      Claude Code's transcripts, for telling a session with no prompt yet (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
 *   board_ledger_file       a Markdown file the agent registry appends a line to for each agent event, a log for people and
 *                           scripts (ledger/events.ts ledgerLine); the board does not read it; no default, off when unset
 *   board_progress_file     the same for progress beats (`- <time> <name> <N>/<M> <step>: <note>`); no default, off when unset
 *   board_larmor_dir        the Larmor checkout (~/Development/SideProjects/larmor): the board runs its
 *                           `.venv-app/bin/python app/voice_ctl.py` there for everything of Larmor's, and reads none of Larmor's
 *                           files: voice state and what was said (status, log), Pause and Resume, Start and Stop voice and the
 *                           phone buttons. Once voice has started in a session today, that session is pinned at the top of the
 *                           board instead of sitting in a column (collapsed while paused or ended). Without it there is no voice
 *                           panel and no buttons
 *   board_done_hours        how long a finished agent stays on the board (default 1)
 *   board_finished_wait_minutes  how long a finished agent (done, failed or stopped) with no card of its parent's sits in
 *                           Done, Research or Waiting, counted from its last event (default 30); an author (kind
 *                           author) in Waiting stays board_done_hours instead
 *   board_worktrees         false to leave git worktrees off the board (default: shown, with a Clean up button on the ones
 *                           whose work is in the main line)
 *   board_keep_branches     repos (a name like "widgets" or owner/name) whose branches Clean up never deletes, added to the
 *                           built-in everfi-frontend, which is always kept
 *   extension_ids           more extension IDs the bridge answers (a store install, an older unpacked copy); the
 *                           fixed unpacked ID is always allowed
 *   ship                    how a local story ships, per repo: {"owner/name": "push" | "pr"}, with * globs on owner or
 *                           name ({"shank-eric/Configuration": "push", "EverFi/*": "pr"}); the first match in file order
 *                           wins. Unlisted repos ship by branch: Push for commits on the default branch, else Create pull request
 * Read without creating config.json, so a missing file just means the defaults.
 */
export function readSettings(home = homeDir()) {
  const cfg = readJson<Record<string, unknown>>(path.join(home, 'config.json'), {}) || {};
  const expand = (dirPath: string) =>
    dirPath.startsWith('~/') ? path.join(os.homedir(), dirPath.slice(2)) : dirPath;
  const dirs = Array.isArray(cfg.checkout_dirs)
    ? cfg.checkout_dirs.filter((dir): dir is string => typeof dir === 'string' && !!dir).map(expand)
    : [];
  const hostNames = Array.isArray(cfg.allowed_hosts)
    ? cfg.allowed_hosts.filter(
        (name): name is string =>
          typeof name === 'string' && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name),
      )
    : DEFAULT_HOSTS;
  const allowedHosts = hostNames.map((name) => name.toLowerCase());
  const wantedHost =
    typeof cfg.public_host === 'string' ? cfg.public_host.trim().toLowerCase() : null;
  const publicHost =
    wantedHost === '' || wantedHost === 'none'
      ? null
      : ((wantedHost && allowedHosts.includes(wantedHost) ? wantedHost : allowedHosts[0]) ?? null);
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
    repoListenerIdleMinutes:
      typeof cfg.listen_idle_minutes === 'number' && cfg.listen_idle_minutes > 0
        ? cfg.listen_idle_minutes
        : null,
    storyListenerIdleMinutes:
      typeof cfg.story_listener_idle_minutes === 'number' && cfg.story_listener_idle_minutes > 0
        ? cfg.story_listener_idle_minutes
        : null,
    allowedHosts,
    publicHost,
    ship: shipRulesOf(cfg.ship),
    // named in config.json, so used as set; unset, the default name is used only where it resolves to this machine
    publicHostSet:
      wantedHost !== null &&
      wantedHost !== '' &&
      wantedHost !== 'none' &&
      publicHost === wantedHost,
    board: {
      statusSource:
        cfg.board_status_source === 'iterm' || cfg.board_status_source === 'registry'
          ? (cfg.board_status_source as 'iterm' | 'registry')
          : null,
      it2Path:
        typeof cfg.board_it2_path === 'string' && cfg.board_it2_path
          ? expand(cfg.board_it2_path)
          : null,
      sessionsDir:
        typeof cfg.board_sessions_dir === 'string' && cfg.board_sessions_dir
          ? expand(cfg.board_sessions_dir)
          : path.join(
              process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
              'sessions',
            ),
      projectsDir:
        typeof cfg.board_projects_dir === 'string' && cfg.board_projects_dir
          ? expand(cfg.board_projects_dir)
          : path.join(
              process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
              'projects',
            ),
      ledgerFile:
        typeof cfg.board_ledger_file === 'string' && cfg.board_ledger_file
          ? expand(cfg.board_ledger_file)
          : null,
      progressFile:
        typeof cfg.board_progress_file === 'string' && cfg.board_progress_file
          ? expand(cfg.board_progress_file)
          : null,
      larmorDir:
        typeof cfg.board_larmor_dir === 'string' && cfg.board_larmor_dir
          ? expand(cfg.board_larmor_dir)
          : null,
      doneHours:
        typeof cfg.board_done_hours === 'number' && cfg.board_done_hours > 0
          ? cfg.board_done_hours
          : 1,
      finishedWaitMinutes:
        typeof cfg.board_finished_wait_minutes === 'number' && cfg.board_finished_wait_minutes > 0
          ? cfg.board_finished_wait_minutes
          : 30,
      worktrees: cfg.board_worktrees !== false,
      // the built-in names are always kept, so a config that lists others cannot drop them
      keepBranches: [
        ...new Set([
          ...ALWAYS_KEEP_BRANCHES,
          ...(Array.isArray(cfg.board_keep_branches)
            ? cfg.board_keep_branches
                .filter((name): name is string => typeof name === 'string' && !!name.trim())
                .map((name) => name.trim().toLowerCase())
            : []),
        ]),
      ],
    },
    extensionIds: [
      UNPACKED_EXTENSION_ID,
      ...(Array.isArray(cfg.extension_ids)
        ? cfg.extension_ids.filter(
            (id): id is string => typeof id === 'string' && EXTENSION_ID.test(id),
          )
        : []),
    ],
  };
}

/** "Sam's" with a display_name, else "the reviewer's". */
export function readerOf(home = homeDir()): string {
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
export function openArgv(target: string, home = homeDir()): string[] {
  const cmd = readSettings(home).openCommand || PLATFORM_OPENER[process.platform] || ['xdg-open'];
  return [...cmd, target];
}

/** Opens a URL or file the way openArgv says, without waiting for it. */
export function openTarget(target: string, home = homeDir()): void {
  const [cmd, ...args] = openArgv(target, home);
  spawnDetached(cmd, args);
}

/** A time for the CLI's lines, in time_zone (default the system's), labelled time_zone_label or the zone's short name. */
export function formatTime(iso: string | null | undefined, home = homeDir()): string {
  if (!iso) {
    return '';
  }
  const { timeZone, timeZoneLabel } = readSettings(home);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  };
  if (timeZoneLabel !== null) {
    return new Date(iso).toLocaleString('en-US', opts) + (timeZoneLabel ? ` ${timeZoneLabel}` : '');
  }
  return new Date(iso).toLocaleString('en-US', { ...opts, timeZoneName: 'short' });
}

export function saveConfig(cfg: Partial<Config>, home = homeDir()): void {
  ownerOnly(home);
  const file = path.join(home, 'config.json');
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', 0o600);
  restrictFile(file, 0o600);
}

/**
 * Page settings the bridge keeps for every story, read on each request so a change needs no restart.
 * Only known keys are kept: {hideWhitespace: boolean, diffView: 'unified' | 'split', layout?: {width?, chatHeight?}}.
 */
export const PREF_DEFAULTS: Readonly<Prefs> = Object.freeze({
  hideWhitespace: false,
  diffView: 'unified',
});

export function readPrefs(home = homeDir()): Prefs {
  const saved = readJson<Record<string, unknown>>(path.join(home, 'prefs.json'), {}) || {};
  const layout = layoutOf(saved.layout);
  return {
    ...PREF_DEFAULTS,
    hideWhitespace: saved.hideWhitespace === true,
    diffView: saved.diffView === 'split' ? 'split' : 'unified',
    ...(layout && { layout }),
  };
}

export function writePrefs(patch: Record<string, unknown>, home = homeDir()): Prefs {
  const next = { ...readPrefs(home) };
  if ('hideWhitespace' in patch) {
    next.hideWhitespace = patch.hideWhitespace === true;
  }
  if ('diffView' in patch) {
    next.diffView = patch.diffView === 'split' ? 'split' : 'unified';
  }
  // a layout patch changes only the sizes it has
  const layout = layoutOf({ ...next.layout, ...layoutOf(patch.layout) });
  if (layout) {
    next.layout = layout;
  }
  ensureDir(home, 0o700);
  writeFileAtomic(path.join(home, 'prefs.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}
