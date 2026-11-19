/**
 * `once-upon doctor`: is everything connected? The Node it runs on, the config and token, the
 * bridge, a Claude session listening, and the extension. Each check prints
 * PASS, WARN or FAIL with what it found and, when it isn't passing, the fix. It writes nothing, except with `fix`
 * (`--fix`), which compacts the logs that only grow and keeps the old ones (compact-logs.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Listening } from '../../features/listeners/service.ts';
import {
  claudeConfigDir,
  LISTEN_HOOK,
  listenHookWired,
} from '../../features/sessions/hook-setup.ts';
import {
  formatTime,
  modeOfFile,
  readSettings,
  tokenFile,
} from '@once-upon-a-diff/foundation/settings';

import { MIN_NODE_MAJOR, nodeVersionProblem } from '@once-upon-a-diff/foundation/node-version.mjs';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import { listenerPid, openListeners } from '@once-upon-a-diff/adapters/os';
import {
  liveSessions,
  registryHealth,
  registryNote,
  registryProblem,
} from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { hookFileCount } from '@once-upon-a-diff/adapters/claude-sessions/hook-status';
import { freshStatusLineIds } from '@once-upon-a-diff/adapters/claude-sessions/statusline';
import { gitVersionText } from '@once-upon-a-diff/adapters/git';
import { gitVersionProblem, MIN_GIT } from '@once-upon-a-diff/foundation/git-version';
import { fetchHealth } from '@once-upon-a-diff/adapters/bridge-health';
import { readExtensionSeen } from './bridge.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import {
  cardBranchProblems,
  cardRunProblems,
  duplicateCardProblems,
} from '@once-upon-a-diff/state/queues/backlog/phase';
import { claimWorktreeProblems } from '@once-upon-a-diff/state/queues/backlog/claim-worktree';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readIndex } from '@once-upon-a-diff/stories/placement';
import { readMeta, stateKeyOf } from '@once-upon-a-diff/stories/meta';
import { seenCheckoutRepos } from '@once-upon-a-diff/foundation/repos';
import { bigLogs, compactLogs, DEFAULT_KEEP_DAYS } from './compact-logs.ts';
import { stateKeyForPr } from '@once-upon-a-diff/terms/ids';
import {
  inboxStoryProblems,
  repoProblems,
  stateFolderProblems,
  type RepoUse,
} from './doctor-joins.ts';

/** INFO says what doctor saw and asks nothing: it is not counted, and never fails. */
type Level = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

const firstFive = (problems: string[]): string =>
  `${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; ...' : ''}`;

/**
 * The folders under a folder with how many files each holds, and the ones that cannot be read: one folder that cannot be
 * read is listed apart and does not stop the rest being looked at. A folder that is not there has none.
 */
function folderNames(dir: string): {
  folders: { name: string; files: number }[];
  unreadable: string[];
} {
  const folders: { name: string; files: number }[] = [];
  const unreadable: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      unreadable.push(path.basename(dir));
    }
    return { folders, unreadable };
  }
  for (const entry of entries.filter((one) => one.isDirectory())) {
    try {
      folders.push({ name: entry.name, files: readdirSync(path.join(dir, entry.name)).length });
    } catch {
      unreadable.push(entry.name);
    }
  }
  return { folders, unreadable };
}

/**
 * The `story` of each inbox line, read straight from the file: the Inbox class chmods the home when made, and its reader
 * skips the types it no longer knows (`position`), which still name stories.
 */
function inboxStories(home: string): string[] {
  try {
    return readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      .split('\n')
      .flatMap((text) => {
        try {
          const story: unknown = text.trim() ? JSON.parse(text)?.story : null;
          return typeof story === 'string' ? [story] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const localTime = (iso: string) => formatTime(iso);

/**
 * Runs every check; resolves true when nothing FAILed. opts.port overrides the config's.
 */
export async function doctor(
  home: string,
  cfg: Pick<Config, 'port' | 'token'>,
  {
    port: portOpt,
    wait = 0,
    out = (text) => process.stdout.write(text + '\n'),
    nodeVersion = process.versions.node,
    gitVersion = gitVersionText(),
    pumaDevLink = path.join(os.homedir(), '.puma-dev', 'once-upon'),
    proxyListeners = openListeners,
    fix = false,
    keepDays = DEFAULT_KEEP_DAYS,
  }: {
    port?: number | string;
    wait?: number;
    out?: (text: string) => unknown;
    /** the Node to judge, for tests; the one running doctor by default */
    nodeVersion?: string;
    /** the `git --version` text to judge, for tests; this machine's git by default */
    gitVersion?: string | null;
    /** puma-dev's link to the bridge, and the addresses a port listens on past this machine: for tests */
    pumaDevLink?: string;
    proxyListeners?: (port: number) => string[];
    /** compact the logs (`--fix`), keeping the old ones; runs over `keepDays` days old go. Without it doctor writes nothing */
    fix?: boolean;
    keepDays?: number;
  } = {},
): Promise<boolean> {
  const port = Number(portOpt || cfg.port);
  const results: { level: Level; name: string; detail: string; fix?: string | null }[] = [];
  const add = (level: Level, name: string, detail: string, fix?: string | null) =>
    results.push({ level, name, detail, fix });

  // Node: the CLI's entry stops an older one, but not a .ts file run directly with a type-stripping flag
  const nodeProblem = nodeVersionProblem(nodeVersion);
  add(
    nodeProblem ? 'FAIL' : 'PASS',
    'Node',
    `v${nodeVersion} at ${process.execPath}${nodeProblem ? `, needs ${MIN_NODE_MAJOR} or newer` : ''}`,
    nodeProblem
      ? `Run fnm use or nvm use in the once-upon-a-diff repo (.nvmrc says ${MIN_NODE_MAJOR}), or fnm exec --using=${MIN_NODE_MAJOR} once-upon doctor`
      : null,
  );

  // git: every outside ref is passed after --end-of-options, which rev-parse takes from 2.30
  const gitProblem = gitVersionProblem(gitVersion);
  add(
    gitProblem ? 'FAIL' : 'PASS',
    'git',
    gitVersion
      ? `${gitVersion}${gitProblem ? `, ${gitProblem}` : ''}`
      : 'git was not found to ask its version',
    gitProblem
      ? `Install git ${MIN_GIT.major}.${MIN_GIT.minor} or newer (brew install git, or your package manager)`
      : null,
  );

  // config and token: the token is in its own file, config.json holds none
  const cfgFile = path.join(home, 'config.json');
  const mode = modeOfFile(cfgFile);
  const tokenPath = tokenFile(home);
  const tokenMode = modeOfFile(tokenPath);
  if (!cfg.token) {
    add('FAIL', 'Token', `${tokenPath} has no token`, 'Run: once-upon setup');
  } else {
    const wide = [
      ...(mode && mode !== '600' ? [cfgFile] : []),
      ...(tokenMode && tokenMode !== '600' ? [tokenPath] : []),
    ];
    add(
      wide.length ? 'WARN' : 'PASS',
      'Config and token',
      `${tokenPath} (mode ${tokenMode}), ${cfgFile} (mode ${mode}), port ${port}`,
      wide.length ? `chmod 600 ${wide.join(' ')}` : null,
    );
  }

  // the bridge: process, port, token
  let health = await fetchHealth(port, cfg.token);
  // --wait N: a bridge that was just started may not be listening yet
  const deadline = Date.now() + wait * 1000;
  while (!health && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    health = await fetchHealth(port, cfg.token);
  }
  const proc = listenerPid(port);
  if (!health) {
    add(
      'FAIL',
      'Bridge',
      proc
        ? `port ${port} is taken by pid ${proc.pid} (${proc.command}), which didn't answer`
        : `nothing is listening on 127.0.0.1:${port}`,
      'Start it: once-upon serve (leave it running, or run it with nohup)',
    );
  } else if (health.status === 401) {
    add(
      'FAIL',
      'Bridge token',
      `the bridge on ${port} rejects this config's token${proc ? ` (pid ${proc.pid})` : ''}`,
      'Restart the bridge so it reads the token file again, and paste the same token into the extension options',
    );
  } else if (health.body && health.body.name === 'once-upon-bridge') {
    add(
      'PASS',
      'Bridge',
      `running on 127.0.0.1:${port}, version ${health.body.version}${proc ? `, pid ${proc.pid}` : ''}`,
    );
  } else {
    add(
      'FAIL',
      'Bridge',
      `something else answers on port ${port} (HTTP ${health.status})`,
      'Pick another port: set "port" in config.json, restart the bridge, and change it in the extension options',
    );
  }

  // the proxy in front of the bridge (puma-dev): the bridge refuses a client that is not this machine, but the proxy
  // itself should not accept one either
  if (existsSync(pumaDevLink)) {
    const open = [80, 443].flatMap((proxyPort) =>
      proxyListeners(proxyPort).map((host) => `${host}:${proxyPort}`),
    );
    add(
      open.length ? 'INFO' : 'PASS',
      'Proxy',
      open.length
        ? `puma-dev listens on all interfaces (${open.join(', ')}); the bridge refuses non-loopback clients`
        : 'puma-dev listens on this machine only (or is not running)',
    );
  }

  // the extension: the bridge records when it last heard from it
  const seen = readExtensionSeen(home);
  if (seen) {
    add('PASS', 'Extension', `last talked to the bridge ${localTime(seen.at)} (${seen.origin})`);
  } else {
    add(
      'WARN',
      'Extension',
      'the bridge has never heard from the extension',
      'yarn build, then chrome://extensions → Load unpacked → packages/client/extension/.output/chrome-mv3, then in its options paste the port and token and click Test connection',
    );
  }

  // a Claude session listening for questions
  const all = new Listening(home).all();
  const live = all.filter((listener) => listener.live);
  if (live.length) {
    add(
      'PASS',
      'Claude listening',
      live
        .map((listener) => {
          const covers = listener.story || listener.repo || 'everything';
          return `${listener.consumer} (${covers}, ${listener.state}, ${listener.age_s}s ago)`;
        })
        .join(', '),
    );
  } else {
    add(
      'WARN',
      'Claude listening',
      all.length
        ? `no live listener; last was ${all[0].consumer} ${localTime(all[0].at)}`
        : 'no Claude session has ever listened',
      'In Claude Code, in the repo you want to listen for: /once-upon-listen <owner/name>. Until then, questions wait in the inbox.',
    );
  }
  // Claude Code's session files, which the board reads with no promise that their format holds
  const sessionsDir = readSettings(home).board.sessionsDir;
  const registry = await registryHealth(sessionsDir);
  const registryInfo = registryNote(registry);
  const registryTrouble = registryProblem(registry);
  add(
    registryTrouble ? 'WARN' : 'PASS',
    'Claude sessions',
    registryTrouble ??
      `${registry.seen} session file${registry.seen === 1 ? '' : 's'} read in ${sessionsDir}${registryInfo ? ` (${registryInfo})` : ''}`,
    registryTrouble
      ? `Look in ${sessionsDir}: a Claude Code update may have renamed a field or moved the folder, or the files' permissions changed (set board_sessions_dir in config.json if it moved)`
      : null,
  );
  // the status hook, which says Waiting and Done in any terminal: its files appear once it is wired into Claude Code
  const hookFiles = hookFileCount(home);
  add(
    hookFiles ? 'PASS' : 'WARN',
    'Status hook',
    hookFiles
      ? `${hookFiles} status file${hookFiles === 1 ? '' : 's'} in ${path.join(home, 'status')}`
      : `no status file in ${path.join(home, 'status')}: the board shows no Waiting or Done, only Claude Code's busy or idle`,
    hookFiles
      ? null
      : 'Wire extras/hooks/board-status.sh into Claude Code hooks (README, "Board status hook"); the file appears on the next prompt',
  );
  // the listen hook, which starts a queued Start listening in any terminal: wired in Claude Code's settings or not
  const wired = listenHookWired();
  const settingsFile = path.join(claudeConfigDir(), 'settings.json');
  let listenHook = `${LISTEN_HOOK} is not in ${settingsFile}: with no iTerm tab, Start listening can only show the line to run by hand`;
  if (wired === true) {
    listenHook = `${LISTEN_HOOK} is in ${settingsFile}`;
  } else if (wired === 'unreadable') {
    listenHook = `${settingsFile} could not be read, so the hook is unknown`;
  }
  add(
    wired === true ? 'PASS' : 'WARN',
    'Listen hook',
    listenHook,
    wired === true
      ? null
      : 'Run once-upon install-hooks: it prints the "hooks" block to add (nothing is written for you)',
  );
  // the board's context and usage come from status line files: live sessions and none of them writing one is the setup
  // left undone (a session that is not interactive has no status line to render)
  const statusSessions = (await liveSessions(sessionsDir)).filter(
    (session) => !session.kind || session.kind === 'interactive',
  );
  if (statusSessions.length) {
    const fresh = freshStatusLineIds(home, Date.now());
    const writing = statusSessions.filter((session) => fresh.has(session.session)).length;
    add(
      writing ? 'PASS' : 'WARN',
      'Status line',
      writing
        ? `${writing} of ${statusSessions.length} live session${statusSessions.length === 1 ? '' : 's'} wrote its context and usage for the board lately`
        : `${statusSessions.length} live Claude session${statusSessions.length === 1 ? '' : 's'}, and none has written ${path.join(home, 'statusline')}/<session id>.json in the last 6 hours: the board shows no context or usage`,
      writing
        ? null
        : 'Run once-upon setup: it prints the line to add to your Claude Code status line (extras/statusline-snippet.sh); the next render of any session then writes it',
    );
  }
  // every run is a run of one card, and says nothing the card does not (ADR-25)
  const items = new BacklogStore(home).listed();
  const problems = [
    ...cardRunProblems(items, readAgents(home).agents, Date.now()),
    ...cardBranchProblems(items, Date.now()),
    ...claimWorktreeProblems(items),
  ];
  add(
    problems.length ? 'WARN' : 'PASS',
    'Card runs',
    problems.length
      ? `${problems.length} to look at: ${firstFive(problems)}`
      : 'every run names a card that holds, and every claimed card has a branch',
  );

  // one piece of work is one card: a backlog card and an implicit card on one repo and branch are a pair to merge by hand
  const duplicates = duplicateCardProblems(items, readAgents(home).agents);
  add(
    duplicates.length ? 'WARN' : 'PASS',
    'Duplicate cards',
    duplicates.length
      ? `${duplicates.length} to look at: ${firstFive(duplicates)}`
      : 'no backlog card duplicates the implicit card on its branch',
    duplicates.length
      ? 'Run the drop --into it names: it moves the runs onto the card you keep and drops the other. Doctor never merges'
      : null,
  );

  // state folders and inbox entries each belong to a story: one in stories.json or with a story folder on disk
  const stories = new StoryStore({ home })
    .dirs()
    .map(({ id, dir }) => ({ id, meta: readMeta(dir) }));
  const indexed = Object.keys(readIndex(home));
  const storyIds = new Set([...indexed, ...stories.map((story) => story.id)]);
  const builds = Object.values(new Builds(home).all());
  const stateKeys = new Set([
    ...stories.map((story) => stateKeyOf(story.id, story.meta)),
    ...builds.flatMap((build) =>
      build.repo && build.number ? [stateKeyForPr(build.repo, build.number)] : [],
    ),
  ]);
  const { folders, unreadable } = folderNames(path.join(home, 'state'));
  const orphans = stateFolderProblems(folders, storyIds, stateKeys);
  add(
    orphans.length ? 'WARN' : 'PASS',
    'State folders',
    orphans.length
      ? `${orphans.length} to look at, in no story of stories.json and with no story folder: ${firstFive(orphans)}`
      : 'every folder in state/ is a story or a PR story',
  );
  if (unreadable.length) {
    add(
      'WARN',
      'Unreadable state folders',
      `${unreadable.length} that doctor could not read, so it did not check: ${firstFive(unreadable)}`,
    );
  }
  const inbox = inboxStories(home);
  const missing = inboxStoryProblems(inbox, storyIds);
  add(
    missing.length ? 'WARN' : 'PASS',
    'Inbox stories',
    missing.length
      ? `${missing.length} to look at, in no story of stories.json and with no story folder: ${firstFive(missing)}`
      : 'every story in inbox.jsonl is a story',
  );
  const goneIds = new Set(indexed.filter((id) => !stories.some((story) => story.id === id)));
  const goneFolders = folders.filter((folder) => goneIds.has(folder.name)).length;
  const goneEvents = inbox.filter((story) => goneIds.has(story)).length;
  if (goneFolders || goneEvents) {
    add(
      'INFO',
      'Index-only stories',
      `${goneIds.size} ids in stories.json have no story folder now: ${goneFolders} state folders and ${goneEvents} inbox events belong to them`,
    );
  }

  // a repo on a card or a cardless run is checked against the repos a store that takes no typed repo vouches for
  const anchored = [
    ...builds.map((build) => build.repo),
    // a PR story's repo is the PR's; a local story's would come from running git, which a report does not
    ...stories.map((story) => (story.meta.kind === 'github' ? story.meta.repo : null)),
    ...seenCheckoutRepos(home),
  ].filter((repo): repo is string => !!repo);
  const uses: RepoUse[] = [
    ...items.flatMap((item) =>
      item.repo
        ? [
            {
              repo: item.repo,
              kind: 'card' as const,
              label: `${item.id}${item.state === 'dropped' ? ' (dropped)' : ''}`,
            },
          ]
        : [],
    ),
    // a run with a card is the card's, and "Card runs" has its typed repo
    ...readAgents(home)
      .agents.flatMap((agent) => [...(agent.earlier ?? []), agent])
      .flatMap((run) =>
        run.repo && !run.card ? [{ repo: run.repo, kind: 'run' as const, label: run.name }] : [],
      ),
  ];
  const repos = repoProblems(anchored, uses);
  add(
    repos.suspects.length ? 'WARN' : 'PASS',
    'Repos',
    repos.suspects.length
      ? `${repos.suspects.length} to look at: ${firstFive(repos.suspects)}`
      : 'every repo on a card or a cardless run is known or looks like no known repo',
  );
  if (repos.owners.length) {
    add('INFO', 'Repo owners', firstFive(repos.owners));
  }
  if (repos.unvouched.length) {
    add(
      'INFO',
      'Unvouched repos',
      `no checkout, build or story names ${firstFive(repos.unvouched)}`,
    );
  }
  // the logs only grow: a plain doctor says when one is big, `--fix` rewrites them smaller and keeps the old ones
  if (fix) {
    const done = compactLogs(home, { keepDays });
    add(
      'PASS',
      'Logs',
      done.length
        ? done.join('; ')
        : `nothing in agents.jsonl or inbox.jsonl to drop (runs older than ${keepDays} days)`,
    );
  } else {
    const big = bigLogs(home);
    if (big.length) {
      add(
        'WARN',
        'Logs',
        `${big.join(', ')}`,
        'Run: once-upon doctor --fix (the old logs are kept beside the new ones)',
      );
    }
  }
  for (const result of results) {
    out(`${result.level.padEnd(4)}  ${result.name}: ${result.detail}`);
    if (result.fix) {
      out(`      fix: ${result.fix}`);
    }
  }
  const fails = results.filter((result) => result.level === 'FAIL').length;
  const warns = results.filter((result) => result.level === 'WARN').length;
  out(
    `\n${fails ? `${fails} failing` : 'Nothing failing'}${warns ? `, ${warns} to look at` : ''}.`,
  );
  return fails === 0;
}
