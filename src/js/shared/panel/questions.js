/*
 * Questions: the Ask box sends one through opts.ask (to the bridge inbox),
 * and the step's questions and their answers come back through
 * opts.loadQuestions on the overlay's tick: every 5s while one is waiting,
 * otherwise every 30s, and when the tab gets focus again.
 */
import { escapeHtml } from '../util/html.js';
import { baseName } from '../util/text.js';
import { shortDateTime } from '../util/time.js';

const SLOW_EVERY = 6; // ticks: 6 x 5s = every 30s with nothing waiting

export function createQuestions(context) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let questions = [];

  /** Is this question about the step on screen (any story step on the Overview)? */
  const forStep = (question) => state.n === 0 || question.step === state.n;

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
    } catch {
      /* the bridge may be down; try again on the next tick */
    }
  }

  /** The overlay's tick: every tick while a question waits for its answer, otherwise every SLOW_EVERY. */
  function poll(ticks) {
    const waiting = questions.some((question) => !(question.answers || []).length);
    if (waiting || ticks % SLOW_EVERY === 0) {
      refresh();
    }
  }
  refresh();

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
        step: state.n,
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

  return { render, refresh, poll };
}
