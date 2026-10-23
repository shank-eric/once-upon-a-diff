/*
 * Questions: the Ask box sends one through opts.ask (to the bridge inbox),
 * and the step's questions and their answers come back through
 * opts.loadQuestions on the overlay's tick: every 5s while one is waiting,
 * otherwise every 30s, and when the tab gets focus again.
 *
 * Each exchange collapses to its question line and can be dismissed, and
 * Clear conversation dismisses every question in the story. Dismissed ones
 * hide behind "Show dismissed", with Restore, and the last dismissal can be
 * undone for a few seconds. opts.markQuestions saves those marks in the
 * bridge, so they hold after a reload and on the next poll.
 */
import { html } from '../util/html.js';
import { setHtml } from '../util/dom.js';
import { baseName, plural } from '../util/text.js';
import { shortDateTime } from '../util/time.js';

const SLOW_EVERY = 6; // ticks: 6 x 5s = every 30s with nothing waiting
const UNDO_MS = 15000;

/** What one mark action does to a question, for drawing it before the bridge answers. */
const MARK_FIELDS = {
  dismiss: { dismissed: true },
  clear: { dismissed: true },
  restore: { dismissed: false },
  collapse: { collapsed: true },
  expand: { collapsed: false },
};

export function createQuestions(context) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let questions = [];
  let showDismissed = false;
  let undo = null; // {label, ids} after a dismissal, until UNDO_MS passes or the next one
  let undoTimer = 0;

  /** Is this question about the step on screen (any story step on the Overview)? */
  const forStep = (question) => state.n === 0 || question.step === state.n;

  function setUndo(next) {
    clearTimeout(undoTimer);
    undo = next;
    if (next) {
      undoTimer = setTimeout(() => {
        undo = null;
        render();
      }, UNDO_MS);
    }
  }

  function answersHtml(question) {
    const answers = question.answers || [];
    if (!answers.length) {
      const from = question.handed_to || 'the Claude session';
      return html`<div class="ou-wait">Waiting for an answer from ${from}</div>`;
    }
    return answers.map((answer) => {
      const answeredBy = answer.by && html`<div class="ou-aby">Answered by ${answer.by}</div>`;
      return html`${answeredBy}<div class="ou-a ou-md">${context.markdown.markdown(answer.text)}</div>`;
    });
  }

  function questionHtml(question) {
    const when = shortDateTime(question.at);
    const where = [
      state.n === 0 && question.step ? `chapter ${question.step}` : '',
      question.file ? baseName(question.file) : '',
    ]
      .filter(Boolean)
      .join(', ');
    const answerCount = (question.answers || []).length;
    const collapsed = !!question.collapsed;
    const meta = [when, where, collapsed && answerCount ? plural(answerCount, 'answer') : '']
      .filter(Boolean)
      .join(' · ');
    const classes = [
      'ou-qa',
      collapsed && 'ou-qa-collapsed',
      question.dismissed && 'ou-qa-dismissed',
    ]
      .filter(Boolean)
      .join(' ');
    const toggle = collapsed
      ? html`<button type="button" class="ou-qtoggle" data-qa-act="expand" aria-expanded="false" title="Show the answer">▸</button>`
      : html`<button type="button" class="ou-qtoggle" data-qa-act="collapse" aria-expanded="true" title="Collapse to the question">▾</button>`;
    const hide = question.dismissed
      ? html`<button type="button" class="ou-linkish" data-qa-act="restore" title="Bring this question back">Restore</button>`
      : html`<button type="button" class="ou-linkish" data-qa-act="dismiss" title="Hide this question and its answer. Show dismissed brings it back.">Dismiss</button>`;
    const answers = !collapsed && answersHtml(question);
    return html`<div class="${classes}" data-qid="${question.id}"><div class="ou-qhead">${toggle}<div class="ou-q">${question.text}</div>${hide}</div><div class="ou-qmeta">${meta}</div>${answers}</div>`;
  }

  function render() {
    const box = $('.ou-questions');
    if (!box) {
      return;
    }
    const onStep = questions.filter(forStep);
    const open = onStep.filter((question) => !question.dismissed);
    const dismissed = onStep.length - open.length;
    if (!onStep.length && !undo) {
      setHtml(box, '');
      return;
    }
    const tools = [
      questions.some((question) => !question.dismissed) &&
        html`<button type="button" class="ou-linkish" data-qa-act="clear" title="Dismiss every question in this story, on every step. Undo or Show dismissed brings them back.">Clear conversation</button>`,
      dismissed > 0 &&
        html`<button type="button" class="ou-linkish" data-qa-act="show-dismissed">${showDismissed ? 'Hide' : 'Show'} dismissed (${dismissed})</button>`,
    ].filter(Boolean);
    const toolLine =
      tools.length > 0 &&
      html`<div class="ou-qtools">${tools.map((tool, i) => html`${i > 0 && ' '}${tool}`)}</div>`;
    const undoLine =
      undo &&
      html`<div class="ou-qundo" role="status">${undo.label} <button type="button" class="ou-linkish" data-qa-act="undo">Undo</button></div>`;
    const shown = showDismissed ? onStep : open;
    setHtml(
      box,
      html`<h2 class="ou-h">Questions${state.n ? ' on this step' : ''} (${open.length})</h2>${toolLine}${undoLine}${shown.map(questionHtml)}`,
    );
  }

  /** Marks the questions here at once, then saves the marks in the bridge and takes its list. */
  async function mark(action, ids) {
    const fields = MARK_FIELDS[action];
    const all = action === 'clear';
    questions = questions.map((question) =>
      all || ids.includes(question.id) ? { ...question, ...fields } : question,
    );
    render();
    if (!opts.markQuestions) {
      return null;
    }
    try {
      const answer = await opts.markQuestions(action, ids);
      if (answer && Array.isArray(answer.questions)) {
        questions = answer.questions;
        render();
      }
      return answer;
    } catch (err) {
      shell.message(`Couldn't save that: ${err && err.message ? err.message : err}`);
      await refresh();
      return null;
    }
  }

  /** A click on a [data-qa-act] button in the questions box (the body's click handler sends it here). */
  async function act(button) {
    const action = button.getAttribute('data-qa-act');
    if (action === 'show-dismissed') {
      showDismissed = !showDismissed;
      render();
      return;
    }
    if (action === 'undo') {
      const ids = undo ? undo.ids : [];
      setUndo(null);
      await mark('restore', ids);
      return;
    }
    if (action === 'clear') {
      const ids = questions
        .filter((question) => !question.dismissed)
        .map((question) => question.id);
      setUndo({ label: `Cleared ${plural(ids.length, 'question')}.`, ids });
      const answer = await mark('clear', ids);
      if (answer && Array.isArray(answer.cleared) && undo) {
        undo.ids = answer.cleared;
      }
      return;
    }
    const item = button.closest('[data-qid]');
    if (!item || !MARK_FIELDS[action]) {
      return;
    }
    const id = item.getAttribute('data-qid');
    if (action === 'dismiss') {
      setUndo({ label: 'Dismissed 1 question.', ids: [id] });
    }
    await mark(action, [id]);
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
    const waiting = questions.some(
      (question) => !question.dismissed && !(question.answers || []).length,
    );
    if (waiting || ticks % SLOW_EVERY === 0) {
      refresh();
    }
  }
  refresh();

  const askForm = $('.ou-ask');
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

  return { render, refresh, poll, act, destroy: () => clearTimeout(undoTimer) };
}
