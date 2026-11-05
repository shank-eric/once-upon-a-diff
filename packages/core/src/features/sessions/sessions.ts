/**
 * The Claude Code sessions the board can reach: which are live (the registry), which one a click may type into, and the
 * line typed into its iTerm tab. Build story types the card's prompt, Start listening types `/once-upon-listen <repo>` or
 * `--story <id>`, and Assign types a backlog item's start line. Everything typed is made here from what the bridge knows,
 * the tab is found from the session's tty, and nothing is typed unless the session is at its prompt: working or waiting
 * on you means no.
 *
 * It asks the board for two things it does not own (the last snapshot, and what that build knew of the sessions) through
 * `SessionsFeed`, so nothing here imports the Board.
 */
import { readSettings } from '../../foundation/settings.ts';
import { REPO_RE, repoOfCheckoutAsync, sameRepo } from '../../foundation/repos.ts';
import { readMeta, storyRepo } from '../../records/stories/meta.ts';
import { STORY_ID_RE } from '@once-upon-a-diff/domain/patterns';
import type { StoryStore } from '../../records/stories/store.ts';
import { findIt2, focusTab, typeLine } from '../../adapters/iterm.ts';
import type { StatusSource } from '../../adapters/status-source.ts';
import { liveSessions, type LiveSession } from '../../adapters/claude-sessions/live-sessions.ts';
import { pickSource } from './sources.ts';
import { BoardError } from '../../foundation/errors.ts';
import {
  listenCandidates,
  listenCandidatesIn,
  listenPromptFor,
  listenStoryPromptFor,
  withinDir,
} from './listening.ts';
import type { ListeningInput } from './listening.ts';
import type { BoardData } from '@once-upon-a-diff/contracts/types';

/** What Sessions asks of the board it sits beside. */
export interface SessionsFeed {
  /** the board's kept snapshot (a click costs no more than a page poll) */
  snapshot(): Promise<BoardData>;
  /** what the last build knew of the sessions, or null before the first build */
  listening(): ListeningInput | null;
  /** drop the kept snapshot: a line was typed, so the next one must look again */
  invalidate(): void;
}

export class Sessions {
  private home: string;
  private stories: StoryStore;
  private feed: SessionsFeed;
  private options: {
    /** for tests: their own tab typing */
    typeLine?: typeof typeLine;
    /** for tests: their own tab statuses, in place of the configured source */
    source?: StatusSource;
  };

  constructor(
    home: string,
    stories: StoryStore,
    feed: SessionsFeed,
    options: { typeLine?: typeof typeLine; source?: StatusSource } = {},
  ) {
    this.home = home;
    this.stories = stories;
    this.feed = feed;
    this.options = options;
  }

  /** Types a line into a live session's tab (the typing is `options.typeLine` in tests). Resolves to null when it worked, else why not. */
  send(it2: string, session: LiveSession, line: string): Promise<string | null> {
    return (this.options.typeLine || typeLine)(it2, session.tty, line);
  }

  /** The registry's live sessions (folders, status, tty). */
  live(): Promise<LiveSession[]> {
    return liveSessions(readSettings(this.home).board.sessionsDir);
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

  /**
   * The it2 CLI and the live session to type into, or the BoardError saying why not: no it2, no such session, busy, or waiting
   * on you. `allowBusy` lets a working session take the line (Claude Code queues what is typed while it works): only for the
   * voice session, which is always mid-turn, and only when iTerm reports that tab's status.
   */
  async typeable(
    sessionId: string,
    allowBusy = false,
  ): Promise<{ it2: string; session: LiveSession }> {
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
    const source =
      this.options.source ?? pickSource(settings.statusSource, settings.it2Path).source;
    const tab = (await source.statuses([session])).get(sessionId);
    if (allowBusy && !tab) {
      // a working session takes the line only when its tab says it is not waiting on you: no word from the tab means no
      throw new BoardError(409, 'iTerm has no status for that tab, so it is not safe to type into');
    }
    const status = tab?.status ?? (session.status === 'busy' ? 'working' : 'idle');
    if (!allowBusy && (session.status === 'busy' || status === 'working')) {
      throw new BoardError(409, 'session busy');
    }
    if (status === 'waiting') {
      throw new BoardError(409, 'the session is waiting for you');
    }
    return { it2, session };
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
    await this.feed.snapshot();
    const known = this.feed.listening();
    return known ? listenCandidates(repo, known) : [];
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
    await this.feed.snapshot();
    return {
      repo: null,
      sessions: this.feed.listening() ? listenCandidatesIn(dir, this.feed.listening()!) : [],
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
   * its prompt: working or waiting on you means no. Build story's `card` is the card clicked: one session can build for
   * several (a launcher's finished authors), so the line is that card's, never the first one found.
   */
  async type(
    kind: 'build' | 'listen',
    sessionId: string,
    repo: string | null,
    story: string | null = null,
    card: string | null = null,
  ): Promise<string> {
    const { it2, session } = await this.typeable(sessionId);
    if (kind === 'listen') {
      // the same rule as the offer, against a fresh look: a chooser can be stale, and a direct call can name anyone
      await this.feed.snapshot();
      if (this.feed.listening()?.apart.has(sessionId)) {
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
      const cards = (await this.feed.snapshot()).lanes.flatMap((lane) => lane.cards);
      prompt =
        cards.find((one) => (!card || one.id === card) && one.build?.session === sessionId)?.build
          ?.prompt ?? null;
      if (!prompt) {
        throw new BoardError(409, 'there is nothing to build for that session');
      }
    }
    const failed = await (this.options.typeLine || typeLine)(it2, session.tty, prompt);
    if (failed) {
      throw new BoardError(409, failed);
    }
    this.feed.invalidate();
    return prompt;
  }
}
