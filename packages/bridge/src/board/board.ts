/**
 * The agent board's data. A card is a unit of work: a branch or PR, with the Claude Code sessions and ledger agents
 * working on it inside. Sessions that are not on a branch of their own (the default branch, no repo) are cards of their
 * own. Everything is read-only. The sources:
 *
 *   <sessions dir>/<pid>.json   Claude Code's live-session registry: {pid, sessionId, cwd, name, status, statusUpdatedAt,
 *                               procStart}. A file counts only while its pid is alive (and, when `ps` can say, started
 *                               when procStart says, so a reused pid doesn't revive it). A session's branch is its
 *                               checkout's current one (`git rev-parse`).
 *   a status source             the terminal's richer status (sources.ts)
 *   ledger and progress files   the background agents (ledger.ts)
 *   PR stories                  the built stories (review-inbox/stories.ts): each is a PR, with its branch, and whether you have
 *                               reviewed it. Merged ones stay a day, as Done.
 *   local stories               a branch's story before any PR (`once-upon local`): on a card of that repo and branch (a
 *                               branch-only card when nothing else is there, while it waits for review), as its story
 *                               when the branch has no PR story, with the same Ready and Back to you rules
 *   GitHub, through AutoReview  per PR: approvals, merge state, checks, new comments (review-inbox/auto-review.ts). It is asked in
 *                               the background and the board reads what it has, so a poll never waits for GitHub. A
 *                               session's branch without a story is looked up the same way.
 *   <projects dir>              each session's transcript, to tell a session with no prompt yet (blank.ts): those are a
 *                               strip in the Idle lane, not cards; and for its title when the tab's name says nothing
 *                               (titles.ts)
 *   <home>/statusline/          each session's context use and the usage limits, as a status line script copies them
 *                               (statusline.ts)
 *
 * The board shows your own work: sessions on this Mac, and PRs you authored (isShown). Columns follow the work to
 * merge (columns.ts). A lane is the repo's name (else the folder's name): the page puts a lane's label right above its
 * cards inside each column. Sessions share a card only on the same live branch (a PR still open, or a story); any other
 * session is a card of its own, titled by the session. A ledger agent is a card of its own, on its own lane (its
 * `lane:<name>` tag, else the repo its task names, else its parent's), with a "from <parent session>" link, only while
 * it is running or waiting; a finished one has no card. It is nested inside its parent's card only when tightly tied to
 * it, on the same branch or PR (agent-home.ts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSettings } from '../config/settings.ts';
import {
  REPO_RE,
  checkoutFor,
  lastKnownRepo,
  repoOfCheckoutAsync,
  sameRepo,
  seenCheckouts,
  storyRepo,
} from '../config/repos.ts';
import { ID_RE as STORY_ID_RE, readMeta } from '../stories/meta.ts';
import { runGitAsync } from '../util/git.ts';
import { checkoutsOf } from './checkouts.ts';
import { shipMode } from '../stories/push-default.ts';
import { aheadOf } from '../stories/pull-request.ts';
import { gateOf, readAgents, type LedgerAgent } from './ledger.ts';
import { BlankSessions } from './blank.ts';
import { SessionTitles } from './titles.ts';
import { readStatusLines } from './statusline.ts';
import { columnOf } from './columns.ts';
import { BacklogStore, assignBranch, assignLine, backlogCards, liveAssignment } from './backlog.ts';
import type { AddInput, BacklogItem, MoveTo } from './backlog.ts';
import { gatedHome, laneForAgent, tiedToParent } from './agent-home.ts';
import { parseWorktrees, startedLinks } from './backlog-links.ts';
import type { Worktree } from './backlog-links.ts';
import { readVoice, voiceLines, voiceStatus } from './voice.ts';
import {
  assignCandidates,
  buildFor,
  listenCandidates,
  listenPromptFor,
  listenStoryPromptFor,
  listenersLane,
  listeningOnly,
  parentMap,
  sessionOfPid,
  storyListening,
} from './listening.ts';
import type { ListeningInput } from './listening.ts';
import { requestStop } from '../listeners/auto-stop.ts';
import { listeners } from '../listeners/listeners.ts';
import {
  findIt2,
  focusTab,
  pickSource,
  run,
  typeLine,
  type LiveSession,
  type StatusSource,
} from './sources.ts';
import { HttpError } from '../server/request.ts';
import {
  DEFAULT_BRANCHES,
  isAutoDone,
  localEntries,
  mergedStories,
  prStories,
} from '../review-inbox/stories.ts';
import { requestFor } from '../inbox/progress.ts';
import type { Builds } from '../inbox/builds.ts';
import type { BranchPr } from '../review-inbox/auto-review.ts';
import type { LocalEntry } from '../review-inbox/stories.ts';
import type { StoryStore } from '../stories/store.ts';
import type {
  BoardAgent,
  BoardBeat,
  BoardBlankSession,
  BoardCard,
  BoardColumn,
  BoardData,
  BoardSession,
  BoardStartedLinks,
  BoardStatus,
  BoardVoice,
  InboxLocalStory,
  InboxStory,
  PrInfo,
  ShipMode,
} from '@once-upon-a-diff/shared/types';

/** What the board asks of the GitHub watcher (review-inbox/auto-review.ts's AutoReview): it reads what it has and never waits. */
export interface PrWatcher {
  kick(stories: InboxStory[]): void;
  kickInfo(repo: string, number: number): void;
  kickBranch(repo: string, branch: string, checkout: string): void;
  kickLocal(list: LocalEntry[]): void;
  kickRequested(): void;
  requested(): { repo: string; number: number }[];
  info(repo: string, number: number): PrInfo | null;
  branchPr(repo: string, branch: string): BranchPr | null | undefined;
}

/** The board's answers are kept this long, so several open pages cost one round of reads. */
const CACHE_MS = 2000;
/** A running agent with no done line this long after it started is marked stale. */
const STALE_MS = 24 * 3600 * 1000;
export { DEFAULT_BRANCHES };
/** A merged PR stays on the board this long. */
const MERGED_HOURS = 24;

const AGENT_OPEN = ['running', 'waiting', 'plan', 'fixing'];

/** A path a task names as the folder it is in: itself when a folder, its folder when a file, null when it is not there. */
function dirOf(candidate: string): string | null {
  try {
    return statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
  } catch {
    return null;
  }
}
const BRANCH_CACHE_MS = 10000;
/** How often a branch's commits-ahead count is looked at again (git ls-remote each time). */
const AHEAD_MS = 60000;
/** A snapshot waits this long for a session's repo to be looked up, then goes on without it (what was last known, or none). */
const REPO_WAIT_MS = 500;

interface Registry {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  name?: unknown;
  status?: unknown;
  statusUpdatedAt?: unknown;
  startedAt?: unknown;
  procStart?: unknown;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The registry's live sessions: files whose pid is running, with their ttys. */
export async function liveSessions(dir: string): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const found: (LiveSession & { procStart: string | null })[] = [];
  for (const name of names) {
    let reg: Registry;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      // `null`, a number or a string is valid JSON but not a registry file: it drops only itself
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      reg = parsed as Registry;
    } catch {
      continue;
    }
    const pid = Number(reg.pid);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof reg.sessionId !== 'string' ||
      typeof reg.cwd !== 'string'
    ) {
      continue;
    }
    found.push({
      pid,
      session: reg.sessionId,
      cwd: reg.cwd,
      name: typeof reg.name === 'string' && reg.name ? reg.name : null,
      tty: null,
      status: typeof reg.status === 'string' ? reg.status : 'idle',
      statusAt: typeof reg.statusUpdatedAt === 'number' ? reg.statusUpdatedAt : null,
      startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : null,
      procStart: typeof reg.procStart === 'string' ? collapse(reg.procStart) : null,
    });
  }
  if (!found.length) {
    return [];
  }
  // ps in UTC with a fixed locale answers the pid's tty and start time in the registry's procStart form; no ps (or a
  // pid it doesn't list) falls back to a plain liveness check
  const listing = await run(
    'ps',
    ['-o', 'pid=,tty=,lstart=', '-p', found.map((live) => live.pid).join(',')],
    4000,
    { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  );
  const rows = new Map<number, { tty: string; start: string }>();
  for (const line of (listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) {
      rows.set(Number(match[1]), { tty: match[2], start: collapse(match[3]) });
    }
  }
  return found
    .filter((live) => {
      const row = rows.get(live.pid);
      if (row) {
        return !live.procStart || live.procStart === row.start;
      }
      if (listing !== null) {
        return false;
      }
      try {
        process.kill(live.pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    })
    .map(({ procStart: _procStart, ...live }) => ({
      ...live,
      tty: rows.get(live.pid)?.tty.replace(/^\?+$/, '') || null,
    }));
}

/** A lane's name for a folder, given the GitHub repo its origin points at (null when unknown): the repo's name, else the folder's own. */
function laneOf(cwd: string, repo: string | null): string {
  return repo ? repo.split('/')[1] : path.basename(cwd) || cwd;
}

/** The lane for an agent whose session is gone and that names no lane. */
const NO_PARENT = 'No live session';

const AGENT_STATUS: Record<LedgerAgent['state'], BoardStatus> = {
  running: 'working',
  waiting: 'waiting',
  plan: 'working',
  fixing: 'working',
  done: 'done',
  failed: 'error',
  stopped: 'done',
};

function agentOf(agent: LedgerAgent, beat: BoardBeat | undefined, now: number): BoardAgent {
  // still open: running, or at a gate (when it began is the line's time, not the original start)
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  const began = agent.state === 'running' ? agent.started : agent.ended || agent.started;
  return {
    name: agent.name,
    state: agent.state,
    status: AGENT_STATUS[agent.state],
    task: agent.task,
    model: agent.model,
    started_at: agent.started?.toISOString() ?? null,
    ended_at: agent.ended?.toISOString() ?? null,
    outcome: agent.outcome,
    stale: open && !!began && now - began.getTime() > STALE_MS,
    beat: beat || null,
    gate: gateOf(agent),
  };
}

/**
 * Whose PRs the board shows: the ones you authored (the signed-in gh user's), and other people's only when something is
 * for you in them: a story built for you, a review GitHub is waiting on you for, or a session of yours building for
 * them. A PR GitHub hasn't described yet has no author and is let through, so a session's card doesn't flicker; with no
 * session on it, it waits for its author (workCard). The one place to change what the board covers.
 */
const isShown = (pr: PrInfo, forYou: { story: boolean; building: boolean }): boolean =>
  pr.mine || pr.author === null || pr.review_requested || forYou.story || forYou.building;

/** A watcher that knows nothing (the CLI's one-off count, which has no cache to read). */
export const noPrWatcher: PrWatcher = {
  kick: () => undefined,
  kickInfo: () => undefined,
  kickBranch: () => undefined,
  kickLocal: () => undefined,
  kickRequested: () => undefined,
  requested: () => [],
  info: () => null,
  branchPr: () => undefined,
};

/** The pinned strip's data, or null when voice is off or its session isn't running. */
/** The voice session as the board found it among the live sessions. */
interface PinnedVoice {
  view: BoardSession;
  lane: string;
  repo: string | null;
  busy: boolean;
}

function voiceOf(
  pinned: PinnedVoice | null,
  files: ReturnType<typeof readVoice>,
  agents: LedgerAgent[],
  nowMs: number,
  dir: string,
): BoardVoice | null {
  if (!pinned || !files) {
    return null;
  }
  const mine = agents.filter((agent) => pinned.view.id.startsWith(agent.sid));
  return {
    name: files.name || pinned.view.title,
    title: pinned.view.title,
    repo: pinned.repo,
    lane: pinned.lane,
    branch: pinned.view.branch,
    status: voiceStatus(files, pinned.busy, nowMs),
    since: pinned.view.since,
    agents: {
      running: mine.filter((agent) => agent.state === 'running').length,
      waiting: mine.filter((agent) => agent.state === 'waiting').length,
    },
    session: pinned.view.id,
    can_focus: pinned.view.focus,
    context: pinned.view.context ?? null,
    lines: voiceLines(dir, pinned.view.id),
  };
}

/** A unit of work being assembled: a PR (with or without its story) or a branch that has no PR yet. */
interface Work {
  key: string;
  repo: string | null;
  number: number | null;
  branch: string | null;
  story: InboxStory | null;
  /** a local story of the branch, for a branch with no PR story: the card's story then */
  local: InboxLocalStory | null;
  mergedAt: string | null;
  title: string | null;
  /** a story was built for this PR (even one whose PR has since merged) */
  built: boolean;
  sessions: SessionView[];
}

/** Built after you last opened or reviewed it (never opened: it is ready for review, not back to you). */
const isUnread = (story: Pick<InboxStory, 'built_at' | 'seen_at'>): boolean =>
  !!story.seen_at && Date.parse(story.built_at) > Date.parse(story.seen_at);

/**
 * Whether a story was built after you last opened it. A local story marked done by a check (its branch has a PR, it is in
 * the default branch, or it went idle) stays done through a rebuild: its work has left, or nobody is looking.
 */
const unreadOf = (story: InboxStory | InboxLocalStory): boolean =>
  isUnread(story) && ('number' in story || !isAutoDone(story));

/** What the board reads of a built story, a PR story's or a local one's. */
type StoryFacts = Pick<InboxStory, 'id' | 'built_at' | 'reviewed_at' | 'reviewed_by'>;

/** A live session with what the board worked out about it. */
interface SessionView {
  card: BoardSession;
}

/** What GitHub hasn't told yet about an open PR: just its number, so the card can sit in the PR open column. */
const stubPr = (repo: string, number: number, title: string, branch: string | null): PrInfo => ({
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  title,
  state: 'open',
  draft: false,
  branch,
  author: null,
  mine: false,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
});

const earliest = (times: (string | null | undefined)[]): string | null =>
  times.filter((time): time is string => !!time).sort()[0] ?? null;

/** The data behind /board/. The instance remembers when each session entered its status, since the registry's time is for its own. */
export class Board {
  private seen = new Map<string, { status: BoardStatus; since: number }>();
  private branches = new Map<string, { at: number; branch: string | null }>();
  /** whether a branch's commits are in its repo's main checkout (mergedLocally), kept a few seconds */
  private landed = new Map<string, { at: number; merged: boolean; mergedAt: number | null }>();
  /** a checkout's worktrees (git worktree list), kept a few seconds */
  private trees = new Map<string, { at: number; list: Worktree[] }>();
  private cache: { at: number; data: BoardData } | null = null;
  /** What the last snapshot knew of the sessions, for the panel's Start listening (listenSessions). */
  private listeningNow: { input: ListeningInput; voice: string | null } | null = null;
  /** The build in flight, so callers arriving while it runs share it instead of starting another. */
  private building: Promise<BoardData> | null = null;
  /** how each approved local story ships, worked out once per snapshot (build) */
  private shipById = new Map<string, ShipMode>();
  /** the newest local story's checkout for each repo and branch, for a PR card's commits-ahead count (build) */
  private localCheckouts = new Map<string, { story: string; checkout: string }>();
  /** commits ahead of origin per checkout and branch, looked up in the background (kickAhead) */
  private aheads = new Map<string, { at: number; count: number | null }>();
  /** Bumped when what a build read is out of date, so a build that started before it does not fill the cache. */
  private generation = 0;
  private blank = new BlankSessions();
  private titles = new SessionTitles();
  private backlog: BacklogStore;

  private home: string;
  private stories: StoryStore;
  private review: PrWatcher;
  private builds: Builds;
  private options: {
    source?: StatusSource;
    now?: () => Date;
    repoOf?: (cwd: string) => Promise<string | null>;
    typeLine?: typeof typeLine;
    aheadOf?: typeof aheadOf;
  };

  /** `options` are for tests: their own status source, clock, repo lookup and tab typing. */
  constructor(
    home: string,
    stories: StoryStore,
    review: PrWatcher,
    builds: Builds,
    options: {
      source?: StatusSource;
      now?: () => Date;
      repoOf?: (cwd: string) => Promise<string | null>;
      typeLine?: typeof typeLine;
      aheadOf?: typeof aheadOf;
    } = {},
  ) {
    this.home = home;
    this.stories = stories;
    this.review = review;
    this.builds = builds;
    this.options = options;
    this.backlog = new BacklogStore(home);
  }

  /** Adds a backlog item (a page's Add), and drops the kept snapshot so the card shows on the next poll. */
  addBacklog(input: AddInput): BacklogItem {
    const item = this.backlog.add(input);
    this.invalidate();
    return item;
  }

  /** Moves a backlog item (a card dragged, or its up and down buttons). */
  moveBacklog(id: string, where: MoveTo, who: string): BacklogItem {
    const item = this.backlog.move(id, where, who);
    this.invalidate();
    return item;
  }

  /** Drops a backlog item (a card's Drop). */
  dropBacklog(id: string, who: string): BacklogItem {
    const item = this.backlog.drop(id, who);
    this.invalidate();
    return item;
  }

  async snapshot(): Promise<BoardData> {
    const now = (this.options.now || (() => new Date()))();
    if (this.cache && now.getTime() - this.cache.at < CACHE_MS && now.getTime() >= this.cache.at) {
      return this.cache.data;
    }
    if (!this.building) {
      const generation = this.generation;
      const running = this.build(now)
        .then((data) => {
          if (generation === this.generation) {
            this.cache = { at: now.getTime(), data };
          }
          return data;
        })
        .finally(() => {
          if (this.building === running) {
            this.building = null;
          }
        });
      this.building = running;
    }
    return this.building;
  }

  /** Drop the kept answer, and keep a build already running from refilling it with what it read before the change. */
  private invalidate(): void {
    this.generation += 1;
    this.cache = null;
  }

  /**
   * The GitHub repo of a session's folder, without holding the snapshot up: it waits for the lookup (timed out and
   * kept per folder in config/repos.ts) only a moment, then goes on with what was last known. A lookup that finishes
   * later drops the kept snapshot, so the next one has it.
   */
  private async repoOf(cwd: string): Promise<string | null> {
    const lookup = (this.options.repoOf || repoOfCheckoutAsync)(cwd);
    let timer: NodeJS.Timeout | undefined;
    const late = Symbol('late');
    const first = await Promise.race([
      lookup,
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), REPO_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (first !== late) {
      return first;
    }
    void lookup.then(() => this.invalidate());
    return lastKnownRepo(cwd) ?? null;
  }

  /**
   * A PR card's commits ahead of origin, as the checkout of a local story of its branch has them. The look (git
   * ls-remote) runs in the background, at most every AHEAD_MS, and a change drops the kept snapshot. Null when the branch
   * has no local story, or nothing is ahead.
   */
  private aheadFor(repo: string, branch: string): BoardCard['ahead'] {
    const found = this.localCheckouts.get(`${repo.toLowerCase()}@${branch}`);
    if (!found) {
      return null;
    }
    const key = `${found.checkout}\0${branch}`;
    const kept = this.aheads.get(key);
    const now = Date.now();
    if (!kept || now - kept.at >= AHEAD_MS) {
      // the old answer stays until the new one arrives, and a failed look keeps it
      this.aheads.set(key, { at: now, count: kept?.count ?? null });
      (this.options.aheadOf || aheadOf)(found.checkout, branch)
        .then((count) => {
          const last = this.aheads.get(key);
          if (count !== null && last?.count !== count) {
            this.invalidate();
          }
          this.aheads.set(key, { at: Date.now(), count: count ?? last?.count ?? null });
        })
        .catch(() => undefined);
    }
    const count = kept?.count;
    return count ? { count, story: found.story } : null;
  }

  /** A checkout's current branch (null when detached or not a repo), kept a few seconds. */
  private async branchOf(cwd: string, now: number): Promise<string | null> {
    const kept = this.branches.get(cwd);
    if (kept && now - kept.at < BRANCH_CACHE_MS) {
      return kept.branch;
    }
    // symbolic-ref also answers on a branch with no commits yet, and fails when HEAD is detached
    const out = await runGitAsync(cwd, ['symbolic-ref', '--short', 'HEAD'], { timeout: 3000 });
    const branch = out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
    this.branches.set(cwd, { at: now, branch });
    return branch;
  }

  /** The worktrees of a checkout's repo (every checkout of it, this one included), kept a few seconds; none when it isn't a repo. */
  private async worktreesOf(cwd: string, now: number): Promise<Worktree[]> {
    const kept = this.trees.get(cwd);
    if (kept && now - kept.at < BRANCH_CACHE_MS) {
      return kept.list;
    }
    const out = await runGitAsync(cwd, ['worktree', 'list', '--porcelain'], { timeout: 3000 });
    const list = out.code === 0 ? parseWorktrees(out.stdout) : [];
    this.trees.set(cwd, { at: now, list });
    return list;
  }

  /**
   * Whether a branch's work is in the repo's main line with no PR to say so (a fast-forward into the main checkout's
   * branch, as Larmor's work lands): the branch has moved since it was created (its reflog) and its tip is in the main
   * checkout's branch, main or master, local or origin's. A branch with no commits of its own is not merged.
   */
  private async mergedLocally(
    trees: Worktree[],
    branch: string,
    now: number,
  ): Promise<{ at: number | null } | null> {
    const main = trees[0];
    if (!main || !trees.some((tree) => tree.branch === branch)) {
      return null;
    }
    const key = `${main.path}@${branch}`;
    const kept = this.landed.get(key);
    if (kept && now - kept.at < BRANCH_CACHE_MS) {
      return kept.merged ? { at: kept.mergedAt } : null;
    }
    const log = await runGitAsync(
      main.path,
      ['reflog', 'show', '--format=%H', `refs/heads/${branch}`],
      { timeout: 3000 },
    );
    const shas = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [];
    let merged = false;
    let mergedAt: number | null = null;
    if (shas.length > 1 && shas[0] !== shas[shas.length - 1]) {
      const lines = [main.branch, 'main', 'master']
        .filter((name): name is string => !!name && name !== branch)
        .flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`]);
      for (const line of [...new Set(lines)]) {
        const check = await runGitAsync(
          main.path,
          ['merge-base', '--is-ancestor', `refs/heads/${branch}`, line],
          { timeout: 3000 },
        );
        if (check.code === 0) {
          merged = true;
          break;
        }
      }
      if (merged) {
        // when it landed: the branch tip's commit time (a fast-forward keeps its commits' own times)
        const tip = await runGitAsync(
          main.path,
          ['log', '-1', '--format=%ct', `refs/heads/${branch}`],
          {
            timeout: 3000,
          },
        );
        const seconds = tip.code === 0 ? Number(tip.stdout.trim()) : NaN;
        mergedAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      }
    }
    this.landed.set(key, { at: now, merged, mergedAt });
    return merged ? { at: mergedAt } : null;
  }

  private async build(now: Date): Promise<BoardData> {
    const nowMs = now.getTime();
    const settings = readSettings(this.home).board;
    const picked = this.options.source
      ? { source: this.options.source, warning: null }
      : pickSource(settings.statusSource, settings.it2Path);
    const live = await liveSessions(settings.sessionsDir);
    const [known, branches, repos] = await Promise.all([
      picked.source.statuses(live),
      Promise.all(live.map((session) => this.branchOf(session.cwd, nowMs))),
      Promise.all(live.map((session) => this.repoOf(session.cwd))),
    ]);
    const { agents, beats } = readAgents(
      { ledger: settings.ledgerFile, progress: settings.progressFile },
      now,
      settings.ledgerTimeZone,
    );

    // the units of work: every built PR story, and the PRs merged in the last day
    const stories = prStories(this.stories, { now: nowMs });
    this.review.kick(stories);
    const prKey = (repo: string, number: number) => `pr:${repo.toLowerCase()}#${number}`;
    const works = new Map<string, Work>();
    const start = (work: Omit<Work, 'sessions' | 'local'>) =>
      works.set(work.key, { ...work, local: null, sessions: [] });
    for (const story of stories) {
      start({
        key: prKey(story.repo, story.number),
        repo: story.repo,
        number: story.number,
        branch: story.branch,
        story,
        mergedAt: null,
        title: story.title,
        built: true,
      });
    }
    for (const merged of mergedStories(this.stories, { hours: MERGED_HOURS, now: nowMs })) {
      start({
        key: prKey(merged.repo, merged.number),
        repo: merged.repo,
        number: merged.number,
        branch: merged.branch,
        story: null,
        mergedAt: merged.merged_at,
        title: merged.title,
        built: true,
      });
    }
    // PRs GitHub is waiting on your review for, and your own open ones, are units of work too, with or without a story
    this.review.kickRequested();
    for (const request of this.review.requested()) {
      const key = prKey(request.repo, request.number);
      if (!works.has(key)) {
        start({
          key,
          repo: request.repo,
          number: request.number,
          branch: null,
          story: null,
          mergedAt: null,
          title: null,
          built: false,
        });
      }
    }
    // a PR a session has claimed a build, rebuild or fix for is a unit of work even with no story yet
    for (const build of this.builds.pending()) {
      const key = build.repo && build.number ? prKey(build.repo, build.number) : null;
      if (
        key &&
        build.repo &&
        build.number &&
        !works.has(key) &&
        this.builds.stateOf(build) === 'building'
      ) {
        start({
          key,
          repo: build.repo,
          number: build.number,
          branch: null,
          story: null,
          mergedAt: null,
          title: null,
          built: false,
        });
      }
    }
    // local stories (a branch's story before any PR): the newest per repo and branch goes on that branch's work, or on a
    // branch-only work of its own; a PR story already on the branch is the card's story, so a local one is not
    const localEntryList = localEntries(this.stories, { now: nowMs });
    this.review.kickLocal(localEntryList);
    // how each approved story ships (Push or Create pull request), for its Ready to ship card
    this.shipById = new Map(
      localEntryList
        .filter((entry) => entry.story.approved_at && entry.repo_path)
        .map((entry) => [
          entry.story.id,
          shipMode(
            {
              kind: 'local',
              repo: entry.story.repo,
              repo_path: entry.repo_path as string,
              branch: entry.story.branch,
              head_oid: entry.head_oid,
            },
            this.home,
          ),
        ]),
    );
    this.localCheckouts = new Map();
    for (const entry of localEntryList) {
      const { repo, branch } = entry.story;
      if (repo && branch && entry.repo_path) {
        const key = `${repo.toLowerCase()}@${branch}`;
        if (!this.localCheckouts.has(key)) {
          this.localCheckouts.set(key, { story: entry.story.id, checkout: entry.repo_path });
        }
      }
    }
    const localStoryList = localEntryList.map((entry) => entry.story);
    const newestLocal = new Map<string, InboxLocalStory>();
    for (const local of localStoryList) {
      if (local.repo && local.branch && !DEFAULT_BRANCHES.has(local.branch)) {
        const key = `${local.repo.toLowerCase()}@${local.branch}`;
        newestLocal.set(key, newestLocal.get(key) ?? local);
      } else if (local.repo) {
        // a story of commits on a default branch, or of a commit range with no branch (one commit each, say): no
        // branch to share, so a card of its own, shown while it waits for review (workCard drops it after)
        start({
          key: `story:${local.id}`,
          repo: local.repo,
          number: null,
          branch: null,
          story: null,
          mergedAt: null,
          title: local.title,
          built: true,
        });
        (works.get(`story:${local.id}`) as Work).local = local;
      }
    }
    const branchOfWork = (work: Work) =>
      work.branch ??
      (work.repo && work.number ? this.review.info(work.repo, work.number)?.branch : null);
    for (const local of newestLocal.values()) {
      const repo = local.repo as string;
      const there = [...works.values()].find(
        (work) => work.repo && sameRepo(work.repo, repo) && branchOfWork(work) === local.branch,
      );
      if (!there) {
        start({
          key: `branch:${repo.toLowerCase()}@${local.branch}`,
          repo,
          number: null,
          branch: local.branch,
          story: null,
          mergedAt: null,
          title: local.title,
          built: true,
        });
        (works.get(`branch:${repo.toLowerCase()}@${local.branch}`) as Work).local = local;
      } else if (!there.story && !there.mergedAt) {
        there.local = local;
      }
    }

    // a session whose only activity is a listener's wait is shown in the Listeners lane alone, not as a card too
    const waits = listeners(this.home, nowMs).filter((wait) => wait.live);
    const parents = waits.length ? await parentMap() : new Map<number, number>();
    const sessionByPid = new Map(live.map((one) => [one.pid, one.session]));
    const quiet = listeningOnly(live, known, waits, parents, sessionByPid, agents);
    const quietViews: BoardSession[] = [];

    // the voice session is pinned above the columns, so it is on no card (its agents keep theirs)
    const voiceFiles = settings.voiceDir ? readVoice(settings.voiceDir) : null;
    const pin: { found: PinnedVoice | null } = { found: null };

    // sessions with no prompt yet (new, or just cleared) that are at rest and would be cards of their own: the Blank strip
    const blankIds = new Set<string>();
    await Promise.all(
      live.map(async (session) => {
        const status = known.get(session.session)?.status;
        const resting =
          session.status !== 'busy' && (!status || status === 'idle' || status === 'done');
        const voiced = !!voiceFiles && session.session === voiceFiles.session;
        if (
          resting &&
          !voiced &&
          !quiet.has(session.session) &&
          (await this.blank.isBlank(settings.projectsDir, session.session, session.cwd, nowMs))
        ) {
          blankIds.add(session.session);
        }
      }),
    );
    this.blank.keep(new Set(live.map((session) => session.session)));
    // each session's own title from its transcript, for when the tab's name says nothing (titles.ts)
    const titles = new Map<string, string>();
    await Promise.all(
      live.map(async (session) => {
        const title = await this.titles.titleOf(
          settings.projectsDir,
          session.session,
          session.cwd,
          nowMs,
        );
        if (title) {
          titles.set(session.session, title);
        }
      }),
    );
    this.titles.keep(new Set(live.map((session) => session.session)));
    // each session's context use and the usage limits, from the status line's copies (statusline.ts)
    const statusLines = readStatusLines(
      this.home,
      new Set(live.map((session) => session.session)),
      nowMs,
    );
    const blankViews: { lane: string; view: BoardSession }[] = [];

    // sessions: one on a branch of its own joins that branch's work, the rest are cards of their own
    const sessionCards: BoardCard[] = [];
    const repoBySession = new Map<string, string | null>();
    const seenNow = new Set<string>();
    live.forEach((session, index) => {
      const extra = known.get(session.session);
      const status: BoardStatus = extra?.status || (session.status === 'busy' ? 'working' : 'idle');
      const tracked = this.seen.get(session.session);
      let since = session.statusAt || session.startedAt || nowMs;
      if (tracked) {
        since = tracked.status === status ? tracked.since : nowMs;
      }
      this.seen.set(session.session, { status, since });
      seenNow.add(session.session);
      const repo = repos[index];
      repoBySession.set(session.session, repo);
      const branch = branches[index];
      const view: SessionView = {
        card: {
          id: session.session,
          title:
            extra?.title ||
            titles.get(session.session) ||
            session.name ||
            path.basename(session.cwd),
          cwd: session.cwd,
          branch,
          status,
          detail: extra?.detail || null,
          since: new Date(since).toISOString(),
          source: extra ? (picked.source.name as 'iterm' | 'registry') : 'registry',
          focus: picked.source.name === 'iterm' && !!extra,
          context: statusLines.context.get(session.session) ?? null,
          rested_at:
            session.status !== 'busy' && session.statusAt
              ? new Date(session.statusAt).toISOString()
              : null,
        },
      };
      if (quiet.has(session.session) && !(voiceFiles && session.session === voiceFiles.session)) {
        quietViews.push(view.card);
        return;
      }
      if (voiceFiles && session.session === voiceFiles.session) {
        pin.found = {
          view: view.card,
          lane: laneOf(session.cwd, repo),
          repo,
          busy: session.status === 'busy',
        };
        return;
      }
      // a session standing alone is a card of its own, unless it has had no prompt yet: then it is a chip in the Blank strip
      const alone = () => {
        if (blankIds.has(session.session)) {
          blankViews.push({ lane: laneOf(session.cwd, repo), view: view.card });
        } else {
          sessionCards.push(this.sessionCard(session, view, repo));
        }
      };
      if (!repo || !branch || DEFAULT_BRANCHES.has(branch)) {
        alone();
        return;
      }
      // sessions share a card only on the same live branch, one that has a PR still open or a story; otherwise the session
      // is a card of its own, titled by the session (a branch whose PR merged or closed, or that has no PR, is no unit of work)
      const live = (candidate: Work) =>
        !candidate.mergedAt &&
        (!candidate.number ||
          !candidate.repo ||
          (this.review.info(candidate.repo, candidate.number)?.state ?? 'open') === 'open');
      let work = [...works.values()].find(
        (candidate) =>
          candidate.repo &&
          sameRepo(candidate.repo, repo) &&
          branchOfWork(candidate) === branch &&
          live(candidate) &&
          (candidate.number || candidate.story || candidate.local),
      );
      if (!work) {
        const found = this.review.branchPr(repo, branch);
        this.review.kickBranch(repo, branch, session.cwd);
        if (found && found.state === 'open') {
          const key = prKey(repo, found.number);
          if (!works.has(key)) {
            start({
              key,
              repo,
              number: found.number,
              branch,
              story: null,
              mergedAt: null,
              title: null,
              built: false,
            });
          }
          work = works.get(key);
        }
      }
      if (work && !work.number && work.local) {
        // a branch with a local story and no PR yet, until GitHub says it has one
        const found = this.review.branchPr(repo, branch);
        this.review.kickBranch(repo, branch, session.cwd);
        if (found && found.state === 'open' && !works.has(prKey(repo, found.number))) {
          work.number = found.number;
        } else if (found?.state === 'merged') {
          // the branch's PR merged: its local story is done, so a session still on the branch is a card of its own
          work.number = found.number;
          work.mergedAt = found.merged_at;
        }
      }
      if (work && live(work)) {
        work.sessions.push(view);
      } else {
        alone();
      }
    });
    for (const id of this.seen.keys()) {
      if (!seenNow.has(id)) {
        this.seen.delete(id);
      }
    }

    // cards for the works: PR details from what GitHub last said
    const cards: BoardCard[] = [...sessionCards];
    for (const work of works.values()) {
      const card = this.workCard(work, nowMs);
      if (card) {
        cards.push(card);
      }
    }

    // agents: a card of their own, on their own lane, unless tightly tied to their parent's card (tiedToParent)
    const cardsBySid = new Map<string, BoardCard>();
    for (const card of cards) {
      for (const session of card.sessions) {
        const sid = session.id.slice(0, 8);
        cardsBySid.set(sid, cardsBySid.get(sid) || card);
      }
    }
    const shown = agents.filter(
      (agent) =>
        agent.state === 'running' ||
        agent.state === 'waiting' ||
        agent.state === 'plan' ||
        agent.state === 'fixing' ||
        (agent.ended?.getTime() ?? 0) >= nowMs - settings.doneHours * 3600 * 1000,
    );
    // the lanes already on the board, which an agent's task text can name
    const knownLanes = [
      ...new Set([
        ...cards.map((card) => card.lane),
        ...agents.flatMap((agent) => agent.lane || []),
      ]),
    ].filter((lane) => lane !== NO_PARENT);
    for (const agent of shown) {
      const view = agentOf(agent, beats.get(agent.name), nowMs);
      const parent = cardsBySid.get(agent.sid) || null;
      const voiceParent = pin.found && pin.found.view.id.startsWith(agent.sid) ? pin.found : null;
      const parentSession =
        parent?.sessions.find((one) => one.id.startsWith(agent.sid)) ?? voiceParent?.view;
      if (parent && tiedToParent(agent, parent)) {
        parent.agents.push(view);
        continue;
      }
      // an agent at a gate belongs in the card of the branch or PR its task names, wherever its launching session is
      const home = view.gate
        ? gatedHome(agent, cards, parent?.lane ?? voiceParent?.lane ?? null)
        : null;
      if (home) {
        home.agents.push(view);
        continue;
      }
      // an agent gets a card of its own only while it is running, at a gate or waiting on you; a finished one (done,
      // stopped or failed) has none, and its result is in its notes
      if (agent.state === 'done' || agent.state === 'failed' || agent.state === 'stopped') {
        continue;
      }
      cards.push({
        id: `agent:${agent.sid}:${agent.name}`,
        kind: 'agent',
        title: agent.name,
        repo: null,
        branch: null,
        lane: laneForAgent(agent, knownLanes, parent?.lane ?? voiceParent?.lane ?? null, NO_PARENT),
        column: view.gate ? 'checks' : AGENT_COLUMN[agent.state],
        detail:
          agent.state === 'waiting' || view.gate?.kind === 'fixing' || view.gate?.kind === 'plan'
            ? view.outcome
            : view.task,
        since: (agent.ended || agent.started)?.toISOString() ?? null,
        pr: null,
        story: null,
        building: null,
        sessions: [],
        agents: [view],
        // the pinned voice session is named for what it is, not by its tab's title
        parent: voiceParent ? 'Voice session' : (parentSession?.title ?? null),
        focus_session: parentSession?.id ?? null,
        can_focus: parentSession?.focus ?? false,
        listening: null,
        build: null,
      });
    }

    // the columns, now that every card has its sessions and agents
    const byStory = new Map<string, StoryFacts>(
      [...stories, ...localStoryList].map((story) => [story.id, story]),
    );
    for (const card of cards) {
      if (card.kind !== 'agent') {
        this.place(card, byStory);
      }
    }

    // listeners: a story's own listener marks its card with the session that listens; repos get the Listeners lane. A
    // session can be typed into (Build story, Start listening) when it is at its prompt: not working, not waiting on you
    const sessionViews = new Map<string, BoardSession>();
    quietViews.forEach((view) => sessionViews.set(view.id, view));
    for (const card of cards) {
      card.sessions.forEach((view) => sessionViews.set(view.id, view));
    }
    if (pin.found) {
      sessionViews.set(pin.found.view.id, pin.found.view);
    }
    blankViews.forEach((item) => sessionViews.set(item.view.id, item.view));
    const idle = new Set(
      [...sessionViews.values()]
        .filter((view) => view.status === 'idle' || view.status === 'done')
        .map((view) => view.id),
    );
    const listening = {
      home: this.home,
      now: nowMs,
      parents,
      sessionByPid,
      sessions: sessionViews,
      repoOf: repoBySession,
      idle,
    };
    this.listeningNow = { input: listening, voice: pin.found?.view.id ?? null };
    for (const card of cards) {
      if (card.story) {
        card.listening = storyListening(card.story.id, waits, listening);
      }
      if (card.column !== 'done' && card.column !== 'ship') {
        card.build = buildFor(card, idle);
      }
    }

    // the Backlog column: open items, and started ones are marked onto the work cards they became
    const cardless = [
      ...quietViews.map((view) => ({
        repo: repoBySession.get(view.id) ?? null,
        branch: view.branch,
        label: view.title,
      })),
      ...(pin.found
        ? [{ repo: pin.found.repo, branch: pin.found.view.branch, label: 'Voice session' }]
        : []),
    ];
    const backlogItems = this.backlog.items();
    // what each started item is being worked by: worktrees on its branch, sessions, its ledger agent, whether it merged
    const startedItems = backlogItems.filter((item) => item.state === 'started' && item.branch);
    const treesByRepo = new Map<string, Worktree[]>();
    await Promise.all(
      [
        ...new Set(startedItems.flatMap((item) => (item.repo ? [item.repo.toLowerCase()] : []))),
      ].map(async (key) => {
        const repo = startedItems.find((item) => item.repo?.toLowerCase() === key)?.repo as string;
        // every checkout of the repo the board can learn of (checkouts.ts); checkout_dirs only when none turns up
        const dirs = new Set<string>(
          await checkoutsOf(repo, {
            sessionDirs: live
              .filter((session) => sameRepo(repoBySession.get(session.session), repo))
              .map((session) => session.cwd),
            agentTasks: agents
              .filter(
                (agent) =>
                  AGENT_OPEN.includes(agent.state) ||
                  (agent.ended?.getTime() ?? 0) >= nowMs - settings.doneHours * 3600 * 1000,
              )
              .map((agent) => agent.task),
            seenDirs: [
              ...seenCheckouts(this.home),
              ...[...this.localCheckouts.values()].map((found) => found.checkout),
            ],
            dirOf: dirOf,
            repoOf: (dir) => this.repoOf(dir),
            fallback: () => checkoutFor(this.home, repo),
          }),
        );
        const seenPaths = new Set<string>();
        const list: Worktree[] = [];
        for (const dir of await Promise.all([...dirs].map((one) => this.worktreesOf(one, nowMs)))) {
          for (const tree of dir) {
            if (!seenPaths.has(tree.path)) {
              seenPaths.add(tree.path);
              list.push(tree);
            }
          }
        }
        treesByRepo.set(key, list);
      }),
    );
    const landedBranches = new Map<string, { at: number | null }>();
    await Promise.all(
      startedItems.map(async (item) => {
        const repoKey = (item.repo ?? '').toLowerCase();
        const landed = await this.mergedLocally(
          treesByRepo.get(repoKey) ?? [],
          item.branch as string,
          nowMs,
        );
        if (landed) {
          landedBranches.set(`${repoKey}@${item.branch}`, landed);
        }
      }),
    );
    const mergedWorks = [...works.values()].filter((work) => work.mergedAt);
    const linkFacts = {
      worktrees: treesByRepo,
      sessions: [...sessionViews.values()].map((view) => ({
        id: view.id,
        title: view.title,
        cwd: view.cwd,
        repo: repoBySession.get(view.id) ?? null,
        branch: view.branch,
      })),
      agents,
      beats,
      merged: (repo: string | null, branch: string) => {
        const landed = landedBranches.get(`${(repo ?? '').toLowerCase()}@${branch}`);
        if (landed) {
          return landed;
        }
        const mergedWork = mergedWorks.find(
          (work) => work.repo && repo && sameRepo(work.repo, repo) && branchOfWork(work) === branch,
        );
        if (mergedWork) {
          const when = Date.parse(mergedWork.mergedAt ?? '');
          return { at: Number.isNaN(when) ? null : when };
        }
        const tree = treesByRepo
          .get((repo ?? '').toLowerCase())
          ?.find((one) => one.branch === branch);
        if (repo && tree) {
          this.review.kickBranch(repo, branch, tree.path);
        }
        const found = repo ? this.review.branchPr(repo, branch) : null;
        if (found?.state !== 'merged') {
          return null;
        }
        const when = Date.parse(found.merged_at ?? '');
        return { at: Number.isNaN(when) ? null : when };
      },
    };
    const links = new Map<string, BoardStartedLinks>();
    for (const item of startedItems) {
      const found = startedLinks(item, linkFacts);
      if (found) {
        links.set(item.id, found);
      }
    }
    cards.push(...backlogCards(backlogItems, cards, nowMs, cardless, links));

    // Assign: who may be handed each open item. Not the voice session or one that listens, and not one already holding
    // another item's live assignment
    const apart = new Set<string>([
      ...(pin.found ? [pin.found.view.id] : []),
      ...quietViews.map((view) => view.id),
      ...waits
        .map((wait) => sessionOfPid(wait.pid, parents, sessionByPid))
        .filter((id): id is string => !!id),
    ]);
    for (const card of cards) {
      const item = card.backlog && backlogItems.find((one) => one.id === card.backlog?.id);
      if (!card.backlog || !item || item.state !== 'open') {
        continue;
      }
      const taken = new Set(
        backlogItems
          .filter((other) => other.id !== item.id)
          .map((other) => liveAssignment(other, nowMs)?.session)
          .filter((id): id is string => !!id),
      );
      // an item held by a session (assigned lately, not started) can only be sent to that one again, until it expires
      const holder = liveAssignment(item, nowMs)?.session;
      card.backlog.assign = {
        candidates: assignCandidates(
          item.repo,
          listening,
          new Set([...apart, ...taken]),
          new Set(blankViews.map((one) => one.view.id)),
        ).filter((one) => !holder || one.id === holder),
        prompt: assignLine(item),
      };
      if (card.backlog.assigned) {
        const view = sessionViews.get(card.backlog.assigned.session);
        card.backlog.assigned.session_title = view?.title ?? null;
      }
    }

    // lanes: one per repo (or lane tag), the cards grouped by the page into columns
    const lanes = new Map<string, { name: string; cards: BoardCard[] }>();
    for (const card of cards) {
      const key = card.lane.toLowerCase();
      const lane = lanes.get(key) || { name: card.lane, cards: [] };
      lane.cards.push(card);
      lanes.set(key, lane);
    }
    return {
      at: now.toISOString(),
      status_source: picked.source.name,
      warning: picked.warning,
      voice: voiceOf(pin.found, voiceFiles, agents, nowMs, settings.voiceDir as string),
      listeners: listenersLane(waits, listening),
      blank: blankStrip(blankViews),
      lanes: [...lanes.values()].sort((first, second) => first.name.localeCompare(second.name)),
      usage: statusLines.usage,
    };
  }

  /**
   * Brings a live session's iTerm tab to the front. The id is looked up among the registry's live sessions and its tab
   * found from its tty here, so nothing the page sent is run or passed on but the session id it names.
   */
  async focus(sessionId: string): Promise<void> {
    const settings = readSettings(this.home).board;
    const it2 = settings.statusSource === 'registry' ? null : findIt2(settings.it2Path);
    if (!it2) {
      throw new HttpError(409, 'iTerm2 (the it2 CLI) is not set up, so there is no tab to raise');
    }
    const session = (await liveSessions(settings.sessionsDir)).find(
      (live) => live.session === sessionId,
    );
    if (!session) {
      throw new HttpError(404, 'no live Claude Code session with that id');
    }
    const failed = await focusTab(it2, session.tty);
    if (failed) {
      throw new HttpError(409, failed);
    }
  }

  /** The it2 CLI and the live session to type into, or the HttpError saying why not: no it2, no such session, busy, or waiting on you. */
  private async typeable(sessionId: string): Promise<{ it2: string; session: LiveSession }> {
    const settings = readSettings(this.home).board;
    const it2 = settings.statusSource === 'registry' ? null : findIt2(settings.it2Path);
    if (!it2) {
      throw new HttpError(
        409,
        'iTerm2 (the it2 CLI) is not set up, so there is no tab to type into',
      );
    }
    const session = (await liveSessions(settings.sessionsDir)).find(
      (live) => live.session === sessionId,
    );
    if (!session) {
      throw new HttpError(404, 'no live Claude Code session with that id');
    }
    const tab = (
      await pickSource(settings.statusSource, settings.it2Path).source.statuses([session])
    ).get(sessionId);
    const status = tab?.status ?? (session.status === 'busy' ? 'working' : 'idle');
    if (session.status === 'busy' || status === 'working') {
      throw new HttpError(409, 'session busy');
    }
    if (status === 'waiting') {
      throw new HttpError(409, 'the session is waiting for you');
    }
    return { it2, session };
  }

  /**
   * Assign: types the backlog line for an item into an idle session, then records the assignment. The session must be one
   * the board offers for the item (its repo, not voice or listening, at its prompt: checked again against live status), and
   * an item another session holds, or one already started, is refused. Nothing is recorded unless the typing worked.
   */
  async assignBacklog(id: string, sessionId: string, who: string): Promise<string> {
    const item = this.backlog.items().find((one) => one.id === id);
    if (!item || item.state === 'dropped') {
      throw new HttpError(404, 'no backlog item with that id');
    }
    if (item.state === 'started') {
      throw new HttpError(409, 'that item is already started');
    }
    const held = liveAssignment(item, Date.now());
    if (held && held.session !== sessionId) {
      throw new HttpError(409, 'that item was assigned to another session a little while ago');
    }
    const { it2, session } = await this.typeable(sessionId);
    const card = (await this.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((one) => one.backlog?.id === id);
    if (!card?.backlog?.assign?.candidates.some((one) => one.id === sessionId)) {
      throw new HttpError(409, 'that session cannot take this item (its repo, or it is not free)');
    }
    const prompt = assignLine(item);
    const failed = await (this.options.typeLine || typeLine)(it2, session.tty, prompt);
    if (failed) {
      throw new HttpError(409, failed);
    }
    this.backlog.assign(id, { session: sessionId, branch: assignBranch(item), by: who });
    this.invalidate();
    return prompt;
  }

  /**
   * The repo a story belongs to (a PR story's, or the local story's repo), or null when its meta names none. A 404 for a
   * story that does not exist.
   */
  storyRepoOf(storyId: string): string | null {
    const dir = this.stories.dirOf(storyId);
    if (!dir) {
      throw new HttpError(404, 'no story with that id');
    }
    return storyRepo(readMeta(dir));
  }

  /**
   * The sessions the panel's Start listening may type into for a repo: the board's Start listening rule (idle, in the repo,
   * an iTerm tab known), without the voice session. From the board's last snapshot, so a click costs no more than a page
   * poll; `type` checks the chosen session again against live status before it types.
   */
  async listenSessions(repo: string): Promise<ReturnType<typeof listenCandidates>> {
    if (!REPO_RE.test(repo)) {
      throw new HttpError(400, 'a repo (owner/name) is needed');
    }
    await this.snapshot();
    const known = this.listeningNow;
    return known
      ? listenCandidates(repo, known.input, new Set(known.voice ? [known.voice] : []))
      : [];
  }

  /**
   * Types a line into a live session's iTerm tab and presses Enter: Build story (the card's story prompt) or Start listening
   * (`/once-upon-listen <repo>`, or with a story `/once-upon-listen --story <id>`, the panel's two buttons). The line is made
   * here from what the bridge knows, the tab is found from the session's tty, and nothing is typed unless the session is at
   * its prompt: working or waiting on you means no.
   */
  async type(
    kind: 'build' | 'listen',
    sessionId: string,
    repo: string | null,
    story: string | null = null,
  ): Promise<string> {
    const { it2, session } = await this.typeable(sessionId);
    let prompt: string | null = null;
    if (kind === 'listen' && story) {
      if (!STORY_ID_RE.test(story)) {
        throw new HttpError(400, 'a story id is needed');
      }
      // the story's own repo, when it has one: the session has to be in a checkout of it
      const owner = this.storyRepoOf(story);
      if (owner && !sameRepo(await repoOfCheckoutAsync(session.cwd), owner)) {
        throw new HttpError(409, `that session is not in a checkout of ${owner}`);
      }
      prompt = listenStoryPromptFor(story);
    } else if (kind === 'listen') {
      if (!repo || !REPO_RE.test(repo)) {
        throw new HttpError(400, 'a repo (owner/name) is needed');
      }
      if (!sameRepo(await repoOfCheckoutAsync(session.cwd), repo)) {
        throw new HttpError(409, `that session is not in a checkout of ${repo}`);
      }
      prompt = listenPromptFor(repo);
    } else {
      const cards = (await this.snapshot()).lanes.flatMap((lane) => lane.cards);
      prompt = cards.find((card) => card.build?.session === sessionId)?.build?.prompt ?? null;
      if (!prompt) {
        throw new HttpError(409, 'there is nothing to build for that session');
      }
    }
    const failed = await (this.options.typeLine || typeLine)(it2, session.tty, prompt);
    if (failed) {
      throw new HttpError(409, failed);
    }
    this.invalidate();
    return prompt;
  }

  /** The board's Stop listening: every `wait --repo` for the repo ends on its next look, within a couple of seconds. */
  stopListening(repo: string): void {
    if (!REPO_RE.test(repo)) {
      throw new HttpError(400, 'a repo (owner/name) is needed');
    }
    requestStop(this.home, repo);
    this.invalidate();
  }

  /** A card for a session that is not on a branch of its own. */
  private sessionCard(session: LiveSession, view: SessionView, repo: string | null): BoardCard {
    return {
      id: session.session,
      kind: 'session',
      title: view.card.title,
      repo,
      branch: view.card.branch,
      lane: laneOf(session.cwd, repo),
      column: 'idle',
      detail: null,
      since: null,
      pr: null,
      story: null,
      building: null,
      sessions: [view.card],
      agents: [],
      parent: null,
      focus_session: view.card.id,
      can_focus: view.card.focus,
      listening: null,
      build: null,
    };
  }

  /** A card for a work, or null when there is nothing left to show on it (a PR closed, or merged long ago, with no session). */
  private workCard(work: Work, nowMs: number): BoardCard | null {
    let pr: PrInfo | null = null;
    let story: InboxStory | InboxLocalStory | null = work.story ?? work.local;
    if (work.repo && work.number) {
      this.review.kickInfo(work.repo, work.number);
      pr =
        this.review.info(work.repo, work.number) ||
        (work.mergedAt
          ? {
              ...stubPr(work.repo, work.number, work.title || '', work.branch),
              state: 'merged',
              merged_at: work.mergedAt,
            }
          : stubPr(
              work.repo,
              work.number,
              work.title || `${work.repo}#${work.number}`,
              work.branch,
            ));
    }
    if (pr?.state === 'merged') {
      const mergedMs = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
      if (Number.isNaN(mergedMs) || nowMs - mergedMs > MERGED_HOURS * 3600 * 1000) {
        pr = null;
        story = null;
      }
    } else if (pr?.state === 'closed') {
      pr = null;
      story = null;
    }
    // a session is building, rebuilding or fixing for it (claimed): the PR sits in Working, whatever the sessions' branches
    const request =
      work.repo && work.number
        ? requestFor(this.home, this.builds, {
            repo: work.repo,
            number: work.number,
            story: work.story?.id ?? null,
          })
        : null;
    const building = request?.state === 'building' ? request : null;
    if (pr && !isShown(pr, { story: !!story || work.built, building: !!building })) {
      // someone else's PR with nothing for you in it: not on the board, though a session of yours on its branch still is
      pr = null;
      story = null;
    }
    // a local story alone (no session, no PR) is a card only while there is something to review in it
    const localToReview =
      !!story &&
      story === work.local &&
      (!story.reviewed_at || unreadOf(story) || !!(story as InboxLocalStory).approved_at);
    const known =
      (!!pr && (pr.mine || pr.review_requested || !!story || work.built || !!building)) ||
      localToReview;
    if (!work.sessions.length && !known) {
      return null;
    }
    const sessions = work.sessions.map((view) => view.card);
    const repo = work.repo;
    const lane = repo ? repo.split('/')[1] : NO_PARENT;
    return {
      id: work.key,
      kind: 'work',
      title: pr?.title || story?.title || work.branch || work.key,
      repo,
      branch: work.branch ?? pr?.branch ?? null,
      lane,
      column: 'idle',
      detail: null,
      since: null,
      pr,
      ahead:
        pr?.state === 'open' && (work.branch ?? pr.branch) && work.repo
          ? this.aheadFor(work.repo, (work.branch ?? pr.branch) as string)
          : null,
      story: story
        ? {
            id: story.id,
            kind: 'number' in story ? ('pr' as const) : ('local' as const),
            url: 'number' in story ? story.url : null,
            reviewed: !!story.reviewed_at,
            // built after you last opened or reviewed it (never opened: it is ready for review, not back to you)
            unread: unreadOf(story),
            approved_at: 'number' in story ? null : story.approved_at,
            ship: 'number' in story ? null : (this.shipById.get(story.id) ?? null),
          }
        : null,
      building: building
        ? { kind: building.kind, since: building.claimed_at, by: building.claimed_by }
        : null,
      sessions,
      agents: [],
      parent: null,
      ...focusOf(sessions),
      listening: null,
      build: null,
    };
  }

  /** Sets a session or work card's column, detail and `since`, once its agents are on it. */
  private place(card: BoardCard, byStory: Map<string, StoryFacts>): void {
    const built = card.story ? byStory.get(card.story.id) : undefined;
    // an auto-mark carries the time the bridge noticed, so only a mark by hand counts as your activity
    const manual =
      built?.reviewed_at && built.reviewed_by === 'manual' ? Date.parse(built.reviewed_at) : null;
    card.column = columnOf({
      sessions: card.sessions,
      agents: card.agents,
      pr: card.pr,
      story: card.story
        ? {
            reviewed: card.story.reviewed,
            manualReviewedAt: manual,
            unread: card.story.unread,
            local: card.story.kind === 'local',
            approved: !!card.story.approved_at,
          }
        : null,
      building: !!card.building,
    });
    const asking = card.sessions.find((session) => session.status === 'waiting');
    const waitingAgent = card.agents.find((agent) => agent.state === 'waiting');
    const busy = card.sessions.find((session) => session.status === 'working');
    switch (card.column) {
      case 'waiting':
        card.detail = asking?.detail || null;
        card.since = earliest([
          ...card.sessions.filter((one) => one.status === 'waiting').map((one) => one.since),
          waitingAgent?.ended_at,
        ]);
        break;
      case 'checks': {
        const gated = card.agents.filter((agent) => agent.gate);
        card.detail = gated.map((agent) => gateText(agent)).join(', ');
        card.since = earliest(
          gated.map((agent) => (agent.gate?.kind === 'review' ? agent.started_at : agent.ended_at)),
        );
        break;
      }
      case 'working':
        card.detail = card.building ? BUILDING_TEXT[card.building.kind] : busy?.detail || null;
        card.since = earliest([
          card.building?.since,
          ...card.sessions.filter((one) => one.status === 'working').map((one) => one.since),
          ...card.agents.filter((one) => one.state === 'running').map((one) => one.started_at),
        ]);
        break;
      case 'done':
      case 'ship':
        card.since = card.pr?.merged_at ?? card.story?.approved_at ?? null;
        break;
      case 'back':
        card.since = card.pr?.others_at ?? null;
        break;
      case 'ready':
        card.since = built?.built_at ?? null;
        break;
      default:
        card.detail = card.sessions[0]?.detail || null;
        card.since = card.sessions[0]?.since ?? null;
    }
  }
}

/** What a gated agent says it is doing, in a few words. */
export function gateText(agent: Pick<BoardAgent, 'name' | 'gate'>): string {
  const gate = agent.gate;
  if (gate?.kind === 'plan') {
    return 'plan check';
  }
  if (gate?.kind === 'fixing') {
    return gate.findings === null
      ? 'fixing'
      : `fixing ${gate.findings} ${gate.findings === 1 ? 'finding' : 'findings'}`;
  }
  return `agent review: ${agent.name}`;
}

/** The blank sessions grouped by lane (a repo's name, else the folder's), the lanes by name and a lane's sessions by title. */
function blankStrip(views: { lane: string; view: BoardSession }[]): BoardData['blank'] {
  const groups = new Map<string, { name: string; sessions: BoardBlankSession[] }>();
  for (const { lane, view } of views) {
    const group = groups.get(lane.toLowerCase()) || { name: lane, sessions: [] };
    group.sessions.push({
      id: view.id,
      title: view.title,
      can_focus: view.focus,
      since: view.since,
    });
    groups.set(lane.toLowerCase(), group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((first, second) => first.title.localeCompare(second.title)),
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

/** What the card says while a session works on the PR's story. */
const BUILDING_TEXT = {
  build: 'building story',
  update: 'updating story',
  rebuild: 'rebuilding story',
  fix: 'fixing the code',
} as const;

/** The session a click on a card brings to the front: one waiting on you, else a busy one, else the first. */
function focusOf(sessions: BoardSession[]): { focus_session: string | null; can_focus: boolean } {
  const pick =
    sessions.find((session) => session.status === 'waiting') ||
    sessions.find((session) => session.status === 'working') ||
    sessions.find((session) => session.focus) ||
    sessions[0];
  return { focus_session: pick?.id ?? null, can_focus: pick?.focus ?? false };
}

const AGENT_COLUMN: Record<LedgerAgent['state'], BoardColumn> = {
  running: 'working',
  waiting: 'waiting',
  plan: 'checks',
  fixing: 'checks',
  done: 'idle',
  failed: 'error',
  stopped: 'idle',
};
