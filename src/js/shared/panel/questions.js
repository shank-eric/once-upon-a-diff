/*
 * Questions: the Ask box sends one through opts.ask (to the bridge inbox),
 * and the step's questions and their answers come back through
 * opts.loadQuestions, every 4s while one is waiting, otherwise every 30s.
 */
import { escapeHtml } from '../util/html.js';
import { baseName } from '../util/text.js';
import { shortDateTime } from '../util/time.js';

const POLL_MS = 4000;
const SLOW_EVERY = 8; // polls: 8 x 4s = every 30s or so with nothing waiting

export function createQuestions(context) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let questions = [];
  let pollTimer = 0;
  let pollCount = 0;

  /** Is this question about the step on screen (any story step on the Overview)? */
  function forStep(question) {
    const asked = String(question.chapter || '');
    if (context.inBackstory()) {
      return (
        asked === context.navigation.stepLabel() || (state.n === 0 && /^Backstory/.test(asked))
      );
    }
    return !/^Backstory/.test(asked) && (state.n === 0 || question.step === state.n);
  }

  function render() {
    const box = $('.prs-questions');
    if (!box) {
      return;
    }
    const list = questions.filter(forStep);
    if (!list.length) {
      box.innerHTML = '';
      return;
    }
    const items = list.map((question) => {
      const when = shortDateTime(question.at);
      const where = [
        state.n === 0 && question.step ? `chapter ${question.step}` : '',
        question.file ? baseName(question.file) : '',
      ]
        .filter(Boolean)
        .join(', ');
      const answers = (question.answers || [])
        .map(
          (answer) => `<div class="prs-a prs-md">${context.markdown.markdown(answer.text)}</div>`,
        )
        .join('');
      return (
        `<div class="prs-qa"><div class="prs-q">${escapeHtml(question.text)}</div><div class="prs-qmeta">${escapeHtml([when, where].filter(Boolean).join(' · '))}</div>` +
        `${answers || '<div class="prs-wait">Waiting for an answer from the Claude session</div>'}</div>`
      );
    });
    box.innerHTML =
      `<h2 class="prs-h">Questions${state.n ? ' on this step' : ''} (${list.length})</h2>` +
      items.join('');
  }

  async function refresh() {
    if (!opts.loadQuestions) {
      return;
    }
    try {
      const next = await opts.loadQuestions();
      if (!Array.isArray(next)) {
        return;
      }
      const changed = JSON.stringify(next) !== JSON.stringify(questions);
      questions = next;
      if (changed) {
        render();
      }
    } catch (e) {
      /* the bridge may be down; try again on the next tick */
    }
  }

  function poll() {
    pollCount++;
    const waiting = questions.some((question) => !(question.answers || []).length);
    if ((waiting || pollCount % SLOW_EVERY === 0) && document.visibilityState === 'visible') {
      refresh();
    }
  }
  if (opts.loadQuestions) {
    refresh();
    pollTimer = setInterval(poll, POLL_MS);
  }

  const askForm = $('.prs-ask');
  const askText = askForm.querySelector('textarea');
  askForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = askText.value.trim();
    if (!text || !opts.ask) {
      return;
    }
    const button = askForm.querySelector('button');
    button.disabled = true;
    try {
      await opts.ask({
        text,
        step: context.inBackstory() ? null : state.n,
        chapter: context.navigation.stepLabel(),
        file: context.navigation.topFile || context.page.fileAtTop(),
      });
      askText.value = '';
      const health = context.statusLight.current;
      shell.message(
        health && !health.listening
          ? 'Queued in the bridge inbox. No Claude session is listening yet, so it will wait.'
          : 'Sent to the bridge inbox.',
      );
      await refresh();
    } catch (err) {
      shell.message(`Couldn't send the question: ${err && err.message ? err.message : err}`);
    } finally {
      button.disabled = false;
    }
  });
  askText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      askForm.requestSubmit();
    }
  });

  return { render, refresh, destroy: () => clearInterval(pollTimer) };
}
