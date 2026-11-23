/**
 * `once-upon doctor`: is everything connected? The Node it runs on, the config and token, the
 * bridge, a Claude session listening, and the extension. Each check prints
 * PASS, WARN or FAIL with what it found and, when it isn't passing, the fix. It writes nothing, except with `fix`
 * (`--fix`), which compacts the logs that only grow and keeps the old ones (compact-logs.ts) and folds old reviewed.json and
 * approved.json files into review.json (convert-review-files.ts).
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
  liveRegistry,
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
import { readLaunchAgentFacts, type LaunchAgentFacts } from '../../features/launch-agent/status.ts';
import { LAUNCH_LABEL } from '@once-upon-a-diff/adapters/launch-agent';
import { readExtensionSeen } from './bridge.ts';
import { backfillCards } from '../../features/runs/service.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import {
  cardBranchProblems,
  cardRunProblems,
  duplicateCardProblems,
} from '@once-upon-a-diff/state/queues/backlog/phase';
import { openRunWorktreeProblems } from '@once-upon-a-diff/state/queues/backlog/worktree-check';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readIndex } from '@once-upon-a-diff/stories/placement';
import { readMeta, stateKeyOf } from '@once-upon-a-diff/stories/meta';
import { seenCheckoutRepos } from '@once-upon-a-diff/foundation/repos';
import { bigLogs, compactLogs, DEFAULT_KEEP_DAYS } from './compact-logs.ts';
import { convertReviewFiles, legacyReviewFolders } from './convert-review-files.ts';
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

/** One line of the report: `fix` is what to do about it, for a WARN or FAIL. */
interface Finding {
  level: Level;
  name: string;
  detail: string;
  fix?: string | null;
}

/** What every check is given: the options doctor was called with, and the reads that more than one check shares. */
interface Env {
  home: string;
  cfg: Pick<Config, 'port' | 'token'>;
  port: number;
  wait: number;
  nodeVersion: string;
  gitVersion: string | null;
  pumaDevLink: string;
  launchAgent: () => Promise<LaunchAgentFacts>;
  proxyListeners: (port: number) => string[];
  fix: boolean;
  keepDays: number;
  items: () => ReturnType<BacklogStore['listed']>;
  agents: () => ReturnType<typeof readAgents>['agents'];
  stories: () => StoryFacts;
}

/** A check reports nothing, one line or several; some of them read files or ask the bridge, so they may be async. */
type Check = (env: Env) => Finding[] | Promise<Finding[]>;

/** Reads once, when first asked: a check that is never reached reads nothing. */
function lazy<T>(read: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: read() }).value;
}

/** "3 status files", "1 status file". */
const countOf = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A check on a list of problems: WARN with the first few when there are any, PASS with `clean` when there are none. */
function lookAt(
  name: string,
  problems: string[],
  clean: string,
  { where = '', fix = null }: { where?: string; fix?: string | null } = {},
): Finding {
  if (!problems.length) {
    return { level: 'PASS', name, detail: clean };
  }
  return {
    level: 'WARN',
    name,
    detail: `${problems.length} to look at${where}: ${firstFive(problems)}`,
    fix,
  };
}

/** Node: the CLI's entry stops an older one, but not a .ts file run directly with a type-stripping flag. */
const nodeCheck: Check = ({ nodeVersion }) => {
  const problem = nodeVersionProblem(nodeVersion);
  return [
    {
      level: problem ? 'FAIL' : 'PASS',
      name: 'Node',
      detail: `v${nodeVersion} at ${process.execPath}${problem ? `, needs ${MIN_NODE_MAJOR} or newer` : ''}`,
      fix: problem
        ? `Run fnm use or nvm use in the once-upon-a-diff repo (.nvmrc says ${MIN_NODE_MAJOR}), or fnm exec --using=${MIN_NODE_MAJOR} once-upon doctor`
        : null,
    },
  ];
};

/** git: every outside ref is passed after --end-of-options, which rev-parse takes from 2.30. */
const gitCheck: Check = ({ gitVersion }) => {
  const problem = gitVersionProblem(gitVersion);
  const found = gitVersion
    ? `${gitVersion}${problem ? `, ${problem}` : ''}`
    : 'git was not found to ask its version';
  return [
    {
      level: problem ? 'FAIL' : 'PASS',
      name: 'git',
      detail: found,
      fix: problem
        ? `Install git ${MIN_GIT.major}.${MIN_GIT.minor} or newer (brew install git, or your package manager)`
        : null,
    },
  ];
};

/** The config and the token file when both are there: the config's mode, the token's, and which of them is too open. */
function configFinding({ home, port }: Env): Finding {
  const cfgFile = path.join(home, 'config.json');
  const tokenPath = tokenFile(home);
  const mode = modeOfFile(cfgFile);
  const tokenMode = modeOfFile(tokenPath);
  const wide = [
    ...(mode && mode !== '600' ? [cfgFile] : []),
    ...(tokenMode && tokenMode !== '600' ? [tokenPath] : []),
  ];
  return {
    level: wide.length ? 'WARN' : 'PASS',
    name: 'Config and token',
    detail: `${tokenPath} (mode ${tokenMode}), ${cfgFile} (mode ${mode}), port ${port}`,
    fix: wide.length ? `chmod 600 ${wide.join(' ')}` : null,
  };
}

/** Config and token: the token is in its own file, config.json holds none. */
const tokenCheck: Check = (env) => {
  if (env.cfg.token) {
    return [configFinding(env)];
  }
  const detail = `${tokenFile(env.home)} has no token`;
  return [{ level: 'FAIL', name: 'Token', detail, fix: 'Run: once-upon setup' }];
};

/** The bridge's health, asked again for `wait` seconds when it does not answer: a bridge just started may not be listening yet. */
async function bridgeHealth(port: number, token: string | undefined, wait: number) {
  let health = await fetchHealth(port, token);
  const deadline = Date.now() + wait * 1000;
  while (!health && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    health = await fetchHealth(port, token);
  }
  return health;
}

/** The bridge: process, port, token. */
const bridgeCheck: Check = async ({ port, cfg, wait }) => {
  const health = await bridgeHealth(port, cfg.token, wait);
  const proc = listenerPid(port);
  if (!health) {
    return [
      {
        level: 'FAIL',
        name: 'Bridge',
        detail: proc
          ? `port ${port} is taken by pid ${proc.pid} (${proc.command}), which didn't answer`
          : `nothing is listening on 127.0.0.1:${port}`,
        fix: 'Start it: once-upon serve (leave it running, or run it with nohup)',
      },
    ];
  }
  if (health.status === 401) {
    return [
      {
        level: 'FAIL',
        name: 'Bridge token',
        detail: `the bridge on ${port} rejects this config's token${proc ? ` (pid ${proc.pid})` : ''}`,
        fix: 'Restart the bridge so it reads the token file again, and paste the same token into the extension options',
      },
    ];
  }
  if (health.body?.name === 'once-upon-bridge') {
    return [
      {
        level: 'PASS',
        name: 'Bridge',
        detail: `running on 127.0.0.1:${port}, version ${health.body.version}${proc ? `, pid ${proc.pid}` : ''}`,
      },
    ];
  }
  return [
    {
      level: 'FAIL',
      name: 'Bridge',
      detail: `something else answers on port ${port} (HTTP ${health.status})`,
      fix: 'Pick another port: set "port" in config.json, restart the bridge, and change it in the extension options',
    },
  ];
};

/** Whether the bridge's LaunchAgent starts it at login, and still points at files that are there. */
const launchAgentCheck: Check = async ({ port, launchAgent }) => {
  const facts = await launchAgent();
  if (!facts.available) {
    return [];
  }
  const name = 'Bridge at login';
  const reinstall = 'Run: once-upon install-launch-agent (on Node 24, from the main checkout)';
  if (!facts.fileExists) {
    return [
      {
        level: 'WARN',
        name,
        detail: `no LaunchAgent (${facts.file}): after a reboot nothing starts the bridge`,
        fix: 'Run: once-upon install-launch-agent',
      },
    ];
  }
  if (!facts.loaded) {
    return [
      {
        level: 'WARN',
        name,
        detail: `${facts.file} is there but launchd has not loaded it`,
        fix: `Run: launchctl bootstrap gui/${facts.uid} ${facts.file} (or ${reinstall})`,
      },
    ];
  }
  const gone = [facts.program, facts.workingDirectory].filter(
    (found): found is string => !!found && !existsSync(found),
  );
  if (gone.length > 0) {
    return [
      {
        level: 'WARN',
        name,
        detail: `the LaunchAgent runs ${gone.join(' and ')}, which is not there any more`,
        fix: reinstall,
      },
    ];
  }
  const listener = listenerPid(port);
  const handStarted = listener !== null && Number(listener.pid) !== facts.pid;
  if (handStarted) {
    return [
      {
        level: 'INFO',
        name,
        detail: `starts at login (${LAUNCH_LABEL}), but a bridge started by hand (pid ${listener.pid}) holds port ${port}; the next deploy restarts it under launchd`,
      },
    ];
  }
  if (facts.pid === null) {
    return [
      {
        level: 'WARN',
        name,
        detail: `launchd has ${LAUNCH_LABEL} loaded but it is not running, and nothing holds port ${port}`,
        fix: `Run: launchctl kickstart -k gui/${facts.uid}/${LAUNCH_LABEL} (or ${reinstall})`,
      },
    ];
  }
  return [
    {
      level: 'PASS',
      name,
      detail: `starts at login (${LAUNCH_LABEL}), loaded, pid ${facts.pid}`,
    },
  ];
};

/** The proxy in front of the bridge (puma-dev): the bridge refuses a client that is not this machine, but the proxy itself should not accept one either. */
const proxyCheck: Check = ({ pumaDevLink, proxyListeners }) => {
  if (!existsSync(pumaDevLink)) {
    return [];
  }
  const open = [80, 443].flatMap((proxyPort) =>
    proxyListeners(proxyPort).map((host) => `${host}:${proxyPort}`),
  );
  return [
    {
      level: open.length ? 'INFO' : 'PASS',
      name: 'Proxy',
      detail: open.length
        ? `puma-dev listens on all interfaces (${open.join(', ')}); the bridge refuses non-loopback clients`
        : 'puma-dev listens on this machine only (or is not running)',
    },
  ];
};

/** The extension: the bridge records when it last heard from it. */
const extensionCheck: Check = ({ home }) => {
  const seen = readExtensionSeen(home);
  if (seen) {
    return [
      {
        level: 'PASS',
        name: 'Extension',
        detail: `last talked to the bridge ${localTime(seen.at)} (${seen.origin})`,
      },
    ];
  }
  return [
    {
      level: 'WARN',
      name: 'Extension',
      detail: 'the bridge has never heard from the extension',
      fix: 'yarn build, then chrome://extensions → Load unpacked → packages/client/extension/.output/chrome-mv3, then in its options paste the port and token and click Test connection',
    },
  ];
};

/** A Claude session listening for questions. */
const listeningCheck: Check = ({ home }) => {
  const all = new Listening(home).all();
  const live = all.filter((listener) => listener.live);
  if (live.length) {
    const sayLive = (listener: (typeof live)[number]) =>
      `${listener.consumer} (${listener.story || listener.repo || 'everything'}, ${listener.state}, ${listener.age_s}s ago)`;
    return [{ level: 'PASS', name: 'Claude listening', detail: live.map(sayLive).join(', ') }];
  }
  return [
    {
      level: 'WARN',
      name: 'Claude listening',
      detail: all.length
        ? `no live listener; last was ${all[0].consumer} ${localTime(all[0].at)}`
        : 'no Claude session has ever listened',
      fix: 'In Claude Code, in the repo you want to listen for: /once-upon-listen <owner/name>. Until then, questions wait in the inbox.',
    },
  ];
};

/** Claude Code's session files, which the board reads with no promise that their format holds. */
const sessionsCheck: Check = async ({ home }) => {
  const sessionsDir = readSettings(home).board.sessionsDir;
  const registry = await registryHealth(sessionsDir);
  const note = registryNote(registry);
  const trouble = registryProblem(registry);
  return [
    {
      level: trouble ? 'WARN' : 'PASS',
      name: 'Claude sessions',
      detail:
        trouble ??
        `${countOf(registry.seen, 'session file')} read in ${sessionsDir}${note ? ` (${note})` : ''}`,
      fix: trouble
        ? `Look in ${sessionsDir}: a Claude Code update may have renamed a field or moved the folder, or the files' permissions changed (set board_sessions_dir in config.json if it moved)`
        : null,
    },
  ];
};

/** The status hook, which says Waiting and Done in any terminal: its files appear once it is wired into Claude Code. */
const statusHookCheck: Check = ({ home }) => {
  const files = hookFileCount(home);
  const folder = path.join(home, 'status');
  return [
    {
      level: files ? 'PASS' : 'WARN',
      name: 'Status hook',
      detail: files
        ? `${countOf(files, 'status file')} in ${folder}`
        : `no status file in ${folder}: the board shows no Waiting or Done, only Claude Code's busy or idle`,
      fix: files
        ? null
        : 'Wire extras/hooks/board-status.sh into Claude Code hooks (README, "Board status hook"); the file appears on the next prompt',
    },
  ];
};

/** The listen hook, which starts a queued Start listening in any terminal: wired in Claude Code's settings or not. */
const listenHookCheck: Check = () => {
  const wired = listenHookWired();
  const settingsFile = path.join(claudeConfigDir(), 'settings.json');
  const says = {
    true: `${LISTEN_HOOK} is in ${settingsFile}`,
    unreadable: `${settingsFile} could not be read, so the hook is unknown`,
  } as Record<string, string>;
  return [
    {
      level: wired === true ? 'PASS' : 'WARN',
      name: 'Listen hook',
      detail:
        says[String(wired)] ??
        `${LISTEN_HOOK} is not in ${settingsFile}: with no iTerm tab, Start listening can only show the line to run by hand`,
      fix:
        wired === true
          ? null
          : 'Run once-upon install-hooks: it prints the "hooks" block to add (nothing is written for you)',
    },
  ];
};

/**
 * The board's context and usage come from status line files: live sessions and none of them writing one is the setup left
 * undone (a session that is not interactive has no status line to render).
 */
const statusLineCheck: Check = async ({ home }) => {
  const live = (await liveSessions(readSettings(home).board.sessionsDir)).filter(
    (session) => !session.kind || session.kind === 'interactive',
  );
  if (!live.length) {
    return [];
  }
  const fresh = freshStatusLineIds(home, Date.now());
  const writing = live.filter((session) => fresh.has(session.session)).length;
  return [
    {
      level: writing ? 'PASS' : 'WARN',
      name: 'Status line',
      detail: writing
        ? `${writing} of ${countOf(live.length, 'live session')} wrote its context and usage for the board lately`
        : `${countOf(live.length, 'live Claude session')}, and none has written ${path.join(home, 'statusline')}/<session id>.json in the last 6 hours: the board shows no context or usage`,
      fix: writing
        ? null
        : 'Run once-upon setup: it prints the line to add to your Claude Code status line (extras/statusline-snippet.sh); the next render of any session then writes it',
    },
  ];
};

/** Every run is a run of one card, and says nothing the card does not (ADR-25); one piece of work is one card. */
const backlogCheck: Check = ({ home, items, agents }) => {
  const now = Date.now();
  const runs = [
    ...cardRunProblems(
      items(),
      agents(),
      now,
      new Set(new BacklogStore(home).items().map((item) => item.id)),
    ),
    ...cardBranchProblems(items(), agents()),
    ...openRunWorktreeProblems(items(), agents()),
  ];
  // a backlog card and an implicit card on one repo and branch are a pair to merge by hand
  const duplicates = duplicateCardProblems(items(), agents(), new BacklogStore(home).items());
  // the runs made before stored cards (ADR-29): their `ic_` cards, and the recent runs with no card, are what `card backfill` stores
  const stray = backfillCards(home, { dryRun: true });
  const cardless = backfillCards(home, { dryRun: true, cardless: true });
  const unstored = stray.added || cardless.moved;
  return [
    lookAt(
      'Card runs',
      runs,
      'every run names a card that holds, every started card has a branch, and an open run’s worktree exists',
    ),
    {
      level: unstored ? 'WARN' : 'PASS',
      name: 'Stored cards',
      detail: unstored
        ? `${stray.added} ic_ ids on runs have no stored card, ${cardless.moved} recent cardless runs name none`
        : 'every ic_ id on a run has a stored card, and no recent run is without one',
      fix: unstored
        ? 'Run: once-upon card backfill [--cardless] (--dry-run says what it would write; --cardless moves runs on the board)'
        : null,
    },
    lookAt(
      'Duplicate cards',
      duplicates,
      'no backlog card duplicates the implicit card on its branch',
      {
        fix: 'Run the drop --into it names: it moves the runs onto the card you keep and drops the other. Doctor never merges',
      },
    ),
  ];
};

/** What the story checks and the repo check read: the stories on disk and in the index, the builds, and the ids and state keys they name. */
interface StoryFacts {
  stories: { id: string; meta: ReturnType<typeof readMeta> }[];
  indexed: string[];
  storyIds: Set<string>;
  builds: ReturnType<Builds['all']>[string][];
  stateKeys: Set<string>;
}

function readStoryFacts(home: string): StoryFacts {
  const stories = new StoryStore({ home })
    .dirs()
    .map(({ id, dir }) => ({ id, meta: readMeta(dir) }));
  const indexed = Object.keys(readIndex(home));
  const builds = Object.values(new Builds(home).all());
  const prKeys = builds.flatMap((build) =>
    build.repo && build.number ? [stateKeyForPr(build.repo, build.number)] : [],
  );
  return {
    stories,
    indexed,
    storyIds: new Set([...indexed, ...stories.map((story) => story.id)]),
    builds,
    stateKeys: new Set([...stories.map((story) => stateKeyOf(story.id, story.meta)), ...prKeys]),
  };
}

const NO_STORY = ', in no story of stories.json and with no story folder';

/** State folders and inbox entries each belong to a story: one in stories.json or with a story folder on disk. */
const storyCheck: Check = ({ home, stories: facts }) => {
  const { stories, indexed, storyIds, stateKeys } = facts();
  const { folders, unreadable } = folderNames(path.join(home, 'state'));
  const inbox = inboxStories(home);
  const found: Finding[] = [
    lookAt(
      'State folders',
      stateFolderProblems(folders, storyIds, stateKeys),
      'every folder in state/ is a story or a PR story',
      { where: NO_STORY },
    ),
  ];
  if (unreadable.length) {
    found.push({
      level: 'WARN',
      name: 'Unreadable state folders',
      detail: `${unreadable.length} that doctor could not read, so it did not check: ${firstFive(unreadable)}`,
    });
  }
  found.push(
    lookAt(
      'Inbox stories',
      inboxStoryProblems(inbox, storyIds),
      'every story in inbox.jsonl is a story',
      { where: NO_STORY },
    ),
  );
  const goneIds = new Set(indexed.filter((id) => !stories.some((story) => story.id === id)));
  const goneFolders = folders.filter((folder) => goneIds.has(folder.name)).length;
  const goneEvents = inbox.filter((story) => goneIds.has(story)).length;
  if (goneFolders || goneEvents) {
    found.push({
      level: 'INFO',
      name: 'Index-only stories',
      detail: `${goneIds.size} ids in stories.json have no story folder now: ${goneFolders} state folders and ${goneEvents} inbox events belong to them`,
    });
  }
  return found;
};

/** A repo on a card or a cardless run is checked against the repos a store that takes no typed repo vouches for. */
const repoCheck: Check = ({ home, items, agents, stories: facts }) => {
  const { stories, builds } = facts();
  const anchored = [
    ...builds.map((build) => build.repo),
    // a PR story's repo is the PR's; a local story's would come from running git, which a report does not
    ...stories.map((story) => (story.meta.kind === 'github' ? story.meta.repo : null)),
    ...seenCheckoutRepos(home),
  ].filter((repo): repo is string => !!repo);
  const cardUses: RepoUse[] = items().flatMap((item) =>
    item.repo
      ? [
          {
            repo: item.repo,
            kind: 'card' as const,
            label: `${item.id}${item.state === 'dropped' ? ' (dropped)' : ''}`,
          },
        ]
      : [],
  );
  // a run with a card is the card's, and "Card runs" has its typed repo
  const runUses: RepoUse[] = agents()
    .flatMap((agent) => [...(agent.earlier ?? []), agent])
    .flatMap((run) =>
      run.repo && !run.card ? [{ repo: run.repo, kind: 'run' as const, label: run.name }] : [],
    );
  const repos = repoProblems(anchored, [...cardUses, ...runUses]);
  const found: Finding[] = [
    lookAt(
      'Repos',
      repos.suspects,
      'every repo on a card or a cardless run is known or looks like no known repo',
    ),
  ];
  if (repos.owners.length) {
    found.push({ level: 'INFO', name: 'Repo owners', detail: firstFive(repos.owners) });
  }
  if (repos.unvouched.length) {
    found.push({
      level: 'INFO',
      name: 'Unvouched repos',
      detail: `no checkout, build or story names ${firstFive(repos.unvouched)}`,
    });
  }
  return found;
};

/** The logs only grow: a plain doctor says when one is big, `--fix` rewrites them smaller and keeps the old ones. */
const logsCheck: Check = async ({ home, fix, keepDays }) => {
  if (fix) {
    // a session still running keeps its card; with a registry that cannot be trusted, every session card stays
    const scan = await liveRegistry(readSettings(home).board.sessionsDir);
    const trusted = scan.health.folder === 'ok' && !scan.unknown;
    const done = compactLogs(home, {
      keepDays,
      liveSessions: trusted ? scan.sessions.map((one) => one.session) : null,
    });
    const nothing = `nothing in agents.jsonl, backlog.jsonl or inbox.jsonl to drop (runs older than ${keepDays} days)`;
    return [{ level: 'PASS', name: 'Logs', detail: done.length ? done.join('; ') : nothing }];
  }
  const big = bigLogs(home);
  if (!big.length) {
    return [];
  }
  return [
    {
      level: 'WARN',
      name: 'Logs',
      detail: big.join(', '),
      fix: 'Run: once-upon doctor --fix (the old logs are kept beside the new ones)',
    },
  ];
};

/** Stories from before review.json still have reviewed.json and approved.json, which nothing reads any more. */
const reviewFilesCheck: Check = ({ home, fix }) => {
  if (fix) {
    const converted = convertReviewFiles(home);
    const detail = converted
      ? `${converted} stories' reviewed.json and approved.json folded into review.json`
      : 'no story has reviewed.json or approved.json';
    return [{ level: 'PASS', name: 'Review files', detail }];
  }
  const old = legacyReviewFolders(home);
  if (!old.length) {
    return [];
  }
  return [
    {
      level: 'WARN',
      name: 'Review files',
      detail: `${old.length} stories still have reviewed.json or approved.json, which are no longer read`,
      fix: 'Run: once-upon doctor --fix',
    },
  ];
};

/** In the order they are reported. */
const CHECKS: Check[] = [
  nodeCheck,
  gitCheck,
  tokenCheck,
  bridgeCheck,
  launchAgentCheck,
  proxyCheck,
  extensionCheck,
  listeningCheck,
  sessionsCheck,
  statusHookCheck,
  listenHookCheck,
  statusLineCheck,
  backlogCheck,
  storyCheck,
  repoCheck,
  logsCheck,
  reviewFilesCheck,
];

/** Prints the findings and the count of FAILs and WARNs; true when nothing FAILed. */
function report(findings: Finding[], out: (text: string) => unknown): boolean {
  for (const result of findings) {
    out(`${result.level.padEnd(4)}  ${result.name}: ${result.detail}`);
    if (result.fix) {
      out(`      fix: ${result.fix}`);
    }
  }
  const fails = findings.filter((result) => result.level === 'FAIL').length;
  const warns = findings.filter((result) => result.level === 'WARN').length;
  out(
    `\n${fails ? `${fails} failing` : 'Nothing failing'}${warns ? `, ${warns} to look at` : ''}.`,
  );
  return fails === 0;
}

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
    launchAgent = readLaunchAgentFacts,
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
    /** the bridge's LaunchAgent as launchd and its file say it is: for tests; this Mac's by default */
    launchAgent?: () => Promise<LaunchAgentFacts>;
    proxyListeners?: (port: number) => string[];
    /** compact the logs (`--fix`), keeping the old ones; runs over `keepDays` days old go. Without it doctor writes nothing */
    fix?: boolean;
    keepDays?: number;
  } = {},
): Promise<boolean> {
  const env: Env = {
    home,
    cfg,
    port: Number(portOpt || cfg.port),
    wait,
    nodeVersion,
    gitVersion,
    pumaDevLink,
    launchAgent,
    proxyListeners,
    fix,
    keepDays,
    items: lazy(() => new BacklogStore(home).listed()),
    agents: lazy(() => readAgents(home).agents),
    stories: lazy(() => readStoryFacts(home)),
  };
  const findings: Finding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check(env)));
  }
  return report(findings, out);
}
