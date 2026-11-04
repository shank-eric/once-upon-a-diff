/*
 * Questions, in the dock at the bottom of the panel (chat-dock.ts): the Ask
 * box sends one through opts.ask (to the bridge inbox),
 * and the story's questions and their answers (every step's, each labelled
 * with its chapter, the current chapter's marked) come back through
 * opts.loadQuestions on the overlay's tick: every 5s while one is waiting,
 * otherwise every 30s, and when the tab gets focus again.
 *
 * A question with no answer says where it stands under its line: queued, or
 * which session is working on it, for how long, and the last note it left
 * (once-upon asking). An answer nobody has read is marked New. It becomes
 * read, in the bridge, once it has been in view in the open dock for a moment
 * (READ_AFTER_MS), per answer: an older answer in view never reads a newer one off screen. The mark says which answer
 * the panel drew, not when the request arrived. Mark read and Mark all read do it by hand, and Mark unread holds an answer
 * unread (in the bridge) until one of those.
 *
 * Each exchange collapses to its question line and can be dismissed, and
 * Clear conversation dismisses every question in the story. Dismissed ones
 * hide behind "Show dismissed", with Restore, and the last dismissal can be
 * undone for a few seconds. opts.markQuestions saves those marks in the
 * bridge, so they hold after a reload and on the next poll.
 */
import { html } from '@once-upon-a-diff/protocol/domain/html';
import { setHtml } from '../dom.ts';
import { baseName, plural } from '@once-upon-a-diff/protocol/domain/text';
import { clockTime, shortDateTime } from '@once-upon-a-diff/protocol/domain/time';
import type { PanelContext } from '../context.ts';
import type {
  Question,
  QuestionMark,
  QuestionMarkExtra,
  QuestionMarksAnswer,
} from '@once-upon-a-diff/protocol/types';
import {
  askDrafts,
  askedOnStep,
  createReadWatch,
  elapsedText,
  latestAnswerAt,
  questionStepLabel,
  questionTotals,
  unreadAnswersOf,
  waitingText,
  withRead,
} from './question-list.ts';

const SLOW_EVERY = 6; // ticks: 6 x 5s = every 30s with nothing waiting
const UNDO_MS = 15000;
/** How long an answer has to sit in view, in the open dock, before it counts as read. */
const READ_AFTER_MS = 1500;

/** What one mark action does to a question, for drawing it before the bridge answers. */
const MARK_FIELDS: Record<QuestionMark, Partial<Question>> = {
  dismiss: { dismissed: true, unread: false },
  clear: { dismissed: true, unread: false },
  read: {}, // drawn by withRead, from what the panel says it saw
  read_all: {},
  unread: { unread: true, held: true },
  restore: { dismissed: false },
  collapse: { collapsed: true },
  expand: { collapsed: false },
};

export function createQuestions(context: PanelContext) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let questions: Question[] = [];
  let showDismissed = false;
  let undo: { label: string; ids: string[] } | null = null; // after a dismissal, until UNDO_MS passes or the next one
  let undoTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let observer: IntersectionObserver | null = null; // watches unread answers for coming into view
  const watch = createReadWatch({
    afterMs: READ_AFTER_MS,
    canRead: () => document.visibilityState === 'visible' && state.chatOpen,
    find: (id) => questions.find((question) => question.id === id),
    onRead: (id, upto) => {
      mark('read', [id], { seen: { [id]: upto }, auto: true });
    },
  });

  function setUndo(next: { label: string; ids: string[] } | null) {
    clearTimeout(undoTimer);
    undo = next;
    if (next) {
      undoTimer = setTimeout(() => {
        undo = null;
        render();
      }, UNDO_MS);
    }
  }

  /** The line under a question with no answer: queued, or which session is on it, how long, and its last note. */
  function waitingHtml(question: Question) {
    const health = context.statusLight.current;
    const status = question.status;
    const quietAt = status?.note_at || status?.since;
    const line = waitingText(question, {
      listening: health ? !!health.listening : null,
      quietAt: quietAt ? clockTime(quietAt) : '',
    });
    const since = line.state === 'working' && status?.since;
    const elapsed =
      since &&
      html` · <span class="ou-elapsed" data-since="${since}">${elapsedText(Date.now() - Date.parse(since))}</span>`;
    const pulse =
      line.state === 'working' && html`<span class="ou-pulse" aria-hidden="true"></span>`;
    const note = line.note && html`<div class="ou-wnote">${line.note}</div>`;
    return html`<div class="ou-wait ou-wait-${line.state}" role="status">${pulse}${line.text}${elapsed}${note}</div>`;
  }

  function answersHtml(question: Question) {
    const answers = question.answers || [];
    if (!answers.length) {
      return waitingHtml(question);
    }
    // only the unread answers of a question that isn't held unread are watched for coming into view (data-aat)
    const watched = new Set(
      question.unread && !question.held ? unreadAnswersOf(question).map((answer) => answer.at) : [],
    );
    return answers.map((answer) => {
      const answeredBy = answer.by && html`<div class="ou-aby">Answered by ${answer.by}</div>`;
      const aat = watched.has(answer.at) ? answer.at : null;
      return html`${answeredBy}<div class="ou-a ou-md"${aat && html` data-aat="${aat}"`}>${context.refs.withRefs(answer.refs, () => context.markdown.markdown(answer.text))}</div>`;
    });
  }

  function questionHtml(question: Question) {
    const when = shortDateTime(question.at);
    const where = [
      questionStepLabel(question, context.steps()),
      question.file ? baseName(question.file) : '',
    ]
      .filter(Boolean)
      .join(', ');
    const answerCount = (question.answers || []).length;
    const collapsed = !!question.collapsed;
    const meta = [
      when,
      where,
      question.channel === 'voice' ? 'By voice' : '',
      collapsed && answerCount ? plural(answerCount, 'answer') : '',
      question.unread ? 'New answer' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const classes = [
      'ou-qa',
      askedOnStep(question, state.n) && 'ou-qa-here',
      collapsed && 'ou-qa-collapsed',
      question.dismissed && 'ou-qa-dismissed',
      question.unread && 'ou-qa-new',
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
    let keep: unknown = '';
    if (answerCount > 0 && !question.dismissed) {
      keep = question.unread
        ? html` <button type="button" class="ou-linkish" data-qa-act="read" title="Mark this answer as read">Mark read</button>`
        : html` <button type="button" class="ou-linkish" data-qa-act="unread" title="Keep this answer flagged as unread until you mark it read">Mark unread</button>`;
    }
    return html`<div class="${classes}" data-qid="${question.id}"><div class="ou-qhead">${toggle}<div class="ou-q">${question.text}</div>${hide}</div><div class="ou-qmeta">${meta}${keep as string}</div>${answers}</div>`;
  }

  function render() {
    context.chatDock.redraw(draw);
  }

  function draw() {
    const box = $('.ou-questions')!;
    const scroller = box.parentElement!;
    const kept = scroller.scrollTop;
    const { open: openCount, waiting, working, unread, dismissed } = questionTotals(questions);
    context.chatDock.setCounts({ open: openCount, waiting, working, unread });
    if (!questions.length && !undo) {
      setHtml(box, html`<p class="ou-quiet">No questions on this story yet.</p>`);
      return;
    }
    const tools = [
      unread > 0 &&
        html`<button type="button" class="ou-linkish" data-qa-act="read-all" title="Mark every answer in this story as read">Mark all read</button>`,
      openCount > 0 &&
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
    const shown = showDismissed ? questions : questions.filter((question) => !question.dismissed);
    setHtml(box, html`${toolLine}${undoLine}${shown.map(questionHtml)}`);
    context.viewed.markDock(); // an answer's Mark viewed buttons say where their file's toggle stands
    scroller.scrollTop = kept; // a step change redraws the marks, not the place you were reading
    watchUnread();
  }

  function stopWatching() {
    observer?.disconnect();
    observer = null;
  }

  /** Is enough of this answer in the dock's scroll area to count as looked at (half of it, or half the area for a long one)? */
  const inView = (entry: IntersectionObserverEntry) =>
    entry.isIntersecting &&
    (entry.intersectionRatio >= 0.5 ||
      entry.intersectionRect.height >= (entry.rootBounds ? entry.rootBounds.height : Infinity) / 2);

  /**
   * Watches the unread answers on the page: one that sits in view for READ_AFTER_MS, tab showing and dock open, counts as
   * looked at (createReadWatch). Looks again after every draw and when the tab comes back; the answers' timers carry
   * over, so a redraw doesn't restart them.
   */
  function watchUnread() {
    stopWatching();
    if (typeof IntersectionObserver === 'undefined' || !opts.markQuestions) {
      watch.stop();
      return;
    }
    const scroller = $('.ou-questions')!.parentElement!;
    const targets = [...scroller.querySelectorAll<HTMLElement>('.ou-qa[data-qid] .ou-a[data-aat]')];
    const refOf = (target: Element) => ({
      question: target.closest('[data-qid]')?.getAttribute('data-qid') || '',
      at: target.getAttribute('data-aat') || '',
    });
    watch.keep(targets.map(refOf));
    if (!targets.length) {
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          watch.inView(refOf(entry.target), inView(entry));
        }
      },
      { root: scroller, threshold: [0, 0.5, 1] },
    );
    targets.forEach((target) => observer!.observe(target));
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      watchUnread();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  // a working question's elapsed time ticks on its own, without redrawing the list
  const elapsedTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    $('.ou-questions')
      ?.querySelectorAll<HTMLElement>('.ou-elapsed[data-since]')
      .forEach((span) => {
        span.textContent = elapsedText(Date.now() - Date.parse(span.getAttribute('data-since')!));
      });
  }, 1000);

  /** {<question id>: its newest answer's time}: how far a read of these questions goes. */
  const seenOf = (list: Question[]): Record<string, string> =>
    Object.fromEntries(
      list.flatMap((question) => {
        const latest = latestAnswerAt(question);
        return latest ? [[question.id, latest]] : [];
      }),
    );

  /** Marks the questions here at once, then saves the marks in the bridge and takes its list. */
  async function mark(
    action: QuestionMark,
    ids: string[],
    extra: QuestionMarkExtra = {},
  ): Promise<QuestionMarksAnswer | null> {
    const fields = MARK_FIELDS[action];
    const all = action === 'clear';
    const reading = action === 'read' || action === 'read_all';
    questions = questions.map((question) => {
      if (!(all || ids.includes(question.id))) {
        return question;
      }
      const seen = extra.seen?.[question.id];
      if (reading) {
        return seen ? withRead(question, seen) : question;
      }
      return { ...question, ...fields };
    });
    render();
    if (!opts.markQuestions) {
      return null;
    }
    try {
      const answer = await opts.markQuestions(action, ids, extra);
      if (answer && Array.isArray(answer.questions)) {
        questions = answer.questions;
        render();
      }
      return answer;
    } catch (err) {
      shell.message(
        `Couldn't save that: ${err && (err as Error).message ? (err as Error).message : err}`,
      );
      await refresh();
      return null;
    }
  }

  /** A click on a [data-qa-act] button in the questions box (the body's click handler sends it here). */
  async function act(button: Element) {
    const action = button.getAttribute('data-qa-act') as
      QuestionMark | 'show-dismissed' | 'undo' | 'read-all';
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
    if (action === 'read-all') {
      // what the panel has drawn: an answer that comes in while this is on its way stays unread
      const drawn = questions.filter((question) => question.unread);
      await mark(
        'read_all',
        drawn.map((question) => question.id),
        { seen: seenOf(drawn) },
      );
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
    const id = item.getAttribute('data-qid') as string;
    if (action === 'dismiss') {
      setUndo({ label: 'Dismissed 1 question.', ids: [id] });
    }
    const asked = questions.find((question) => question.id === id);
    await mark(action, [id], action === 'read' && asked ? { seen: seenOf([asked]) } : {});
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
  function poll(ticks: number) {
    const waiting = questions.some(
      (question) => !question.dismissed && !(question.answers || []).length,
    );
    if (waiting || ticks % SLOW_EVERY === 0) {
      refresh();
    }
  }
  refresh();

  const askForm = $<HTMLFormElement>('.ou-ask')!;
  const askText = askForm.querySelector('textarea') as HTMLTextAreaElement;
  // a typed question survives the panel being redrawn under it (the story changed on disk, a setting flipped)
  const storyId = String(context.story.data.id || '');
  askText.value = askDrafts.take(storyId);
  askText.addEventListener('input', () => askDrafts.keep(storyId, askText.value));
  askForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = askText.value.trim();
    if (!text || !opts.ask) {
      return;
    }
    const button = askForm.querySelector('button') as HTMLButtonElement;
    button.disabled = true;
    try {
      await opts.ask({
        text,
        step: state.n,
        chapter: context.navigation.stepLabel(),
        file: context.navigation.topFile || context.page.fileAtTop(),
      });
      askText.value = '';
      askDrafts.forget(storyId);
      const health = context.statusLight.current;
      shell.message(
        health && !health.listening
          ? 'Queued in the bridge inbox. No Claude session is listening yet, so it will wait.'
          : 'Sent to the bridge inbox.',
      );
      await refresh();
      context.chatDock.scrollToLatest();
    } catch (err) {
      shell.message(
        `Couldn't send the question: ${err && (err as Error).message ? (err as Error).message : err}`,
      );
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

  return {
    render,
    refresh,
    poll,
    act,
    destroy: () => {
      clearTimeout(undoTimer);
      clearInterval(elapsedTimer);
      stopWatching();
      watch.stop();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

export type Questions = ReturnType<typeof createQuestions>;
