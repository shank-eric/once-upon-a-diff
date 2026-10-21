/*
 * The panel's own state: the step and the panel's layout. The caller saves
 * it through opts.onState and passes it back as opts.initial, so its field
 * names are part of the panel's contract:
 * {n, all, collapsed, width, filesOpen, showPosted, showDismissed}.
 */

/** The step clamped to the story's steps (0 is the Overview). */
export function clampStep(story, step) {
  return Math.min(Math.max(0, step), story.data.chapters.length);
}

function storyStartOf(story, initial) {
  if (Number.isFinite(initial.n)) {
    return initial.n;
  }
  return Number.isFinite(story.data.start) ? story.data.start : 0;
}

/** The state to start from: a saved one (opts.initial), else the story's start step. */
export function createPanelState(story, initial) {
  return {
    n: clampStep(story, storyStartOf(story, initial)),
    all: !!initial.all,
    collapsed: !!initial.collapsed,
    width: Number.isFinite(initial.width) ? initial.width : 460,
    filesOpen: !!initial.filesOpen, // the "Files in this chapter" list starts folded
    showPosted: !!initial.showPosted, // posted and dismissed drafts start hidden
    showDismissed: !!initial.showDismissed,
  };
}

/** The questions the rest of the panel asks of the state, and saving it through opts.onState. */
export function stateHelpers(context) {
  const { story, state, opts } = context;
  const steps = () => story.data.chapters;
  const chapter = () => (state.n ? steps()[state.n - 1] : null);
  const inChapter = () =>
    new Set(state.n ? chapter().files.map((file) => file.rel) : story.allRels);
  /** A file's status in chapter `step`. */
  const fileStatus = (rel, step) => story.statusIn(rel, step);
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
    });
  }
  return { steps, chapter, inChapter, fileStatus, saveState };
}
