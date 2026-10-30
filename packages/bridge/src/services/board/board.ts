/**
 * The agent board's actions, and the cache in front of its data. What the data holds, where each source is read and how
 * a card is made is in stages/ (stages/index.ts has the stages and the sources). What a click on the board does to other
 * tools is in ADR-11: Board has the actions, which are the board's only writes.
 */
import path from 'node:path';
import { readSettings } from '../config/settings.ts';
import { REPO_RE, lastKnownRepo, repoOfCheckoutAsync } from '../config/repos.ts';
import { runGitAsync } from '../../adapters/git.ts';
import { aheadOf } from '../stories/pull-request.ts';
import { readAgents } from '../ledger/ledger.ts';
import { BlankSessions } from '../../adapters/claude-sessions/blank.ts';
import { SessionTitles } from '../../adapters/claude-sessions/titles.ts';
import { BacklogStore, assignBranch, assignLine, liveAssignment } from '../backlog/backlog.ts';
import type { AddInput, BacklogItem, MoveTo } from '../backlog/backlog.ts';
import { parseWorktrees } from '../backlog/backlog-links.ts';
import { WorktreeScanner, workingIn } from '../worktrees/worktrees.ts';
import type { Runner } from '../../adapters/os.ts';
import { cleanWorktree } from '../worktrees/worktree-clean.ts';
import type { CleanResult } from '../worktrees/worktree-clean.ts';
import type { Worktree } from '../backlog/backlog-links.ts';
import {
  forgetProbes,
  phoneReady,
  readVoice,
  runVoiceCtl,
  setPaused,
  type PhoneCommand,
  VoiceCtlError,
  waitBridgeDown,
} from '../../adapters/larmor.ts';
import type { ListeningInput } from '../sessions/listening.ts';
import { requestStop } from '../listeners/auto-stop.ts';
import { typeLine, type StatusSource } from '../../adapters/iterm.ts';
import { BoardError } from '../errors.ts';
import type { Builds } from '../inbox/builds.ts';
import type { StoryStore } from '../stories/store.ts';
import type { BoardCard, BoardData, BoardStatus } from '@once-upon-a-diff/shared/types';
import { prOfFacts } from './stages/worktrees.ts';
import { buildBoard } from './stages/index.ts';
import { liveSessions } from '../../adapters/claude-sessions/registry.ts';
import { noPrWatcher, type PrWatcher } from './stages/pr-watcher.ts';
import type { BuildContext, Lookups } from './stages/types.ts';
import { Sessions } from '../sessions/sessions.ts';

export { liveSessions, noPrWatcher };
export type { PrWatcher };

/** The board's answers are kept this long, so several open pages cost one round of reads. */
const CACHE_MS = 2000;

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
  /** The sessions a click may type into: Build story, Start listening and Assign (sessions.ts). */
  readonly sessions: Sessions;
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
    this.sessions = new Sessions(
      home,
      stories,
      {
        snapshot: () => this.snapshot(),
        listening: () => this.listeningNow?.input ?? null,
        invalidate: () => this.invalidate(),
      },
      { typeLine: options.typeLine },
    );
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
      const result = await runVoiceCtl(board.larmorDir, command).catch((err: unknown) => {
        throw err instanceof VoiceCtlError ? new BoardError(502, err.message) : err;
      });
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

  /*
   * Build story, Start listening and focus live in Sessions (`board.sessions`, which the bridge's routes call). These
   * stay for callers that hold a Board.
   */
  focus(sessionId: string): Promise<void> {
    return this.sessions.focus(sessionId);
  }

  storyRepoOf(storyId: string): string | null {
    return this.sessions.storyRepoOf(storyId);
  }

  listenSessions(repo: string): ReturnType<Sessions['listenSessions']> {
    return this.sessions.listenSessions(repo);
  }

  storyListenSessions(storyId: string): ReturnType<Sessions['storyListenSessions']> {
    return this.sessions.storyListenSessions(storyId);
  }

  type(
    kind: 'build' | 'listen',
    sessionId: string,
    repo: string | null,
    story: string | null = null,
  ): Promise<string> {
    return this.sessions.type(kind, sessionId, repo, story);
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
    const { it2, session } = await this.sessions.typeable(sessionId);
    const card = (await this.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((one) => one.backlog?.id === id);
    if (!card?.backlog?.assign?.candidates.some((one) => one.id === sessionId)) {
      throw new BoardError(409, 'that session cannot take this item (its repo, or it is not free)');
    }
    const prompt = assignLine(item);
    const failed = await this.sessions.send(it2, session, prompt);
    if (failed) {
      throw new BoardError(409, failed);
    }
    this.backlog.assign(id, { session: sessionId, branch: assignBranch(item), by: who });
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
