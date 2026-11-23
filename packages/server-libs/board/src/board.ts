/**
 * The agent board's actions, and the cache in front of its data. What the data holds, where each source is read and how
 * a card is made is in stages/ (stages/index.ts has the stages and the sources). What a click on the board does to other
 * tools is in ADR-11: Board has the actions, which are the board's writes, and landing a card whose PR merged (landMerged).
 */
import { agentId } from '@once-upon-a-diff/terms/ids';
import path from 'node:path';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import {
  REPO_RE,
  canonicalCasing,
  lastKnownRepo,
  repoOfCheckoutAsync,
  typedRepoNote,
} from '@once-upon-a-diff/foundation/repos';
import {
  branchMovedPastAsync,
  commitOfAsync,
  isAncestorAsync,
  runGitAsync,
} from '@once-upon-a-diff/adapters/git';
import { aheadOf } from '@once-upon-a-diff/stories/pull-request';
import { lastActivity } from '@once-upon-a-diff/state/records/agents/ledger';
import { dropRunsProblem } from '@once-upon-a-diff/state/queues/backlog/phase';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { finishRun } from '@once-upon-a-diff/core/features/runs/service';
import { markFinished } from '@once-upon-a-diff/adapters/stores/finished-agents';
import { BlankSessions } from '@once-upon-a-diff/adapters/claude-sessions/blank-sessions';
import { SessionTitles } from '@once-upon-a-diff/adapters/claude-sessions/titles';
import { SubagentLiveness } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import { BacklogStore, isListed } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { AddInput, EditInput, MoveTo } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import { MergeLander } from '@once-upon-a-diff/state/queues/backlog/land-merged';
import type { MergedCheck } from '@once-upon-a-diff/state/records/github/merged-pr';
import { parseWorktrees } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import { WorktreeScanner, workingIn } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { Runner } from '@once-upon-a-diff/adapters/os';
import { cleanWorktree } from '@once-upon-a-diff/state/records/worktrees/worktree-clean';
import type { CleanResult } from '@once-upon-a-diff/state/records/worktrees/worktree-clean';
import type { Worktree } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import {
  forgetProbes,
  phoneReady,
  rememberVoiceState,
  runVoiceCtl,
  type CtlResult,
  type PhoneCommand,
  type VoiceCommand,
  VoiceCtlError,
} from '@once-upon-a-diff/adapters/larmor';
import type { ListeningInput } from '@once-upon-a-diff/core/features/sessions/listening';
import { Listening } from '@once-upon-a-diff/core/features/listeners/service';
import { typeLine } from '@once-upon-a-diff/adapters/iterm';
import type { StatusSource } from '@once-upon-a-diff/adapters/status-source';
import { BoardError } from '@once-upon-a-diff/foundation/errors';
import type { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import type { StoryStore } from '@once-upon-a-diff/stories/store';
import type { BoardCard, BoardData } from '@once-upon-a-diff/contracts/types';
import type { LearnedCards } from '@once-upon-a-diff/core/features/cards/learned';
import { isFinished } from './stages/agents.ts';
import { prOfFacts } from './stages/worktrees.ts';
import { buildBoard } from './stages/index.ts';
import { endDeadRuns } from './stages/dead-runs.ts';
import type { SeenSession } from './stages/sessions.ts';
import { liveSessions } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { noPrWatcher, type PrWatcher } from './stages/pr-watcher.ts';
import type { BuildContext, Lookups } from './stages/types.ts';
import { onBackgroundChange } from '@once-upon-a-diff/adapters/change-signal';
import type { StageTimes } from './stages/clock.ts';
import { takeLoopDelay } from './loop-delay.ts';
import { Sessions } from '@once-upon-a-diff/core/features/sessions/sessions';

/**
 * Why Finish was refused, for the alert the page shows (it has no CLI beside it). A waiting critic of a card has no
 * findings count to record, and the board will not invent one: a null count reads as a pass.
 */
function finishRefusal(agent: { name: string }, err: Error): string {
  return /findings count/.test(err.message)
    ? `${agent.name} is a critic on a card and has no findings count, so finishing it would read as a pass: run \`once-upon agent finish ${agent.name} --findings N\` (N is 0 if it found none)`
    : err.message;
}

export { liveSessions, noPrWatcher };
export type { PrWatcher };

/** The board's answers are kept this long, so several open pages cost one round of reads. */
const CACHE_MS = 2000;
/** A build over this long logs one line: its total, the stages that took 50 ms or more, and the longest the event loop stood still. */
const SLOW_BUILD_MS = 500;

const BRANCH_CACHE_MS = 10000;
/** How often a story's ref is looked at again (git rev-parse): the board is a poll or two behind a moved branch, the story page is not. */
const TIP_MS = 5000;
/** how many tip looks run at once: a first build asks the rest on later polls */
const TIPS_AT_ONCE = 6;
/** How often a branch's commits-ahead count is looked at again (git ls-remote each time). */
const AHEAD_MS = 60000;
/** how many moved-past looks run at once: a first build over many Ready cards asks the rest on later polls */
const MOVED_AT_ONCE = 4;
/** A snapshot waits this long for a session's repo to be looked up, then goes on without it (what was last known, or none). */
const REPO_WAIT_MS = 500;

/** The data behind /board/. The instance remembers when each session entered its status, since the registry's time is for its own. */
export class Board {
  private seen = new Map<string, SeenSession>();
  private branches = new Map<string, { at: number; branch: string | null }>();
  /** whether a branch's commits are in its repo's main checkout (mergedLocally), kept a few seconds */
  private landed = new Map<string, { at: number; merged: boolean; mergedAt: number | null }>();
  /** a checkout's worktrees (git worktree list), kept a few seconds */
  private trees = new Map<string, { at: number; list: Worktree[] }>();
  private cache: { at: number; data: BoardData } | null = null;
  /** the background looks on kept answers gone stale (refreshKept), by what they look at */
  private refreshing = new Set<string>();
  /** a voice_ctl call (phone, start or stop) is running */
  private phoneBusy = false;
  /** a voice_ctl pause or resume is running */
  private pauseBusy = false;
  /** What the last build knew of the sessions, for the panel's Start listening (listenSessions). */
  private listeningNow: { input: ListeningInput } | null = null;
  /** The build in flight, so callers arriving while it runs share it instead of starting another. */
  private building: Promise<BoardData> | null = null;
  /** commits ahead of origin per checkout and branch, looked up in the background (kickAhead) */
  private aheads = new Map<string, { at: number; count: number | null }>();
  /** whether a tip moved past a commit, by the pair of shas (immutable, so an answer is never stale); a null (the look failed or timed out) is asked again after BRANCH_CACHE_MS */
  private moves = new Map<string, { at: number; moved: boolean | null; asking: boolean }>();
  /** where each story's ref was last seen, looked up in the background (tipOf) */
  private tips = new Map<string, { at: number; tip: string | null; asking: boolean }>();
  /** a tip changed since the snapshot was last dropped */
  private tipsMoved = false;
  /** Bumped when what a build read is out of date, so a build that started before it does not fill the cache. */
  private generation = 0;
  private blank = new BlankSessions();
  private titles = new SessionTitles();
  private liveness = new SubagentLiveness();
  /** the session each listener's wait ran in, for its handling beat (adoptHandlers) */
  private listenerSessions = new Map<string, string>();
  private backlog: BacklogStore;
  /** marks a started card done when the PR for its branch merged (kicked by a build, never waited for) */
  private lander: MergeLander;
  /** The sessions a click may type into: Build story, Start listening and Assign (sessions.ts). */
  readonly sessions: Sessions;
  /** every git worktree, scanned in the background (worktrees.ts): a build reads what it has and never waits */
  private scanner: WorktreeScanner;

  private stopBackground: () => void;
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
    /** how a branch is found to have moved past a commit (tests answer without git) */
    movedPast?: typeof branchMovedPastAsync;
    /** how a ref's commit is found (tests answer without git) */
    tipOf?: (repo: string, ref: string) => Promise<{ tip: string | null; killed: boolean }>;
    /** runs the worktree scan's git and du (tests count calls or hold one up) */
    worktreeRun?: Runner;
    /** runs `git worktree list` (tests answer with a timeout or a failure without git) */
    worktreeListRun?: typeof runGitAsync;
    /** how long `git worktree list` may run before the last good list is kept (default 3000; a test on a loaded machine gives it longer) */
    worktreeListMs?: number;
    /** how a started card's merged PR is found; with none, nothing is asked and nothing lands (createBridge passes the real one) */
    checkMerged?: MergedCheck;
    /** what a build learned about the work it saw, handed on after the build (the card keeper: ADR-29); with none, nothing is worked out */
    keeper?: { apply(learned: LearnedCards): void };
    /** where a slow build's line goes (the bridge log); with none, nothing is logged */
    log?: (line: string) => void;
  };

  /** whether `repoOf` last answered for a folder in time, as against the last known repo */
  private repoAnswers = new Map<string, boolean>();

  /** what the build stages ask of this Board's caches */
  private lookups: Lookups = {
    branchOf: (cwd, now) => this.branchOf(cwd, now),
    repoOf: (cwd) => this.repoOf(cwd),
    repoAnswered: (cwd) => this.repoAnswers.get(cwd) ?? false,
    worktreesOf: (cwd, now) => this.worktreesOf(cwd, now),
    mergedLocally: (trees, branch, now) => this.mergedLocally(trees, branch, now),
    aheadFor: (found, branch) => this.aheadFor(found, branch),
    tipOf: (repo, ref) => this.tipOf(repo, ref),
    movedPast: (checkout, told, tip, defaultBranch) =>
      this.movedPast(checkout, told, tip, defaultBranch),
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
      movedPast?: typeof branchMovedPastAsync;
      tipOf?: (repo: string, ref: string) => Promise<{ tip: string | null; killed: boolean }>;
      worktreeRun?: Runner;
      worktreeListMs?: number;
      worktreeListRun?: typeof runGitAsync;
      checkMerged?: MergedCheck;
      keeper?: { apply(learned: LearnedCards): void };
      log?: (line: string) => void;
    } = {},
  ) {
    this.home = home;
    this.stories = stories;
    // a background look in an adapter (iTerm's tabs, Larmor's lines) that found a change: the next poll must show it
    this.stopBackground = onBackgroundChange(() => this.invalidate());
    this.review = review;
    this.builds = builds;
    this.options = options;
    this.backlog = new BacklogStore(home);
    this.lander = new MergeLander(
      this.backlog,
      options.checkMerged ?? (async () => null),
      () => (this.options.now || (() => new Date()))().getTime(),
      undefined,
      () => readAgents(this.home).agents,
    );
    this.sessions = new Sessions(
      home,
      stories,
      {
        snapshot: () => this.snapshot(),
        listening: () => this.listeningNow?.input ?? null,
        invalidate: () => this.invalidate(),
      },
      { typeLine: options.typeLine, source: options.source },
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
    const item = this.backlog.add({ ...input, repo: this.cardRepoOf(input.repo) });
    this.invalidate();
    return item;
  }

  /** A typed repo in the casing the other cards use (a form's `everfi/x` is stored as `EverFi/x`), as the CLI does. */
  private cardRepoOf<T extends string | null | undefined>(repo: T): T | string | null {
    return repo
      ? canonicalCasing(repo, { cardRepos: this.backlog.listed().map((item) => item.repo) })
      : repo;
  }

  /** Moves a backlog item (a card dragged, or its up and down buttons). */
  moveBacklog(id: string, where: MoveTo, who: string): BacklogItem {
    const item = this.backlog.move(id, where, who);
    this.invalidate();
    return item;
  }

  /** Edits an open backlog item's title, note or repo (a card's Edit). */
  editBacklog(id: string, input: EditInput, who: string): BacklogItem {
    const item = this.backlog.edit(id, { ...input, repo: this.cardRepoOf(input.repo) }, who);
    this.invalidate();
    return item;
  }

  /** Why a repo typed in a card's Edit looks wrong, or null. It only warns: the edit is saved either way (ADR-25's flip refuses). */
  typedRepoNote(repo: string): string | null {
    return typedRepoNote(this.home, repo, {
      cardRepos: this.backlog.listed().map((item) => item.repo),
    });
  }

  /** Puts an open backlog item in the Someday section, or back (a card's Someday button). The registry says whether its run is open. */
  somedayBacklog(id: string, aside: boolean, who: string): BacklogItem {
    const { agents } = readAgents(this.home);
    const item = this.backlog.someday(id, aside, who, agents);
    this.invalidate();
    return item;
  }

  /** Drops a backlog item (a card's Drop). A card with an open run is refused: it would be left on no card (`backlog drop --into`). */
  dropBacklog(id: string, who: string): BacklogItem {
    const problem = dropRunsProblem({ id }, readAgents(this.home).agents);
    if (problem) {
      throw new Error(problem);
    }
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
      this.landMerged();
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

  /**
   * Lands the cards whose PR merged (land-merged.ts), in the background: a build never waits for it, and an error
   * in it (or a slow gh) never reaches the board. A landing drops the kept snapshot so the next poll shows the card in Done.
   */
  private landMerged(): void {
    this.lander
      .kick()
      .then((landed) => {
        if (landed) {
          this.invalidate();
        }
      })
      .catch(() => undefined);
  }

  /** Drops the kept answer so the next snapshot is built again (a change made outside the board, after which the page must not see the old one). */
  refresh(): void {
    this.invalidate();
  }

  /**
   * Drops the kept answer and answers with a snapshot built after this call. A build already running started before whatever
   * changed (so its asks to GitHub predate it): it is waited out, and not used.
   */
  async rebuild(): Promise<BoardData> {
    this.invalidate();
    await this.building?.catch(() => undefined);
    return this.snapshot();
  }

  /** Stops listening for background changes (the bridge closing): a closed board's cache is no longer dropped. */
  close(): void {
    this.stopBackground();
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
    this.repoAnswers.set(cwd, first !== late);
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

  /**
   * Whether a tip has moved past the commit a story or an author's work was reviewed at (Lookups.movedPast). The look runs in
   * the background (a few at a time, the rest on a later poll), so the board build never waits on git; an answer of true drops
   * the kept snapshot.
   */
  private movedPast(
    checkout: string,
    told: string,
    tip: string,
    defaultBranch: string | null,
  ): boolean | null {
    const key = `${told}\0${tip}`;
    const kept = this.moves.get(key);
    const now = Date.now();
    if (kept && (kept.asking || kept.moved !== null || now - kept.at < BRANCH_CACHE_MS)) {
      return kept.moved;
    }
    if ([...this.moves.values()].filter((one) => one.asking).length >= MOVED_AT_ONCE) {
      return kept?.moved ?? null;
    }
    this.moves.set(key, { at: now, moved: null, asking: true });
    // the local default branch first: origin's may lag it (never pushed, not fetched), and a patch measured from there would
    // span unrelated commits of the default branch and read a pure rebase as moved
    const bases = defaultBranch ? [defaultBranch, `origin/${defaultBranch}`] : [];
    (this.options.movedPast || branchMovedPastAsync)(checkout, told, tip, bases)
      .then((moved) => {
        this.moves.set(key, { at: Date.now(), moved, asking: false });
        if (moved) {
          this.invalidate();
        }
      })
      .catch(() => this.moves.set(key, { at: Date.now(), moved: null, asking: false }));
    return null;
  }

  /**
   * Where a story's ref is, as the last background look saw it (Lookups.tipOf). The build never waits on git: the look
   * (git rev-parse) runs a few at a time, at most every TIP_MS for a checkout and ref, and a tip that moved drops the kept
   * snapshot once the lookups in flight are in, so an approval the branch has left lapses on the next poll.
   */
  private tipOf(repo: string, ref: string): string | null {
    const key = `${repo}\0${ref}`;
    const kept = this.tips.get(key);
    const now = Date.now();
    const due = !kept || (!kept.asking && now - kept.at >= TIP_MS);
    if (due && [...this.tips.values()].filter((one) => one.asking).length < TIPS_AT_ONCE) {
      this.tips.set(key, { at: now, tip: kept?.tip ?? null, asking: true });
      this.askTip(key, repo, ref);
    }
    return kept?.tip ?? null;
  }

  private askTip(key: string, repo: string, ref: string): void {
    const ask = this.options.tipOf || commitOfAsync;
    void ask(repo, ref).then((answer) => {
      const last = this.tips.get(key);
      // a look git was killed in (under load) keeps the last answer; a ref git can't resolve is null, as on the page (the approval stands)
      const tip = answer.killed ? (last?.tip ?? null) : answer.tip;
      this.tips.set(key, { at: Date.now(), tip, asking: false });
      if (tip !== (last?.tip ?? null)) {
        this.tipsMoved = true;
      }
      if (this.tipsMoved && ![...this.tips.values()].some((one) => one.asking)) {
        this.tipsMoved = false;
        this.invalidate();
      }
    });
  }

  /** A checkout's current branch (null when detached or not a repo), kept a few seconds. */
  private async branchOf(cwd: string, now: number): Promise<string | null> {
    const kept = this.branches.get(cwd);
    if (kept && now - kept.at < BRANCH_CACHE_MS) {
      return kept.branch;
    }
    if (kept) {
      // stale: answer with it and look again in the background, so one build in a few never waits on git
      this.refreshKept(`branch\0${cwd}`, async () => {
        const branch = await this.lookBranch(cwd, kept);
        this.branches.set(cwd, { at: now, branch });
        return branch !== kept.branch;
      });
      return kept.branch;
    }
    const branch = await this.lookBranch(cwd, kept);
    this.branches.set(cwd, { at: now, branch });
    return branch;
  }

  /**
   * Runs `look` in the background for a kept answer gone stale, one per key at a time, and drops the kept snapshot when
   * it says the answer changed (true).
   */
  private refreshKept(key: string, look: () => Promise<boolean>): void {
    if (this.refreshing.has(key)) {
      return;
    }
    this.refreshing.add(key);
    look()
      .then((changed) => {
        if (changed) {
          this.invalidate();
        }
      })
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(key));
  }

  private async lookBranch(
    cwd: string,
    kept: { branch: string | null } | undefined,
  ): Promise<string | null> {
    // symbolic-ref also answers on a branch with no commits yet, and fails when HEAD is detached
    const out = await runGitAsync(cwd, ['symbolic-ref', '--short', 'HEAD'], { timeout: 3000 });
    // a lookup that timed out under load keeps the last good branch; any other failure (detached, not a repo) is no branch
    let branch: string | null = null;
    if (out.code === 0 && out.stdout.trim()) {
      branch = out.stdout.trim();
    } else if (out.killed) {
      branch = kept?.branch ?? null;
    }
    return branch;
  }

  /** The worktrees of a checkout's repo (every checkout of it, this one included), kept a few seconds; none when it isn't a repo; the last good list when the call times out. */
  private async worktreesOf(cwd: string, now: number): Promise<Worktree[]> {
    const kept = this.trees.get(cwd);
    if (kept && now - kept.at < BRANCH_CACHE_MS) {
      return kept.list;
    }
    if (kept) {
      this.refreshKept(`trees\0${cwd}`, async () => {
        const list = await this.lookWorktrees(cwd, kept.list);
        this.trees.set(cwd, { at: now, list });
        return JSON.stringify(list) !== JSON.stringify(kept.list);
      });
      return kept.list;
    }
    const list = await this.lookWorktrees(cwd, undefined);
    this.trees.set(cwd, { at: now, list });
    return list;
  }

  private async lookWorktrees(cwd: string, kept: Worktree[] | undefined): Promise<Worktree[]> {
    const out = await (this.options.worktreeListRun || runGitAsync)(
      cwd,
      ['worktree', 'list', '--porcelain'],
      { timeout: this.options.worktreeListMs ?? 3000 },
    );
    // a list that timed out under load keeps the last good one, so a card does not lose its worktree for a few seconds;
    // any other failure (git's 128 for a deleted folder or a non-repo) is no list
    let list: Worktree[] = [];
    if (out.code === 0) {
      list = parseWorktrees(out.stdout);
    } else if (out.killed) {
      list = kept ?? [];
    }
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
    if (kept) {
      this.refreshKept(`landed\0${key}`, async () => {
        const looked = await this.lookMerged(main, branch);
        this.landed.set(key, { at: now, ...looked });
        return looked.merged !== kept.merged || looked.mergedAt !== kept.mergedAt;
      });
      return kept.merged ? { at: kept.mergedAt } : null;
    }
    const looked = await this.lookMerged(main, branch);
    this.landed.set(key, { at: now, ...looked });
    return looked.merged ? { at: looked.mergedAt } : null;
  }

  private async lookMerged(
    main: Worktree,
    branch: string,
  ): Promise<{ merged: boolean; mergedAt: number | null }> {
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
        if (await isAncestorAsync(main.path, `refs/heads/${branch}`, line, 3000)) {
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
    return { merged, mergedAt };
  }

  private async build(now: Date): Promise<BoardData> {
    const nowMs = now.getTime();
    const started = performance.now();
    const settings = readSettings(this.home);
    const ctx: BuildContext = {
      home: this.home,
      now,
      nowMs,
      settings: settings.board,
      repos: settings.repos,
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
      liveness: this.liveness,
      listenerSessions: this.listenerSessions,
      backlog: this.backlog,
      scanner: this.scanner,
      learn: !!this.options.keeper,
    });
    this.seen = built.seen;
    this.logIfSlow(performance.now() - started, built.times);
    this.listeningNow = { input: built.listening };
    // what the build learned goes to the keeper, which writes stored cards and never throws: nothing it does reaches the board
    try {
      this.options.keeper?.apply(built.learned);
    } catch {
      /* the keeper logs its own failures */
    }
    return built.data;
  }

  /** One line when a build passed SLOW_BUILD_MS: where the time went, and whether the event loop was held (other requests waiting). */
  private logIfSlow(took: number, times: StageTimes): void {
    const loop = takeLoopDelay();
    if (took < SLOW_BUILD_MS || !this.options.log) {
      return;
    }
    const stages = times
      .filter(([, spent]) => spent >= 50)
      .map(([stage, spent]) => `${stage} ${spent}`)
      .join(', ');
    this.options.log(
      `board build ${Math.round(took)} ms (${stages || 'no stage over 50 ms'}); event loop max ${loop.max} ms, p99 ${loop.p99} ms since the last build`,
    );
  }

  /**
   * Pause or resume voice from the board, through Larmor's voice_ctl (the menu bar's Pause and Resume). Larmor refuses to
   * pause when voice is not on (a 409 with its reason); resuming is always fine.
   */
  async setVoicePaused(paused: boolean): Promise<void> {
    await this.askLarmor(paused ? 'pause' : 'resume');
  }

  /**
   * Turn phone mode on or off from the board, and stop the phone bridge, by asking Larmor's voice_ctl (it makes the checks
   * the menu bar makes, writes or removes the `away` file and starts or stops larmor_phone.py). Phone mode can turn on with voice off too. Larmor may refuse (not paired, firewall, another network): that is a 409 carrying its reason.
   * After bridge-stop voice_ctl waits up to 3 s for the bridge to be gone, so the bridge it reports is the real one.
   */
  async setPhone(command: PhoneCommand): Promise<{ on: boolean; bridge: boolean }> {
    const { result } = await this.askLarmor(command);
    return { on: result.away, bridge: result.bridge };
  }

  /**
   * Start voice from the board: Larmor's voice_ctl `start` types /larmor into the session's tab (the last voice session when
   * none is given) and waits for voice to come on in it. Larmor makes every check (voice already on, engine not ready, the
   * session busy or gone, no iTerm) and its reason comes back as a 409. Takes up to about 30 s.
   */
  async startVoice(session?: string): Promise<{ voice: boolean }> {
    if (session !== undefined && !/^[A-Za-z0-9._]/.test(session)) {
      throw new BoardError(400, 'session must be a session id');
    }
    const { result } = await this.askLarmor('start', session);
    return { voice: result.voiceOn };
  }

  /** Stop voice from the board: Larmor's voice_ctl `stop`, the menu bar's Stop voice. Takes up to about 3 s. */
  async stopVoice(): Promise<{ voice: boolean }> {
    const { result } = await this.askLarmor('stop');
    return { voice: result.voiceOn };
  }

  /**
   * One voice_ctl call at a time (a second while phone-on waits for the bridge would undo it). Pause and Resume are quick and
   * independent of the slow commands, so they have a guard of their own and work while a Start or a phone action runs.
   */
  private async askLarmor(command: VoiceCommand, session?: string): Promise<{ result: CtlResult }> {
    const board = readSettings(this.home).board;
    if (!board.larmorDir) {
      throw new BoardError(400, 'board_larmor_dir is needed for the voice and phone buttons');
    }
    if (!phoneReady(board.larmorDir)) {
      throw new BoardError(
        400,
        `${board.larmorDir} has no .venv-app/bin/python and app/voice_ctl.py to run`,
      );
    }
    const pausing = command === 'pause' || command === 'resume';
    if (pausing ? this.pauseBusy : this.phoneBusy) {
      throw new BoardError(409, 'Larmor is still working on the last voice or phone request');
    }
    if (pausing) {
      this.pauseBusy = true;
    } else {
      this.phoneBusy = true;
    }
    try {
      const result = await runVoiceCtl(board.larmorDir, command, session).catch((err: unknown) => {
        forgetProbes(); // no result to keep: the next build asks voice_ctl itself
        throw err instanceof VoiceCtlError ? new BoardError(502, err.message) : err;
      });
      // its state is read after the command ran, a refusal included: the next build uses it
      rememberVoiceState(board.larmorDir, result);
      if (!result.ok) {
        throw new BoardError(409, result.why || `Larmor would not do ${command}`);
      }
      return { result };
    } finally {
      if (pausing) {
        this.pauseBusy = false;
      } else {
        this.phoneBusy = false;
      }
      this.invalidate();
    }
  }

  /**
   * Clean up a worktree on the page's click (worktree-clean.ts has the checks). Who works in it is looked at now, from the
   * session registry and the agent registry, not from the last snapshot.
   */
  async cleanWorktree(dir: string, ack: string[], seen: string[] = []): Promise<CleanResult> {
    const settings = readSettings(this.home).board;
    if (!settings.worktrees) {
      throw new BoardError(404, 'the board does not show worktrees');
    }
    const clock = () => (this.options.now || (() => new Date()))().getTime();
    const result = await cleanWorktree({
      scanner: this.scanner,
      dir,
      ack,
      seen,
      home: this.home,
      keepBranches: settings.keepBranches,
      now: clock,
      contextOf: async (facts) => {
        const sessions = (await liveSessions(settings.sessionsDir)).map((session) => ({
          id: session.session,
          title: session.name ?? path.basename(session.cwd),
          cwd: session.cwd,
        }));
        const { agents } = readAgents(this.home);
        return {
          inUse: workingIn(facts.path, sessions, agents, facts),
          pr: prOfFacts(this.review, facts, clock()),
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

  listenOffer(repo: string): ReturnType<Sessions['listenOffer']> {
    return this.sessions.listenOffer(repo);
  }

  queueListen(repo: string | null, story: string | null): ReturnType<Sessions['queueListen']> {
    return this.sessions.queueListen(repo, story);
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
   * A finished agent's card's Finish: the card leaves the board now, and comes back only if the agent does something more
   * (a later event or beat). The agent is looked up in the registry again, never taken from the page. One still waiting
   * on a question is finished through the registry (which writes its `[done]` ledger line when the settings name a
   * ledger); one that is done, failed or stopped needs nothing. A working agent, or one parked on your story review, is
   * refused.
   */
  finishAgent(sid: string, name: string): { ledger: boolean } {
    const now = (this.options.now || (() => new Date()))();
    // the agents as the board shows them: a run the liveness rule shows dead is finished here too (the last build's answer)
    const agents = endDeadRuns(
      readAgents(this.home).agents,
      this.liveness.lastAnswer(),
      now.getTime(),
    );
    const agent = agents.find((one) => one.sid === sid && one.name === name);
    if (!agent) {
      throw new BoardError(404, 'no registered agent with that sid and name');
    }
    if (agent.review) {
      throw new BoardError(
        409,
        'that agent is parked on your story review: mark the story reviewed',
      );
    }
    const open = agent.state === 'waiting';
    if (!open && !isFinished(agent)) {
      throw new BoardError(409, 'that agent is still working');
    }
    // closed by an event, which writes its own ledger line when the settings name a ledger
    if (open) {
      try {
        // the ledger line only: the board has never written a progress line. A carded critic still needs its findings count
        finishRun(
          this.home,
          name,
          { sid, outcome: 'finished from the board', by: 'board', at: now },
          { mirror: 'ledger' },
        );
      } catch (err) {
        throw new BoardError(409, finishRefusal(agent, err as Error));
      }
    }
    // the click counts as at least the agent's latest line, which may be ahead of this clock (a wrong zone, a typo), so the card goes either way
    const latest = lastActivity(agent)?.getTime() ?? 0;
    markFinished(this.home, agentId(sid, name), Math.max(now.getTime(), latest));
    // an agent's card's other finished runs (a critic of the work) are on this card: Finish clears the piece of work, not one run of it
    const own = agent.card ? this.backlog.items().find((one) => one.id === agent.card) : undefined;
    if (own && !isListed(own)) {
      for (const other of agents) {
        if (other !== agent && other.card === agent.card && isFinished(other)) {
          const seen = lastActivity(other)?.getTime() ?? 0;
          markFinished(this.home, agentId(other.sid, other.name), Math.max(now.getTime(), seen));
        }
      }
    }
    this.invalidate();
    return { ledger: open };
  }

  /** The board's Stop listening: every `wait --repo` for the repo ends on its next look, within a couple of seconds. */
  stopListening(repo: string): void {
    if (!REPO_RE.test(repo)) {
      throw new BoardError(400, 'a repo (owner/name) is needed');
    }
    new Listening(this.home).stop(repo);
    this.invalidate();
  }
}
