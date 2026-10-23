/*
 * The panel's own state: the step and the panel's layout. The caller saves
 * it through opts.onState and passes it back as opts.initial, so its field
 * names are part of the panel's contract:
 * {n, all, collapsed, width, filesOpen, showPosted, showDismissed, chatOpen, chatHeight}.
 */
import type { Chapter, PanelUi } from '../types.ts';
import type { StoryModel } from './story-model.ts';
import type { PanelContext } from './context.ts';

/** The panel's state: what it saves, and whether the Overview's list of every draft is open this time. */
export interface PanelState extends PanelUi {
  allCommentsOpen?: boolean;
}

/** A saved state to start from, plus the body's scroll on a live redraw. */
export type InitialUi = Partial<PanelUi> & { bodyScroll?: number; hidden?: boolean };

/** The step clamped to the story's steps (0 is the Overview). */
export function clampStep(story: StoryModel, step: number): number {
  return Math.min(Math.max(0, step), story.data.chapters.length);
}

function storyStartOf(story: StoryModel, initial: InitialUi): number {
  if (Number.isFinite(initial.n)) {
    return initial.n as number;
  }
  return Number.isFinite(story.data.start) ? (story.data.start as number) : 0;
}

/** The state to start from: a saved one (opts.initial), else the story's start step. */
export function createPanelState(story: StoryModel, initial: InitialUi): PanelState {
  return {
    n: clampStep(story, storyStartOf(story, initial)),
    all: !!initial.all,
    collapsed: !!initial.collapsed,
    width: Number.isFinite(initial.width) ? (initial.width as number) : 460,
    filesOpen: !!initial.filesOpen, // the "Files in this chapter" list starts folded
    showPosted: !!initial.showPosted, // posted and dismissed drafts start hidden
    showDismissed: !!initial.showDismissed,
    chatOpen: !!initial.chatOpen, // the questions dock starts closed
    chatHeight: Number.isFinite(initial.chatHeight) ? (initial.chatHeight as number) : 280,
  };
}

/** The questions the rest of the panel asks of the state, and saving it through opts.onState. */
export function stateHelpers(
  context: Pick<PanelContext, 'story' | 'state' | 'opts'>,
): Pick<PanelContext, 'steps' | 'chapter' | 'inChapter' | 'fileStatus' | 'saveState'> {
  const { story, state, opts } = context;
  const steps = () => story.data.chapters;
  const chapter = () => (state.n ? steps()[state.n - 1] : null);
  const inChapter = () =>
    new Set(state.n ? (chapter() as Chapter).files.map((file) => file.rel) : story.allRels);
  /** A file's status in chapter `step`. */
  const fileStatus = (rel: string, step: number) => story.statusIn(rel, step);
  function saveState() {
    if (!opts.onState) {
      return;
    }
    opts.onState({
      n: state.n,
      all: state.all,
      collapsed: state.collapsed,
      width: state.width,
      filesOpen: state.filesOpen,
      showPosted: state.showPosted,
      showDismissed: state.showDismissed,
      chatOpen: state.chatOpen,
      chatHeight: state.chatHeight,
    });
  }
  return { steps, chapter, inChapter, fileStatus, saveState };
}
