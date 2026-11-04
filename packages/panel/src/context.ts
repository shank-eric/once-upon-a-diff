/*
 * The panel's options (what its host passes storyOverlay) and the context
 * every part of the panel gets: the story, the state, the options, and the
 * other parts, reached through it at call time. Types only.
 */
import type {
  BridgeStatus,
  Chapter,
  DraftAction,
  DraftsAnswer,
  FixesAct,
  FixesView,
  Freshness,
  ListenSession,
  ListenTarget,
  PanelPosition,
  PanelUi,
  Pulse,
  Question,
  QuestionAsk,
  QuestionMark,
  QuestionMarkExtra,
  QuestionMarksAnswer,
  ReadEvent,
  ReadInfo,
  RebuildAsk,
  RebuildView,
  Side,
  WorkingMark,
} from '@once-upon-a-diff/protocol/types';
import type { FileStatus, StoryModel } from './story-model.ts';
import type { InitialUi, PanelState } from './panel-state.ts';
import type { Layout } from './layout.ts';
import type { HostPage } from './host.ts';
import type { Shell } from './shell.ts';
import type { FileRefs } from './file-refs.ts';
import type { Markdown } from './markdown.ts';
import type { Expander } from './reading/expand.ts';
import type { Filter } from './reading/filter.ts';
import type { ViewedTracker } from './reading/viewed.ts';
import type { FileList } from './reading/file-list.ts';
import type { Scroller } from './reading/scroll.ts';
import type { Navigation } from './reading/navigation.ts';
import type { Body } from './body.ts';
import type { StatusLight } from './status-light-part.ts';
import type { Markup } from './markup.ts';
import type { FreshnessPart } from './rebuild/freshness.ts';
import type { Rebuild } from './rebuild/rebuild.ts';
import type { Reading } from './reading/reading.ts';
import type { Marks } from './rebuild/marks.ts';
import type { Drafts } from './drafts/drafts.ts';
import type { Fixes } from './fixes/fixes.ts';
import type { Working } from './fixes/working.ts';
import type { Questions } from './ask/questions.ts';
import type { ChatDock } from './ask/chat-dock.ts';

/** What the panel's host gives it (see overlay.ts for what each does). */
export interface PanelOptions {
  /** where the host serves panel/page.css and panel/panel.css */
  stylesheets: { page: string; panel: string };
  initial?: InitialUi;
  onState?(state: PanelUi): void;
  onLayout?(layout: Layout): void;
  onPosition?(position: PanelPosition): void;
  onClose?(): void;
  ask?(question: QuestionAsk): Promise<unknown>;
  loadQuestions?(): Promise<Question[]>;
  markQuestions?(
    action: QuestionMark,
    ids: string[],
    extra?: QuestionMarkExtra,
  ): Promise<QuestionMarksAnswer>;
  status?(): Promise<BridgeStatus>;
  /**
   * Start listening (panel/start-listening.ts): the idle Claude Code sessions that may be typed into, and typing the
   * listen line into one. Both reject with an Error whose message says why. Only a host that can reach the bridge's board
   * (the extension, and the local page through its own story routes) passes it; without it the panel shows the listen
   * line to type yourself and offers no button.
   */
  listen?: {
    sessions(target: ListenTarget): Promise<ListenSession[]>;
    start(sessionId: string, target: ListenTarget): Promise<void>;
  };
  drafts?: {
    load(): Promise<DraftsAnswer>;
    act(chapter: number, index: number, action: DraftAction): Promise<DraftsAnswer>;
  };
  fixes?: {
    load(): Promise<FixesView>;
    act(body: FixesAct): Promise<FixesView>;
    note(id: string | null, changes: { body: string } | { delete: true }): Promise<unknown>;
    onChange?(view: FixesView): void;
  };
  working?(): Promise<{ marks?: WorkingMark[] } | null>;
  reloadPage?(): void;
  pulse?(): Promise<Pulse>;
  /** a hidden tab's slow "still open" signal (see overlay.ts) */
  stillOpen?(): Promise<unknown>;
  onPulse?(pulse: Pulse): void;
  onFilter?(filter: { n: number; all: boolean }): void;
  reveal?(rel: string, side?: Side, start?: number, end?: number): void;
  freshness?(): Promise<Freshness>;
  requestUpdate?(
    baseSha: string | null | undefined,
    options: { retell: boolean },
  ): Promise<unknown>;
  requestRebuild?(ask: RebuildAsk): Promise<{ rebuild?: RebuildView | null } | null>;
  onRead?(read: ReadEvent): unknown;
  reads?(): Promise<ReadInfo>;
  host?: string;
  commentsTitle?: string;
}

/** Everything a part of the panel can reach. */
export interface PanelContext {
  hostId: string;
  panelId: string;
  opts: PanelOptions;
  story: StoryModel;
  state: PanelState;
  hostName: string;
  pageLoadedAt: number;
  commentsTitle: string;
  // the state's helpers (panel-state.ts)
  steps(): Chapter[];
  chapter(): Chapter | null;
  inChapter(): Set<string>;
  fileStatus(rel: string, step: number): FileStatus | null;
  saveState(): void;
  // the parts
  page: HostPage;
  shell: Shell;
  refs: FileRefs;
  markdown: Markdown;
  markup: Markup;
  expander: Expander;
  filter: Filter;
  viewed: ViewedTracker;
  fileList: FileList;
  scroll: Scroller;
  navigation: Navigation;
  body: Body;
  statusLight: StatusLight;
  freshness: FreshnessPart;
  rebuild: Rebuild;
  reading: Reading;
  marks: Marks;
  drafts: Drafts;
  fixes: Fixes;
  working: Working;
  chatDock: ChatDock;
  questions: Questions;
  destroy(): void;
}
