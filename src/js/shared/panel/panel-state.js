/*
 * The panel's own state: the view (the story or the backstory), the step in
 * it, and the panel's layout. The caller saves it through opts.onState and
 * passes it back as opts.initial, so its field names are part of the panel's
 * contract: {n, bn, view, all, collapsed, width, filesOpen, showPosted, showDismissed}.
 */

/** The step clamped to the view's steps (0 is the Overview). */
export function clampStep(story, step, view) {
  const count = (view === 'backstory' ? story.backstorySteps : story.data.chapters).length;
  return Math.min(Math.max(0, step), count);
}

function storyStartOf(story, initial) {
  if (Number.isFinite(initial.n)) {
    return initial.n;
  }
  return Number.isFinite(story.data.start) ? story.data.start : 0;
}

/** The state to start from: a saved one (opts.initial), else the story's start step. */
export function createPanelState(story, initial) {
  const startView =
    initial.view === 'backstory' && story.backstorySteps.length ? 'backstory' : 'story';
  const storyStart = storyStartOf(story, initial);
  const backstoryStart = Number.isFinite(initial.bn) ? initial.bn : 0;
  const otherView = startView === 'backstory' ? 'story' : 'backstory';
  return {
    view: startView,
    // the step in the view on screen
    n: clampStep(story, startView === 'backstory' ? backstoryStart : storyStart, startView),
    // the step kept for the other view
    other: clampStep(story, startView === 'backstory' ? storyStart : backstoryStart, otherView),
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
  const inBackstory = () => state.view === 'backstory';
  const steps = () => (inBackstory() ? story.backstorySteps : story.data.chapters);
  const chapter = () => (state.n ? steps()[state.n - 1] : null);
  const inChapter = () =>
    new Set(state.n ? chapter().files.map((file) => file.rel) : story.allRels);
  /** A file's status in chapter `step` of the story; none in the backstory view. */
  const fileStatus = (rel, step) => (inBackstory() ? null : story.statusIn(rel, step));
  function saveState() {
    if (!opts.onState) {
      return;
    }
    const storyStep = inBackstory() ? state.other : state.n;
    const backstoryStep = inBackstory() ? state.n : state.other;
    opts.onState({
      n: storyStep,
      bn: backstoryStep,
      view: state.view,
      all: state.all,
      collapsed: state.collapsed,
      width: state.width,
      filesOpen: state.filesOpen,
      showPosted: state.showPosted,
      showDismissed: state.showDismissed,
    });
  }
  return { inBackstory, steps, chapter, inChapter, fileStatus, saveState };
}
