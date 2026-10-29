/**
 * The agent board's actions, and the cache in front of its data. What the data holds, where each source is read and how
 * a card is made is in stages/ (stages/index.ts has the stages and the sources). What a click on the board does to other
 * tools is in ADR-11: Board has the actions, which are the board's only writes.
 */
import path from 'node:path';
import { readSettings } from '../config/settings.ts';
import {
  REPO_RE,
  lastKnownRepo,
  repoOfCheckoutAsync,
  sameRepo,
  storyRepo,
} from '../config/repos.ts';
import { ID_RE as STORY_ID_RE, readMeta } from '../stories/meta.ts';
import { runGitAsync } from '../util/git.ts';
import { aheadOf } from '../stories/pull-request.ts';
import { readAgents } from './ledger.ts';
import { BlankSessions } from './blank.ts';
import { SessionTitles } from './titles.ts';
import { BacklogStore, assignBranch, assignLine, liveAssignment } from './backlog.ts';
import type { AddInput, BacklogItem, MoveTo } from './backlog.ts';
import { parseWorktrees } from './backlog-links.ts';
import { WorktreeScanner, workingIn } from './worktrees.ts';
import type { Runner } from './worktrees.ts';
import { cleanWorktree } from './worktree-clean.ts';
import type { CleanResult } from './worktree-clean.ts';
import type { Worktree } from './backlog-links.ts';
import {
  forgetProbes,
  phoneReady,
  readVoice,
  runVoiceCtl,
  setPaused,
  type PhoneCommand,
  waitBridgeDown,
} from './voice.ts';
import {
  listenCandidates,
  listenCandidatesIn,
  withinDir,
  listenPromptFor,
  listenStoryPromptFor,
} from './listening.ts';
import type { ListeningInput } from './listening.ts';
import { requestStop } from '../listeners/auto-stop.ts';
import {
  findIt2,
  focusTab,
  pickSource,
  typeLine,
  type LiveSession,
  type StatusSource,
} from './sources.ts';
import { BoardError } from './errors.ts';
import { DEFAULT_BRANCHES } from '../story-lists/stories.ts';
import type { Builds } from '../inbox/builds.ts';
import type { StoryStore } from '../stories/store.ts';
import type { BoardCard, BoardData, BoardStatus } from '@once-upon-a-diff/shared/types';
import { prOfFacts } from './stages/worktrees.ts';
import { buildBoard } from './stages/index.ts';
import { liveSessions } from './stages/live-sessions.ts';
import { noPrWatcher, type PrWatcher } from './stages/pr-watcher.ts';
import type { BuildContext, Lookups } from './stages/types.ts';

export { liveSessions, noPrWatcher };
export type { PrWatcher };

/** The board's answers are kept this long, so several open pages cost one round of reads. */
const CACHE_MS = 2000;
export { DEFAULT_BRANCHES };

const BRANCH_CACHE_MS = 10000;
/** How often a branch's commits-ahead count is looked at again (git ls-remote each time). */
const AHEAD_MS = 60000;
/** A snapshot waits this long for a session's repo to be looked up, then goes on without it (what was last known, or none). */
const REPO_WAIT_MS = 500;

/** The data behind /board/. The instance remembers when each session entered its status, since the registry's time is for its own. */
export class Board {
  private seen = new Map<string, { status: BoardStatus; since: number }>();
  private branches = new Map<string, { at: number; branch: string | null }>();
  /** whether a branch's commits are in its repo's main checkout (mergedLocally), kept a few seconds */
  private landed = new Map<string, { at: number; merged: boolean; mergedAt: number | null }>();
  /** a checkout's worktrees (git worktree list), kept a few seconds */
  private trees = new Map<string, { at: number; list: Worktree[] }>();
  private cache: { at: number; data: BoardData } | null = null;
  /** a voice_ctl phone call is running */
  private phoneBusy = false;
  /** What the last build knew of the sessions, for the panel's Start listening (listenSessions). */
  private listeningNow: { input: ListeningInput } | null = null;
  /** The build in flight, so callers arriving while it runs share it instead of starting another. */
  private building: Promise<BoardData> | null = null;
  /** commits ahead of origin per checkout and branch, looked up in the background (kickAhead) */
  private aheads = new Map<string, { at: number; count: number | null }>();
  /** Bumped when what a build read is out of date, so a build that started before it does not fill the cache. */
  private generation = 0;
  private blank = new BlankSessions();
  private titles = new SessionTitles();
  private backlog: BacklogStore;
  /** every git worktree, scanned in the background (worktrees.ts): a build reads what it has and never waits */
  private scanner: WorktreeScanner;

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
    /** runs the worktree scan's git and du (tests count calls or hold one up) */
    worktreeRun?: Runner;
  };

  /** what the build stages ask of this Board's caches */
  private lookups: Lookups = {
    branchOf: (cwd, now) => this.branchOf(cwd, now),
    repoOf: (cwd) => this.repoOf(cwd),
    worktreesOf: (cwd, now) => this.worktreesOf(cwd, now),
    mergedLocally: (trees, branch, now) => this.mergedLocally(trees, branch, now),
    aheadFor: (found, branch) => this.aheadFor(found, branch),
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
      worktreeRun?: Runner;
    } = {},
  ) {
    this.home = home;
    this.stories = stories;
    this.review = review;
    this.builds = builds;
    this.options = options;
    this.backlog = new BacklogStore(home);
    this.scanner = new WorktreeScanner({
      home,
      dirs: () => readSettings(home).checkoutDirs,
      onChange: () => this.invalidate(),
      run: options.worktreeRun,
    });
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
   * ls-remote) runs in the background, at most every AHEAD_MS, and a change drops the kept snapshot. Null when nothing is
   * ahead.
   */
  private aheadFor(found: { story: string; checkout: string }, branch: string): BoardCard['ahead'] {
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
    const ctx: BuildContext = {
      home: this.home,
      now,
      nowMs,
      settings: readSettings(this.home).board,
      stories: this.stories,
      review: this.review,
      builds: this.builds,
      lookups: this.lookups,
      sourceOverride: this.options.source,
    };
    const built = await buildBoard(ctx, {
      seen: this.seen,
      blank: this.blank,
      titles: this.titles,
      backlog: this.backlog,
      scanner: this.scanner,
    });
    this.seen = built.seen;
    this.listeningNow = { input: built.listening };
    return built.data;
  }

  /**
   * Pause or resume voice from the board: the `paused` file in Larmor's folder, made or removed the way its menu bar
   * does. Pausing needs voice to be on (start_voice clears the file anyway); resuming is always fine.
   */
  setVoicePaused(paused: boolean): void {
    const dir = readSettings(this.home).board.voiceDir;
    if (!dir) {
      throw new BoardError(400, 'board_voice_dir is not set, so there is no voice to pause');
    }
    if (
      paused &&
      !readVoice(dir, (this.options.now ? this.options.now() : new Date()).getTime())?.on
    ) {
      throw new BoardError(409, 'voice mode is not on, so there is nothing to pause');
    }
    setPaused(dir, paused);
    // the page refreshes right after the POST: it must see the file, not the kept snapshot
    this.invalidate();
  }

  /**
   * Turn phone mode on or off from the board, and stop the phone bridge, by asking Larmor's voice_ctl (it makes the checks
   * the menu bar makes, writes or removes the `away` file and starts or stops larmor_phone.py). Phone mode can turn on with voice off too. Larmor may refuse (not paired, firewall, another network): that is a 409 carrying its reason.
   */
  async setPhone(command: PhoneCommand): Promise<{ on: boolean; bridge: boolean }> {
    const board = readSettings(this.home).board;
    if (!board.voiceDir || !board.larmorDir) {
      throw new BoardError(
        400,
        'board_voice_dir and board_larmor_dir are needed for the phone buttons',
      );
    }
    if (!phoneReady(board.larmorDir)) {
      throw new BoardError(
        400,
        `${board.larmorDir} has no .venv-app/bin/python and app/voice_ctl.py to run`,
      );
    }
    // one call at a time: a second one while phone-on waits for the bridge would undo it
    if (this.phoneBusy) {
      throw new BoardError(409, 'Larmor is still working on the last phone request');
    }
    this.phoneBusy = true;
    try {
      const result = await runVoiceCtl(board.larmorDir, command);
      forgetProbes();
      if (!result.ok) {
        throw new BoardError(409, result.why || `Larmor would not do ${command}`);
      }
      // Larmor signals the bridge to stop and returns without waiting: report the bridge as it is a moment later
      const bridge =
        command === 'bridge-stop' ? await waitBridgeDown(board.voiceDir) : result.bridge;
      return { on: result.away, bridge };
    } finally {
      this.phoneBusy = false;
      forgetProbes();
      this.invalidate();
    }
  }

  /**
   * Clean up a worktree on the page's click (worktree-clean.ts has the checks). Who works in it is looked at now, from the
   * registry and the ledger, not from the last snapshot.
   */
  async cleanWorktree(dir: string, ack: string[], seen: string[] = []): Promise<CleanResult> {
    const settings = readSettings(this.home).board;
    if (!settings.worktrees) {
      throw new BoardError(404, 'the board does not show worktrees');
    }
    const result = await cleanWorktree({
      scanner: this.scanner,
      dir,
      ack,
      seen,
      home: this.home,
      keepBranches: settings.keepBranches,
      now: () => (this.options.now || (() => new Date()))().getTime(),
      contextOf: async (facts) => {
        const sessions = (await liveSessions(settings.sessionsDir)).map((session) => ({
          title: session.name ?? path.basename(session.cwd),
          cwd: session.cwd,
        }));
        const { agents } = readAgents(
          { ledger: settings.ledgerFile, progress: null },
          new Date(),
          settings.ledgerTimeZone,
        );
        return {
          inUse: workingIn(facts.path, sessions, agents),
          pr: prOfFacts(this.review, facts),
        };
      },
    });
    this.invalidate();
    return result;
  }

  /**
   * Brings a live session's iTerm tab to the front. The id is looked up among the registry's live sessions and its tab
   * found from its tty here, so nothing the page sent is run or passed on but the session id it names.
   */
  async focus(sessionId: string): Promise<void> {
    const settings = readSettings(this.home).board;
    const it2 = settings.statusSource === 'registry' ? null : findIt2(settings.it2Path);
    if (!it2) {
      throw new BoardError(409, 'iTerm2 (the it2 CLI) is not set up, so there is no tab to raise');
    }
    const session = (await liveSessions(settings.sessionsDir)).find(
      (live) => live.session === sessionId,
    );
    if (!session) {
      throw new BoardError(404, 'no live Claude Code session with that id');
    }
    const failed = await focusTab(it2, session.tty);
    if (failed) {
      throw new BoardError(409, failed);
    }
  }

  /** The it2 CLI and the live session to type into, or the BoardError saying why not: no it2, no such session, busy, or waiting on you. */
  private async typeable(sessionId: string): Promise<{ it2: string; session: LiveSession }> {
    const settings = readSettings(this.home).board;
    const it2 = settings.statusSource === 'registry' ? null : findIt2(settings.it2Path);
    if (!it2) {
      throw new BoardError(
        409,
        'iTerm2 (the it2 CLI) is not set up, so there is no tab to type into',
      );
    }
    const session = (await liveSessions(settings.sessionsDir)).find(
      (live) => live.session === sessionId,
    );
    if (!session) {
      throw new BoardError(404, 'no live Claude Code session with that id');
    }
    const tab = (
      await pickSource(settings.statusSource, settings.it2Path).source.statuses([session])
    ).get(sessionId);
    const status = tab?.status ?? (session.status === 'busy' ? 'working' : 'idle');
    if (session.status === 'busy' || status === 'working') {
      throw new BoardError(409, 'session busy');
    }
    if (status === 'waiting') {
      throw new BoardError(409, 'the session is waiting for you');
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
      throw new BoardError(404, 'no backlog item with that id');
    }
    if (item.state === 'started') {
      throw new BoardError(409, 'that item is already started');
    }
    const held = liveAssignment(item, Date.now());
    if (held && held.session !== sessionId) {
      throw new BoardError(409, 'that item was assigned to another session a little while ago');
    }
    const { it2, session } = await this.typeable(sessionId);
    const card = (await this.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((one) => one.backlog?.id === id);
    if (!card?.backlog?.assign?.candidates.some((one) => one.id === sessionId)) {
      throw new BoardError(409, 'that session cannot take this item (its repo, or it is not free)');
    }
    const prompt = assignLine(item);
    const failed = await (this.options.typeLine || typeLine)(it2, session.tty, prompt);
    if (failed) {
      throw new BoardError(409, failed);
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
      throw new BoardError(404, 'no story with that id');
    }
    return storyRepo(readMeta(dir));
  }

  /**
   * The sessions the panel's Start listening may type into for a repo: the board's Start listening rule (idle, in the repo,
   * an iTerm tab known, not the voice session or one that already listens). From the board's last snapshot, so a click costs no more than a page
   * poll; `type` checks the chosen session again against live status before it types.
   */
  async listenSessions(repo: string): Promise<ReturnType<typeof listenCandidates>> {
    if (!REPO_RE.test(repo)) {
      throw new BoardError(400, 'a repo (owner/name) is needed');
    }
    this.needIterm();
    await this.snapshot();
    const known = this.listeningNow;
    return known ? listenCandidates(repo, known.input) : [];
  }

  /**
   * The sessions Start listening may type into for a story: the story's repo's (listenSessions), or, for a local story whose
   * checkout has no origin, the sessions in that checkout. A story that has neither is a 400.
   */
  async storyListenSessions(
    storyId: string,
  ): Promise<{ repo: string | null; sessions: ReturnType<typeof listenCandidates> }> {
    const repo = this.storyRepoOf(storyId);
    if (repo) {
      return { repo, sessions: await this.listenSessions(repo) };
    }
    const dir = this.storyCheckoutOf(storyId);
    if (!dir) {
      throw new BoardError(
        400,
        'this story has no repo or checkout, so no session can be found for it',
      );
    }
    this.needIterm();
    await this.snapshot();
    return {
      repo: null,
      sessions: this.listeningNow ? listenCandidatesIn(dir, this.listeningNow.input) : [],
    };
  }

  /** A local story's checkout folder, when it names one (a PR story has none here). A 404 for a story that does not exist. */
  private storyCheckoutOf(storyId: string): string | null {
    const dir = this.stories.dirOf(storyId);
    if (!dir) {
      throw new BoardError(404, 'no story with that id');
    }
    const meta = readMeta(dir);
    return meta.kind === 'local' && meta.repo_path ? meta.repo_path : null;
  }

  /** Start listening types into iTerm tabs, so without the it2 CLI there is nothing to offer, and the page says so. */
  private needIterm(): void {
    const settings = readSettings(this.home).board;
    if (settings.statusSource === 'registry' || !findIt2(settings.it2Path)) {
      throw new BoardError(
        409,
        'Start listening needs iTerm (its it2 CLI), which is not set up on this Mac, so run the line in Claude Code yourself',
      );
    }
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
    if (kind === 'listen') {
      // the same rule as the offer, against a fresh look: a chooser can be stale, and a direct call can name anyone
      await this.snapshot();
      if (this.listeningNow?.input.apart.has(sessionId)) {
        throw new BoardError(409, 'that session is the voice session or already listens');
      }
    }
    let prompt: string | null = null;
    if (kind === 'listen' && story) {
      if (!STORY_ID_RE.test(story)) {
        throw new BoardError(400, 'a story id is needed');
      }
      // the story's own repo, else its checkout folder: the session has to be there
      const owner = this.storyRepoOf(story);
      if (owner) {
        if (!sameRepo(await repoOfCheckoutAsync(session.cwd), owner)) {
          throw new BoardError(409, `that session is not in a checkout of ${owner}`);
        }
      } else {
        const dir = this.storyCheckoutOf(story);
        if (!dir) {
          throw new BoardError(409, 'this story has no repo or checkout to find a session by');
        }
        if (!withinDir(session.cwd, dir)) {
          throw new BoardError(409, `that session is not in ${dir}`);
        }
      }
      prompt = listenStoryPromptFor(story);
    } else if (kind === 'listen') {
      if (!repo || !REPO_RE.test(repo)) {
        throw new BoardError(400, 'a repo (owner/name) is needed');
      }
      if (!sameRepo(await repoOfCheckoutAsync(session.cwd), repo)) {
        throw new BoardError(409, `that session is not in a checkout of ${repo}`);
      }
      prompt = listenPromptFor(repo);
    } else {
      const cards = (await this.snapshot()).lanes.flatMap((lane) => lane.cards);
      prompt = cards.find((card) => card.build?.session === sessionId)?.build?.prompt ?? null;
      if (!prompt) {
        throw new BoardError(409, 'there is nothing to build for that session');
      }
    }
    const failed = await (this.options.typeLine || typeLine)(it2, session.tty, prompt);
    if (failed) {
      throw new BoardError(409, failed);
    }
    this.invalidate();
    return prompt;
  }

  /** The board's Stop listening: every `wait --repo` for the repo ends on its next look, within a couple of seconds. */
  stopListening(repo: string): void {
    if (!REPO_RE.test(repo)) {
      throw new BoardError(400, 'a repo (owner/name) is needed');
    }
    requestStop(this.home, repo);
    this.invalidate();
  }
}
