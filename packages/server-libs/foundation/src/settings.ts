/**
 * Where the bridge keeps things, and its port and token.
 *
 *   ~/.once-upon/                   ONCE_UPON_HOME overrides it
 *     token                        the bridge token (and what every page key is derived from), mode 600: one line, never printed
 *     config.json                  {port, ...personal settings (readSettings)}, mode 600: safe to print, it holds no secret
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '@once-upon-a-diff/terms/bridge-port';
import { repoKey } from '@once-upon-a-diff/terms/ids';
import { repoName } from '@once-upon-a-diff/terms/text';
import {
  readJson,
  writeFileAtomic,
  writeFileIfAbsent,
} from '@once-upon-a-diff/adapters/stores/fs/json-file';
import {
  ownerOnly,
  ensureDir,
  restrictFile,
  copyFile,
} from '@once-upon-a-diff/adapters/stores/fs/files';

/** config.json's port and any personal settings (readSettings), and the token, which lives in the token file. */
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
interface Layout {
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

/** One of a story's state files, <home>/state/<key>/<name>. Only names the path: a read leaves no folder behind. */
export function stateFile(home: string, key: string, name: string): string {
  return path.join(home, 'state', key, name);
}

/** The same path, with its folder made, for a writer to write into. */
export function stateFileToWrite(home: string, key: string, name: string): string {
  ensureDir(path.join(home, 'state', key));
  return stateFile(home, key, name);
}

export const newToken = () => randomBytes(24).toString('base64url');

/** The extension's ID wherever it's loaded unpacked from: the manifest's fixed key (packages/client/extension/wxt.config.ts). */
export const UNPACKED_EXTENSION_ID = 'faaibhigocihefldbmdgchcnnclalkmo';
const EXTENSION_ID = /^[a-p]{32}$/;

/** The token file: <home>/token, one line, mode 600. Where the token lives; config.json holds none. */
export const tokenFile = (home = homeDir()): string => path.join(home, 'token');

/** The token file's token (its trailing newline trimmed), or '' when the file is missing, empty or unreadable. */
function readTokenFile(home: string): string {
  try {
    return readFileSync(tokenFile(home), 'utf8').trim();
  } catch {
    return '';
  }
}

/** The file's mode in octal text ('600'), or null when it is not there. */
export function modeOfFile(file: string): string | null {
  try {
    return (statSync(file).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

/** A parsed config.json that is a plain object, else null (missing, empty, unparseable, an array or a scalar). */
function readConfigObject(home: string): Partial<Config> | null {
  const cfg = readJson<unknown>(path.join(home, 'config.json'), null);
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as Partial<Config>) : null;
}

/** A token an older config.json still holds (before `loadConfig` moved it to the token file), else ''. */
const legacyTokenOf = (cfg: Partial<Config> | null): string =>
  typeof cfg?.token === 'string' ? cfg.token.trim() : '';

/**
 * What the config says now, for a command that only reads: the port defaults to DEFAULT_PORT and the token is '' when there
 * is none. The token is the token file's, else (a home `loadConfig` has not migrated yet) the one still in config.json.
 * A missing, unparseable or non-object config.json reads as empty. Writes, makes and changes the mode of nothing:
 * `loadConfig` is the writer, for the commands that hand out or use the token.
 */
export function readConfig(home = homeDir()): Config {
  const saved = readConfigObject(home) ?? {};
  return {
    ...saved,
    token: readTokenFile(home) || legacyTokenOf(saved),
    port: saved.port || DEFAULT_PORT,
  };
}

/** Whether config.json still holds a token key (an older layout, or a hand edit): `loadConfig` takes it out. */
export const configHoldsToken = (home = homeDir()): boolean =>
  readConfigObject(home) !== null && 'token' in (readConfigObject(home) as object);

/** Every setting config.json holds, with the port defaulted and the token left out (it is not a setting: `readConfig` has it). */
export function readConfigValues(home = homeDir()): Record<string, unknown> {
  const { token: _token, ...saved } = readConfigObject(home) ?? {};
  return { ...saved, port: saved.port || DEFAULT_PORT };
}

/**
 * Writes the token file, replacing what is there (`once-upon token --rotate`). The new token lands whole through a rename,
 * mode 600; config.json is not touched.
 */
export function saveToken(token: string, home = homeDir()): void {
  ownerOnly(home);
  const file = tokenFile(home);
  writeFileAtomic(file, `${token}\n`, 0o600);
  restrictFile(file, 0o600);
}

/**
 * Makes the token file with this token when it is not there, and returns the token the file holds: the winner's when another
 * process made it first (two commands on a fresh home each mint a token, and only one may stand). An empty file counts as
 * missing and is replaced.
 */
function claimToken(token: string, home: string): string {
  const file = tokenFile(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writeFileIfAbsent(file, `${token}\n`, 0o600)) {
      return token;
    }
    const held = readTokenFile(home);
    if (held) {
      return held;
    }
    // there but empty (a hand edit or a crash from an older tool): replace it
    saveToken(token, home);
  }
  return readTokenFile(home) || token;
}

/**
 * Reads the config, making what is missing: the token file with a fresh random token the first time, and config.json with the
 * port. A token an older config.json still holds moves to the token file (written first and then dropped from config.json, so
 * a crash leaves both and the next run cleans up, never neither); the token file wins when both hold one. The writer: a
 * read-only command uses `readConfig`.
 */
export function loadConfig(home = homeDir()): Config {
  ownerOnly(home);
  const file = path.join(home, 'config.json');
  let cfg = readConfigObject(home);
  if (existsSync(file) && !cfg) {
    // a crash or a bad edit left it empty or unparseable: saving a fresh one would wipe every setting in it
    const keep = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFile(file, keep);
    restrictFile(keep, 0o600); // it may hold a token we could not parse out
    const newTokenNote = readTokenFile(home) ? '' : ' (new token)';
    console.error(
      `once-upon: ${file} is empty or not JSON. Kept a copy at ${keep} and started a fresh one${newTokenNote}.`,
    );
  }
  let token = readTokenFile(home);
  if (token) {
    if (modeOfFile(tokenFile(home)) !== '600') {
      restrictFile(tokenFile(home), 0o600);
    }
  } else {
    token = claimToken(legacyTokenOf(cfg) || newToken(), home);
  }
  if (!cfg || 'token' in cfg || !cfg.port) {
    // read it again just before the rewrite, and take out only the token: a hand edit made since is kept
    cfg = readConfigObject(home) ?? {};
    saveConfig({ ...cfg, port: cfg.port || DEFAULT_PORT }, home);
    cfg = readConfigObject(home) ?? {};
  }
  return { ...cfg, token, port: cfg.port || DEFAULT_PORT };
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

/** What config.json's `repos` block says about one repo; every field is optional and a wrong type is dropped. */
export interface RepoSettings {
  /** finished work skips review and is Ready to ship (the board's row 6) */
  skips_review?: boolean;
  /** whether the repo's work gets a story (unset: the editor's profile prose decides) */
  stories?: boolean;
  /** `local` deploys by the repo's own deploy command; `pr` ships through a pull request (unset: the profile decides) */
  deploy?: 'local' | 'pr';
  /** Clean up never deletes this repo's branches */
  keep_branches?: boolean;
  /** the repo's deploy runs the full gate (suite, whole-repo typecheck, lint), so an author's brief defers them to it */
  deploy_gate?: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const REPO_FLAGS = ['skips_review', 'stories', 'keep_branches', 'deploy_gate'] as const;

/** One repo's entry, with every field of the wrong type dropped. */
function readRepoEntry(entry: Record<string, unknown>): RepoSettings {
  const settings: RepoSettings = {};
  for (const field of REPO_FLAGS) {
    if (typeof entry[field] === 'boolean') {
      settings[field] = entry[field];
    }
  }
  if (entry.deploy === 'local' || entry.deploy === 'pr') {
    settings.deploy = entry.deploy;
  }
  return settings;
}

const readRepos = (value: unknown): Record<string, RepoSettings> => {
  const repos: Record<string, RepoSettings> = {};
  for (const [key, raw] of Object.entries(isPlainObject(value) ? value : {})) {
    if (key.trim() && isPlainObject(raw)) {
      repos[key.trim().toLowerCase()] = readRepoEntry(raw);
    }
  }
  return repos;
};

/** A repo ships by pull request unless its settings say it skips review or deploys locally: a repo with no entry is a PR repo. */
export const shipsByPr = (settings: RepoSettings): boolean =>
  !(settings.skips_review || settings.deploy === 'local');

/**
 * One repo's settings from `readSettings(...).repos`: an owner/name entry first, then the bare name, in any case; `{}` when none.
 * A bare repo name (no owner, as `once-upon repo settings larmor` types it) also finds an owner/name entry by its name part.
 */
export function repoSettings(
  settings: { repos: Record<string, RepoSettings> },
  repo: string | null | undefined,
): RepoSettings {
  if (!repo) {
    return {};
  }
  const exact = settings.repos[repoKey(repo)];
  if (exact) {
    return exact;
  }
  if (repo.includes('/')) {
    return settings.repos[repoName(repo).toLowerCase()] ?? {};
  }
  const bare = repo.trim().toLowerCase();
  const key = Object.keys(settings.repos).find((one) => repoName(one).toLowerCase() === bare);
  return settings.repos[bare] ?? (key ? settings.repos[key] : undefined) ?? {};
}

/** Branches that are not a unit of work of their own. */
export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk']);

/** Whether a branch can name one piece of work: a feature branch, never a default branch or a detached HEAD (no branch). */
export const isFeatureBranch = (branch: string | null | undefined): branch is string =>
  !!branch && !DEFAULT_BRANCHES.has(branch);

/** The names the bridge answers when a reverse proxy forwards them (puma-dev's *.test and *.fidev.net). */
const DEFAULT_HOSTS = ['once-upon.test', 'once-upon.fidev.net'];

/** The strings of a list setting that pass `keep` (nothing when the setting is not a list). */
const stringsOf = (value: unknown, keep: (item: string) => boolean): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && keep(item))
    : [];

/** A setting that is a string with something in it, else null. */
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A setting that is a string with something in it besides spaces, trimmed, else null. */
const trimmedText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** A setting that is a number above zero, else null. */
const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && value > 0 ? value : null;

const expand = (dirPath: string): string =>
  dirPath.startsWith('~/') ? path.join(os.homedir(), dirPath.slice(2)) : dirPath;

/** A setting that names a file or folder (a leading `~/` is the home folder), else null. */
const pathSetting = (value: unknown): string | null => {
  const named = text(value);
  return named === null ? null : expand(named);
};

/** Claude Code's own folder (`name` inside $CLAUDE_CONFIG_DIR or ~/.claude), unless the setting names another. */
const claudeDirSetting = (value: unknown, name: string): string =>
  pathSetting(value) ??
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), name);

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** The allowed name the Open board button uses: the one asked for when it is allowed, else the first; null when asked for none. */
const publicHostOf = (wanted: string | null, allowed: string[]): string | null =>
  wanted === '' || wanted === 'none'
    ? null
    : ((wanted && allowed.includes(wanted) ? wanted : allowed[0]) ?? null);

/** The names the bridge answers, the one the extension's Open board button opens, and whether config.json named it. */
function readHosts(cfg: Record<string, unknown>) {
  const named = Array.isArray(cfg.allowed_hosts)
    ? stringsOf(cfg.allowed_hosts, (name) => HOST_RE.test(name))
    : DEFAULT_HOSTS;
  const allowedHosts = named.map((name) => name.toLowerCase());
  const wanted = typeof cfg.public_host === 'string' ? cfg.public_host.trim().toLowerCase() : null;
  const publicHost = publicHostOf(wanted, allowedHosts);
  // named in config.json, so used as set; unset, the default name is used only where it resolves to this machine
  const publicHostSet = !!wanted && wanted !== 'none' && publicHost === wanted;
  return { allowedHosts, publicHost, publicHostSet };
}

/** The board's settings: `repos` is read already, since a repo's `keep_branches` joins the `board_keep_branches` list. */
function readBoard(cfg: Record<string, unknown>, repos: Record<string, RepoSettings>) {
  const keepNames = stringsOf(cfg.board_keep_branches, (name) => !!name.trim()).map((name) =>
    name.trim().toLowerCase(),
  );
  const keptByRepo = Object.entries(repos)
    .filter(([, entry]) => entry.keep_branches)
    .map(([key]) => key);
  return {
    it2Path: pathSetting(cfg.board_it2_path),
    sessionsDir: claudeDirSetting(cfg.board_sessions_dir, 'sessions'),
    projectsDir: claudeDirSetting(cfg.board_projects_dir, 'projects'),
    ledgerFile: pathSetting(cfg.board_ledger_file),
    progressFile: pathSetting(cfg.board_progress_file),
    larmorDir: pathSetting(cfg.board_larmor_dir),
    doneHours: positiveNumber(cfg.board_done_hours) ?? 1,
    finishedWaitMinutes: positiveNumber(cfg.board_finished_wait_minutes) ?? 30,
    worktrees: cfg.board_worktrees !== false,
    keepBranches: [...new Set([...keepNames, ...keptByRepo])],
  };
}

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
 *   board_it2_path          the it2 CLI's path when it isn't on PATH or in iTerm2's app folder (typing into tabs and raising them)
 *   board_sessions_dir      Claude Code's live-session registry (default $CLAUDE_CONFIG_DIR/sessions or ~/.claude/sessions)
 *   board_projects_dir      Claude Code's transcripts, for telling a session with no prompt yet (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
 *   board_ledger_file       a Markdown file the agent registry appends a line to for each agent event, a log for people and
 *                           scripts (ledger/events.ts ledgerLine); the board does not read it; no default, off when unset
 *   board_progress_file     the same for progress beats (`- <time> <name> <N>/<M> <step>: <note>`); no default, off when unset
 *   board_larmor_dir        optional voice add-on, for people who run Larmor (a voice MCP): its checkout. The board runs its
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
 *   board_keep_branches     repos (a name like "widgets" or owner/name) whose branches Clean up never deletes (nothing is
 *                           built in: `repos.<name>.keep_branches` below does the same, per repo)
 *   repos                   per-repo settings the board and the editor both read, keyed by a bare repo name or owner/name
 *                           (any case): {"larmor": {"skips_review": true, "stories": false, "deploy": "local"},
 *                           "everfi-frontend": {"stories": true, "deploy": "pr", "keep_branches": true}}.
 *                           skips_review: finished work is Ready to ship, not Ready for your review; stories: the repo's work
 *                           gets a story; deploy: "local" (its own deploy command) or "pr"; keep_branches: Clean up never
 *                           deletes its branches. All optional; a wrong type is dropped. `once-upon repo settings` prints them
 *   extension_ids           more extension IDs the bridge answers (a store install, an older unpacked copy); the
 *                           fixed unpacked ID is always allowed
 * Read without creating config.json, so a missing file just means the defaults.
 */
export function readSettings(home = homeDir()) {
  const cfg = readJson<Record<string, unknown>>(path.join(home, 'config.json'), {}) || {};
  const repos = readRepos(cfg.repos);
  return {
    displayName: trimmedText(cfg.display_name),
    timeZone: text(cfg.time_zone) ?? undefined,
    timeZoneLabel: typeof cfg.time_zone_label === 'string' ? cfg.time_zone_label : null,
    checkoutDirs: checkoutDirsOf(stringsOf(cfg.checkout_dirs, (dir) => !!dir).map(expand)),
    openCommand:
      Array.isArray(cfg.open_command) && cfg.open_command.length
        ? cfg.open_command.map(String)
        : null,
    unsetGithubToken: cfg.gh_unset_github_token === true,
    repoListenerIdleMinutes: positiveNumber(cfg.listen_idle_minutes),
    storyListenerIdleMinutes: positiveNumber(cfg.story_listener_idle_minutes),
    ...readHosts(cfg),
    board: readBoard(cfg, repos),
    repos,
    extensionIds: [
      UNPACKED_EXTENSION_ID,
      ...stringsOf(cfg.extension_ids, (id) => EXTENSION_ID.test(id)),
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
function openArgv(target: string, home = homeDir()): string[] {
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

/** Writes config.json, mode 600, without a `token`: the token is kept in the token file, never here (`saveToken`). */
export function saveConfig(cfg: Partial<Config>, home = homeDir()): void {
  ownerOnly(home);
  const file = path.join(home, 'config.json');
  const { token: _token, ...rest } = cfg;
  writeFileAtomic(file, JSON.stringify(rest, null, 2) + '\n', 0o600);
  restrictFile(file, 0o600);
}

/**
 * Page settings the bridge keeps for every story, read on each request so a change needs no restart.
 * Only known keys are kept: {hideWhitespace: boolean, diffView: 'unified' | 'split', layout?: {width?, chatHeight?}}.
 */
const PREF_DEFAULTS: Readonly<Prefs> = Object.freeze({
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
