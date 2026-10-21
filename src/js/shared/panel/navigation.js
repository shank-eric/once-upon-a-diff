/*
 * Moving between steps (Prev, Next, the step list) and between the story and
 * the backstory view, and reporting where the reviewer is (opts.onPosition):
 * the step and the file at the top of the screen, debounced.
 */

const POSITION_DEBOUNCE_MS = 1200;

export function createNavigation(context) {
  const { story, state, opts, page, shell } = context;

  /** "Chapter 2: …", "Overview", or "Backstory: …" in the backstory view: how questions and positions name the step. */
  function stepLabel() {
    const chapter = context.chapter();
    if (context.inBackstory()) {
      return `Backstory: ${chapter ? chapter.title : 'How it got here'}`;
    }
    return chapter ? chapter.title : 'Overview';
  }

  /** After a step or view change: redraw, re-filter, report, and scroll to the step's first file. */
  function showStep({ restartClock }) {
    if (restartClock) {
      context.reading.start();
    }
    shell.message('');
    context.saveState();
    context.body.render();
    context.filter.apply();
    reportPosition();
    if (state.n === 0) {
      window.scrollTo({ top: 0 });
    } else if (context.chapter().files[0]) {
      context.scroll.scrollToFile(context.chapter().files[0].rel, true);
    }
  }

  function goToStep(step) {
    if (step < 0 || step > context.steps().length) {
      return;
    }
    const from = state.n;
    const left =
      !context.inBackstory() && from > 0 && step > from ? context.viewed.leftToMark(from) : [];
    if (step !== from) {
      context.reading.leave();
    }
    state.n = step;
    state.all = false;
    showStep({ restartClock: step !== from });
    if (left.length) {
      shell.message(context.viewed.leavingMessage(from, left));
    }
  }

  /** Switch between the story (the default) and the backstory view. Only an explicit switch gets here, so only then is the view saved. */
  function setView(view) {
    const next = view === 'backstory' && story.backstorySteps.length ? 'backstory' : 'story';
    if (next === state.view) {
      return;
    }
    context.reading.leave();
    const keep = state.n;
    state.view = next;
    state.n = context.clampStep(state.other, next);
    state.other = keep;
    state.all = false;
    showStep({ restartClock: true });
  }

  // ---------- where the reviewer is: the step and the file at the top of the screen
  let positionTimer = 0;
  let lastPosition = '';
  let topFile = null;
  function reportPosition() {
    if (!opts.onPosition) {
      return;
    }
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      topFile = page.fileAtTop();
      const position = {
        step: context.inBackstory() ? null : state.n,
        chapter: stepLabel(),
        file: topFile,
      };
      const key = JSON.stringify(position);
      if (key === lastPosition) {
        return;
      }
      lastPosition = key;
      opts.onPosition(position);
    }, POSITION_DEBOUNCE_MS);
  }
  const onScroll = () => reportPosition();
  window.addEventListener('scroll', onScroll, { passive: true });

  function destroy() {
    clearTimeout(positionTimer);
    window.removeEventListener('scroll', onScroll);
  }

  return {
    go: goToStep,
    setView,
    stepLabel,
    reportPosition,
    /** The file at the top of the screen when the position was last reported. */
    get topFile() {
      return topFile;
    },
    destroy,
  };
}
