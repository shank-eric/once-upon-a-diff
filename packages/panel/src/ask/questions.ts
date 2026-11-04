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
 *
 * The list is drawn by view() from a model that render() works out when the questions change (the answers' markdown
 * included, as before: a file's pill goes on its first mention in a step), and the Ask box by askView().
 */
import { Fragment, html } from '/assets/preact.mjs';
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
  latestAnswerAt,
  questionStepLabel,
  questionTotals,
  unreadAnswersOf,
  waitingText,
  withRead,
} from './question-list.ts';
import { Elapsed, type Clock } from '@once-upon-a-diff/ui/elapsed';

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

/** What a button in the list does: a mark on one question, or one of the list's own. */
type Act = QuestionMark | 'show-dismissed' | 'undo' | 'read-all';

/** One answer, as the list draws it: its markup is made once, when the questions change. */
interface AnswerRow {
  at: string;
  by: string | null | undefined;
  /** an unread answer of a question that isn't held unread: watched for coming into view (data-aat) */
  watched: boolean;
  markup: string;
}

/** The line under a question with no answer. */
interface WaitRow {
  state: string;
  text: string;
  note: string | null | undefined;
  since: string | null;
}

/** One question, with what its row draws. */
interface Row {
  question: Question;
  classes: string;
  meta: string;
  collapsed: boolean;
  answers: AnswerRow[];
  wait: WaitRow | null;
  /** 'read' or 'unread': the button that keeps the answer, or none */
  keep: 'read' | 'unread' | null;
}

/** The list as drawn: worked out in render() from the questions, the step and the undo line. */
interface Model {
  empty: boolean;
  tools: { unread: boolean; open: boolean; dismissed: number; showDismissed: boolean };
  undo: string | null;
  rows: Row[];
}

export function createQuestions(context: PanelContext) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let questions: Question[] = [];
  let showDismissed = false;
  let undo: { label: string; ids: string[] } | null = null; // after a dismissal, until UNDO_MS passes or the next one
  let undoTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let observer: IntersectionObserver | null = null; // watches unread answers for coming into view
  let model: Model | null = null;
  let sending = false; // the Ask box's question is on its way
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

  /** What the line under a question with no answer says: queued, or which session is on it, how long, and its last note. */
  function waitRow(question: Question): WaitRow {
    const health = context.statusLight.current;
    const status = question.status;
    const quietAt = status?.note_at || status?.since;
    const line = waitingText(question, {
      listening: health ? !!health.listening : null,
      quietAt: quietAt ? clockTime(quietAt) : '',
    });
    return {
      state: line.state,
      text: line.text,
      note: line.note,
      since: (line.state === 'working' && status?.since) || null,
    };
  }

  function answerRows(question: Question): AnswerRow[] {
    // only the unread answers of a question that isn't held unread are watched for coming into view (data-aat)
    const watched = new Set(
      question.unread && !question.held ? unreadAnswersOf(question).map((answer) => answer.at) : [],
    );
    return (question.answers || []).map((answer) => ({
      at: answer.at,
      by: answer.by,
      watched: watched.has(answer.at),
      markup: String(
        context.refs.withRefs(answer.refs, () => context.markdown.markdown(answer.text)),
      ),
    }));
  }

  function rowOf(question: Question): Row {
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
    let keep: Row['keep'] = null;
    if (answerCount > 0 && !question.dismissed) {
      keep = question.unread ? 'read' : 'unread';
    }
    const open = !collapsed;
    return {
      question,
      classes,
      meta,
      collapsed,
      answers: open ? answerRows(question) : [],
      wait: open && !answerCount ? waitRow(question) : null,
      keep,
    };
  }

  /** Works out what the list draws from the questions: the counts go to the dock's header. */
  function build(): Model {
    const totals = questionTotals(questions);
    context.chatDock.setCounts({
      open: totals.open,
      waiting: totals.waiting,
      working: totals.working,
      unread: totals.unread,
    });
    context.refs.startAnswers();
    const shown = showDismissed ? questions : questions.filter((question) => !question.dismissed);
    return {
      empty: !questions.length && !undo,
      tools: {
        unread: totals.unread > 0,
        open: totals.open > 0,
        dismissed: totals.dismissed,
        showDismissed,
      },
      undo: undo ? undo.label : null,
      rows: shown.map(rowOf),
    };
  }

  /** The questions' own clock: a tick a second while the tab shows, for the elapsed times to count up. Stopped with the panel. */
  const listeners = new Set<() => void>();
  const clock: Clock = {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const elapsedTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      listeners.forEach((listener) => listener());
    }
  }, 1000);

  const nodes = (markupText: string) => context.markup.nodes(markupText);

  function waitView(wait: WaitRow) {
    const pulse =
      wait.state === 'working' && html`<span class="ou-pulse" aria-hidden="true"></span>`;
    const elapsed =
      wait.since && html` · <${Elapsed} since=${wait.since} clock=${clock} class="ou-elapsed" />`;
    const note = wait.note && html`<div class="ou-wnote">${wait.note}</div>`;
    return html`<div class=${`ou-wait ou-wait-${wait.state}`} role="status">${pulse}${wait.text}${elapsed}${note}</div>`;
  }

  function rowView(row: Row) {
    const { question } = row;
    const id = question.id;
    const toggle = row.collapsed
      ? html`<button type="button" class="ou-qtoggle" data-qa-act="expand" aria-expanded="false" title="Show the answer" onClick=${() => act('expand', id)}>▸</button>`
      : html`<button type="button" class="ou-qtoggle" data-qa-act="collapse" aria-expanded="true" title="Collapse to the question" onClick=${() => act('collapse', id)}>▾</button>`;
    const hide = question.dismissed
      ? html`<button type="button" class="ou-linkish" data-qa-act="restore" title="Bring this question back" onClick=${() => act('restore', id)}>Restore</button>`
      : html`<button type="button" class="ou-linkish" data-qa-act="dismiss" title="Hide this question and its answer. Show dismissed brings it back." onClick=${() => act('dismiss', id)}>Dismiss</button>`;
    let keep = null;
    if (row.keep === 'read') {
      keep = html`${' '}<button type="button" class="ou-linkish" data-qa-act="read" title="Mark this answer as read" onClick=${() => act('read', id)}>Mark read</button>`;
    } else if (row.keep === 'unread') {
      keep = html`${' '}<button type="button" class="ou-linkish" data-qa-act="unread" title="Keep this answer flagged as unread until you mark it read" onClick=${() => act('unread', id)}>Mark unread</button>`;
    }
    const answers = row.answers.map(
      (answer) =>
        html`${answer.by && html`<div class="ou-aby">Answered by ${answer.by}</div>`}<div class="ou-a ou-md" data-aat=${answer.watched ? answer.at : undefined}>${nodes(answer.markup)}</div>`,
    );
    return html`<div class=${row.classes} data-qid=${id} key=${id}><div class="ou-qhead">${toggle}<div class="ou-q">${question.text}</div>${hide}</div><div class="ou-qmeta">${row.meta}${keep}</div>${answers}${row.wait && waitView(row.wait)}</div>`;
  }

  /** The list, under the dock's header: the tools, the undo line and each question (null until the questions are drawn). */
  function view() {
    if (!model) {
      return null;
    }
    if (model.empty) {
      return html`<p class="ou-quiet">No questions on this story yet.</p>`;
    }
    const { tools } = model;
    // keyed, so a button that goes does not hand its element to the next one
    const buttons = [
      tools.unread && {
        key: 'read-all',
        node: html`<button type="button" class="ou-linkish" data-qa-act="read-all" title="Mark every answer in this story as read" onClick=${() => act('read-all')}>Mark all read</button>`,
      },
      tools.open && {
        key: 'clear',
        node: html`<button type="button" class="ou-linkish" data-qa-act="clear" title="Dismiss every question in this story, on every step. Undo or Show dismissed brings them back." onClick=${() => act('clear')}>Clear conversation</button>`,
      },
      tools.dismissed > 0 && {
        key: 'show-dismissed',
        node: html`<button type="button" class="ou-linkish" data-qa-act="show-dismissed" onClick=${() => act('show-dismissed')}>${tools.showDismissed ? 'Hide' : 'Show'} dismissed (${tools.dismissed})</button>`,
      },
    ].filter((tool) => !!tool);
    const toolLine =
      buttons.length > 0 &&
      html`<div class="ou-qtools">${buttons.map((tool, i) => html`<${Fragment} key=${tool.key}>${i > 0 && ' '}${tool.node}</${Fragment}>`)}</div>`;
    const undoLine =
      model.undo &&
      html`<div class="ou-qundo" role="status">${model.undo} <button type="button" class="ou-linkish" data-qa-act="undo" onClick=${() => act('undo')}>Undo</button></div>`;
    return html`${toolLine}${undoLine}${model.rows.map(rowView)}`;
  }

  /** Works the list out from the questions and draws it, keeping you at the end of the conversation if you were there. */
  function render() {
    model = build();
    context.chatDock.redraw(() => {
      shell.redraw();
      watchUnread();
    });
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
    const box = $('.ou-questions')?.parentElement;
    if (typeof IntersectionObserver === 'undefined' || !opts.markQuestions || !box) {
      watch.stop();
      return;
    }
    const targets = [...box.querySelectorAll<HTMLElement>('.ou-qa[data-qid] .ou-a[data-aat]')];
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
      { root: box, threshold: [0, 0.5, 1] },
    );
    targets.forEach((target) => observer!.observe(target));
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      watchUnread();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

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

  /** A click on one of the list's buttons: `id` is the question it is on. */
  async function act(action: Act, id?: string) {
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
    if (id === undefined || !MARK_FIELDS[action]) {
      return;
    }
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

  // ---------- the Ask box
  // a typed question survives the panel being redrawn under it (the story changed on disk, a setting flipped)
  const storyId = String(context.story.data.id || '');
  let askText: HTMLTextAreaElement | null = null;
  /** Called with the Ask box's textarea when it first goes on the page: puts back what was typed and not sent. */
  const seedAsk = (textarea: HTMLTextAreaElement | null) => {
    if (textarea && textarea !== askText) {
      textarea.value = askDrafts.take(storyId);
    }
    askText = textarea;
  };

  async function send(event: Event) {
    event.preventDefault();
    const text = (askText?.value ?? '').trim();
    if (!text || !opts.ask || !askText) {
      return;
    }
    sending = true;
    shell.redraw();
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
      sending = false;
      shell.redraw();
    }
  }

  /** The Ask box under the list. */
  function askView() {
    return html`<form class=${opts.ask ? 'ou-ask' : 'ou-ask ou-off'} onSubmit=${send}>
          <textarea placeholder="Ask about this step. The list above holds the whole story (Cmd+Enter sends it to the bridge inbox)" rows="1" aria-label="Question" ref=${seedAsk} onInput=${() => askDrafts.keep(storyId, askText?.value ?? '')} onKeyDown=${(
            event: KeyboardEvent,
          ) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              (event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
            }
          }}></textarea>
          <button type="submit" disabled=${sending}>Ask</button>
        </form>`;
  }

  return {
    render,
    view,
    askView,
    refresh,
    poll,
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
