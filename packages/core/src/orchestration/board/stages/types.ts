/** What the build stages pass between them, and what they need from the Board that holds the caches. */
import type { readSettings } from '../../../foundation/settings.ts';
import type { Builds } from '../../../queues/requests/builds.ts';
import type { StoryStore } from '../../../records/stories/store.ts';
import type { Worktree } from '../../../queues/backlog/backlog-links.ts';
import type {
  BoardCard,
  BoardSession,
  InboxLocalStory,
  InboxStory,
} from '@once-upon-a-diff/contracts/types';
import type { StatusSource } from '../../../adapters/status-source.ts';
import type { PrWatcher } from './pr-watcher.ts';

/** The board's settings (config.json's board_* keys, read once per build). */
export type BoardSettings = ReturnType<typeof readSettings>['board'];

/** A unit of work being assembled: a PR (with or without its story) or a branch that has no PR yet. */
export interface Work {
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

/** A live session with what the board worked out about it. */
export interface SessionView {
  card: BoardSession;
}

/** What the board reads of a built story, a PR story's or a local one's. */
export type StoryFacts = Pick<InboxStory, 'id' | 'built_at' | 'reviewed_at' | 'reviewed_by'>;

/** The voice session as the board found it among the live sessions. */
export interface PinnedVoice {
  view: BoardSession;
  lane: string;
  repo: string | null;
  busy: boolean;
}

/**
 * What only the Board can answer, because it holds the caches (a few seconds each) and the background looks. The stages
 * call these and never touch the caches themselves.
 */
export interface Lookups {
  /** a checkout's current branch (null when detached or not a repo) */
  branchOf(cwd: string, now: number): Promise<string | null>;
  /** the GitHub repo of a session's folder, waiting for the lookup only a moment */
  repoOf(cwd: string): Promise<string | null>;
  /** the worktrees of a checkout's repo, none when it isn't a repo */
  worktreesOf(cwd: string, now: number): Promise<Worktree[]>;
  /** whether a branch's work is in the repo's main line with no PR to say so */
  mergedLocally(
    trees: Worktree[],
    branch: string,
    now: number,
  ): Promise<{ at: number | null } | null>;
  /** a PR card's commits ahead of origin, as the checkout of a local story of its branch has them */
  aheadFor(found: { story: string; checkout: string }, branch: string): BoardCard['ahead'];
}

/** What every stage may read: the clock, the settings, the stores and the GitHub watcher. */
export interface BuildContext {
  home: string;
  now: Date;
  nowMs: number;
  settings: BoardSettings;
  stories: StoryStore;
  review: PrWatcher;
  builds: Builds;
  lookups: Lookups;
  /** a status source to use in place of the configured one (tests give their own) */
  sourceOverride?: StatusSource;
}
