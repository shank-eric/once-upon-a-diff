/**
 * The agent board's actions, and the cache in front of its data. What the data holds, where each source is read and how
 * a card is made is in stages/ (stages/index.ts has the stages and the sources). What a click on the board does to other
 * tools is in ADR-11: Board has the actions, which are the board's only writes.
 */
import { agentId, isImplicitCard } from '@once-upon-a-diff/terms/ids';
import path from 'node:path';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import {
  REPO_RE,
  lastKnownRepo,
  repoOfCheckoutAsync,
  typedRepoNote,
} from '@once-upon-a-diff/foundation/repos';
import { branchNameAsync, isAncestorAsync, runGitAsync } from '@once-upon-a-diff/adapters/git';
import { aheadOf } from '@once-upon-a-diff/stories/pull-request';
import { lastActivity } from '@once-upon-a-diff/state/records/agents/ledger';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { markFinished } from '@once-upon-a-diff/adapters/stores/finished-agents';
import { BlankSessions } from '@once-upon-a-diff/adapters/claude-sessions/blank-sessions';
import { SessionTitles } from '@once-upon-a-diff/adapters/claude-sessions/titles';
import {
  BacklogStore,
  assignBranch,
  assignLine,
} from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { AddInput, EditInput, MoveTo } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
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
import type { BoardCard, BoardData, BoardStatus } from '@once-upon-a-diff/contracts/types';
import { prOfFacts } from './stages/worktrees.ts';
import { buildBoard } from './stages/index.ts';
import { liveSessions } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { noPrWatcher, type PrWatcher } from './stages/pr-watcher.ts';
import type { BuildContext, Lookups } from './stages/types.ts';
import { Sessions } from '@once-upon-a-diff/core/features/sessions/sessions';

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
  /** Bumped when what a build read is out of date, so a build that started before it does not fill the cache. */
  private generation = 0;
  private blank = new BlankSessions();
  private titles = new SessionTitles();
  /** the session each listener's wait ran in, for its handling beat (adoptHandlers) */
  private listenerSessions = new Map<string, string>();
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

  /** Edits an open backlog item's title, note or repo (a card's Edit). */
  editBacklog(id: string, input: EditInput, who: string): BacklogItem {
    const item = this.backlog.edit(id, input, who);
    this.invalidate();
    return item;
  }

  /** Why a repo typed in a card's Edit looks wrong, or null. It only warns: the edit is saved either way (ADR-25's flip refuses). */
  typedRepoNote(repo: string): string | null {
    return typedRepoNote(this.home, repo, {
      cardRepos: this.backlog.items().map((item) => item.repo),
    });
  }

  /** Puts an open backlog item in the Someday section, or back (a card's Someday button). The registry says whether its claim is live. */
  somedayBacklog(id: string, aside: boolean, who: string): BacklogItem {
    const now = (this.options.now || (() => new Date()))();
    const { agents } = readAgents(this.home);
    const item = this.backlog.someday(id, aside, who, agents, now.getTime());
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
    const branch = await branchNameAsync(cwd, 3000);
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
      listenerSessions: this.listenerSessions,
      backlog: this.backlog,
      scanner: this.scanner,
    });
    this.seen = built.seen;
    this.listeningNow = { input: built.listening };
    return built.data;
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
   * Assign: tells the voice session to start a backlog card, by typing "Start backlog card <id>: <title>" into its tab (the
   * board snapshot's voice session, else the most recent live interactive session). The id and title are the bridge's own,
   * the title cleaned and capped. The voice session may be mid-turn (Claude Code queues the line); a session that is not the
   * voice one must be at its prompt, and one waiting on you is refused either way. An item already started is refused.
   * Sending again is fine. Nothing is recorded unless the typing worked.
   */
  async assignBacklog(id: string, who: string): Promise<{ typed: string; session: string }> {
    const item = this.backlog.items().find((one) => one.id === id);
    if (!item || item.state === 'dropped') {
      throw new BoardError(404, 'no backlog item with that id');
    }
    if (item.state === 'started') {
      throw new BoardError(409, 'that item is already started');
    }
    if (item.someday) {
      throw new BoardError(409, 'that item is someday: bring it back to the backlog first');
    }
    // voice that has ended (the card stays pinned for the day) is just another session
    const voice = (await this.snapshot()).voice;
    const live = voice && voice.status !== 'ended' ? voice : null;
    let target = live ? { id: live.session, name: live.name } : null;
    if (!target) {
      // never the voice session or one that listens (the same set Start listening leaves out)
      const apart = this.listeningNow?.input.apart;
      const recent = (await this.sessions.live())
        .filter((one) => (!one.kind || one.kind === 'interactive') && !apart?.has(one.session))
        .sort(
          (first, second) =>
            (second.statusAt ?? second.startedAt ?? 0) - (first.statusAt ?? first.startedAt ?? 0),
        )[0];
      if (!recent) {
        throw new BoardError(409, 'there is no voice session or live session to send it to');
      }
      target = { id: recent.session, name: recent.name ?? path.basename(recent.cwd) };
    }
    const { it2, session } = await this.sessions.typeable(target.id, !!live);
    const prompt = assignLine(item);
    const failed = await this.sessions.send(it2, session, prompt);
    if (failed) {
      throw new BoardError(409, failed);
    }
    this.backlog.assign(id, { session: target.id, branch: assignBranch(item), by: who });
    this.invalidate();
    return { typed: prompt, session: target.name };
  }

  /**
   * A finished agent's card's Finish: the card leaves the board now, and comes back only if the agent does something more
   * (a later event or beat). The agent is looked up in the registry again, never taken from the page. One still waiting
   * on a question is finished through the registry (which writes its `[done]` ledger line when the settings name a
   * ledger); one that is done, failed or stopped needs nothing. A working agent, or one parked on your story review, is
   * refused.
   */
  finishAgent(sid: string, name: string): { ledger: boolean } {
    const settings = readSettings(this.home).board;
    const now = (this.options.now || (() => new Date()))();
    const { agents } = readAgents(this.home);
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
    if (!open && agent.state !== 'done' && agent.state !== 'failed' && agent.state !== 'stopped') {
      throw new BoardError(409, 'that agent is still working');
    }
    // closed by an event, which writes its own ledger line when the settings name a ledger
    if (open) {
      new AgentRegistry(this.home, { ledger: settings.ledgerFile, progress: null }).finish(name, {
        sid,
        outcome: 'finished from the board',
        by: 'board',
        at: now,
      });
    }
    // the click counts as at least the agent's latest line, which may be ahead of this clock (a wrong zone, a typo), so the card goes either way
    const latest = lastActivity(agent)?.getTime() ?? 0;
    markFinished(this.home, agentId(sid, name), Math.max(now.getTime(), latest));
    // an implicit card's other finished runs (a critic of the work) are on this card: Finish clears the piece of work, not one run of it
    if (agent.card && isImplicitCard(agent.card)) {
      for (const other of agents) {
        if (
          other !== agent &&
          other.card === agent.card &&
          ['done', 'failed', 'stopped'].includes(other.state)
        ) {
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
