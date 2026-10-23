// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Moving between steps (Prev, Next, the step list), and reporting where the
 * reviewer is (opts.onPosition): the step and the file at the top of the
 * screen, debounced.
 */

const POSITION_DEBOUNCE_MS = 1200;

export function createNavigation(context) {
  const { state, opts, page, shell } = context;

  /** "Chapter 2: …" or "Overview": how questions and positions name the step. */
  function stepLabel() {
    const chapter = context.chapter();
    return chapter ? chapter.title : 'Overview';
  }

  /** After a step change: redraw, re-filter, report, and scroll to the step's first file. */
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
    const left = from > 0 && step > from ? context.viewed.leftToMark(from) : [];
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
        step: state.n,
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
    stepLabel,
    reportPosition,
    /** The file at the top of the screen when the position was last reported. */
    get topFile() {
      return topFile;
    },
    destroy,
  };
}
