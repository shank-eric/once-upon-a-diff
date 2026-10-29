/*
 * The pure parts of the questions dock's list. The list is the whole story's:
 * every question asked on any step is in it, each labelled with the step it
 * was asked on, and the ones from the step on screen are marked.
 */
import type { Answer, Question } from '../types.ts';

/** A chapter's number and title are all the label needs. */
type Titled = { title: string };

/** Where a question was asked: "Overview" for step 0, else "Chapter N: title" (just "Chapter N" when the story has no such chapter). */
export function questionStepLabel(question: Pick<Question, 'step'>, chapters: Titled[]): string {
  const step = Number(question.step);
  if (!Number.isInteger(step) || step <= 0) {
    return 'Overview';
  }
  const title = chapters[step - 1]?.title;
  return title ? `Chapter ${step}: ${title}` : `Chapter ${step}`;
}

/** Is this question from the step on screen? The Overview (0) is a step too. */
export const askedOnStep = (question: Pick<Question, 'step'>, step: number): boolean =>
  Number(question.step) === step;

/** A session has the question and has not answered it yet. */
const isWorking = (question: Question) =>
  !(question.answers || []).length && question.status?.state === 'working';

/**
 * What the dock's header and tools count: every question in the story, those still open, those a session is working on,
 * those waiting for one to pick them up (or that went quiet), answers nobody has read, and dismissed ones.
 */
export function questionTotals(list: Question[]) {
  const open = list.filter((question) => !question.dismissed);
  const unanswered = open.filter((question) => !(question.answers || []).length);
  const working = unanswered.filter(isWorking).length;
  return {
    open: open.length,
    waiting: unanswered.length - working,
    working,
    unread: open.filter((question) => question.unread).length,
    dismissed: list.length - open.length,
  };
}

/** 0:42, 12:03 or 1:02:03: how long a session has been on a question. */
export function elapsedText(millis: number): string {
  const total = Math.max(0, Math.floor(millis / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The line under a question with no answer: what a session says it is doing, that none has it yet, or that the one
 * that had it went quiet. `listening` is the status light's word on whether a session is listening at all (null: not
 * known yet).
 */
export function waitingText(
  question: Pick<Question, 'handed_to' | 'status'>,
  { listening = null, quietAt = '' }: { listening?: boolean | null; quietAt?: string } = {},
): { state: 'queued' | 'working' | 'stalled'; text: string; note: string | null } {
  const status = question.status;
  const session = status?.by || question.handed_to || 'the Claude session';
  if (status?.state === 'working') {
    return { state: 'working', text: `${session} is working on it`, note: status.note };
  }
  if (status?.state === 'stalled') {
    return {
      state: 'stalled',
      text: `${session} took it${quietAt ? ` and has been quiet since ${quietAt}` : ' and has gone quiet'}. No session will pick it up again: ask it again, or dismiss it.`,
      note: status.note,
    };
  }
  // queued, or an older bridge that gives no status: handed over means a session has it
  if (question.handed_to) {
    return {
      state: 'working',
      text: `Waiting for an answer from ${question.handed_to}`,
      note: null,
    };
  }
  return {
    state: 'queued',
    text:
      listening === false
        ? 'Queued. No Claude session is listening yet.'
        : 'Queued. No session has picked it up yet.',
    note: null,
  };
}

const timeOf = (when: string | null | undefined): number => Date.parse(when || '') || 0;

/** The answers of a question the reviewer hasn't read: those after its read mark, or all of them when it has none. */
export function unreadAnswersOf(question: Pick<Question, 'answers' | 'read_at'>): Answer[] {
  const mark = timeOf(question.read_at);
  return (question.answers || [])
    .filter((answer) => timeOf(answer.at) > mark)
    .sort((first, second) => timeOf(first.at) - timeOf(second.at));
}

/** The newest answer's time: what a read of the question says it saw. */
export function latestAnswerAt(question: Pick<Question, 'answers'>): string | null {
  const answers = [...(question.answers || [])].sort(
    (first, second) => timeOf(second.at) - timeOf(first.at),
  );
  return answers[0]?.at ?? null;
}

/** The question as it stands once its answers up to `upto` are read: the mark moves up, and it is unread only if a later answer exists. */
export function withRead(question: Question, upto: string): Question {
  const mark = Math.max(timeOf(upto), timeOf(question.read_at));
  const readAt = new Date(mark).toISOString();
  return {
    ...question,
    read_at: readAt,
    unread:
      !question.dismissed && (question.answers || []).some((answer) => timeOf(answer.at) > mark),
  };
}

/**
 * How far a question's read mark may move, from the unread answers the reviewer has looked at (`confirmed`, by answer
 * time): the newest answer of the run of unread answers, from the oldest on, that all were looked at. An older answer
 * in view never reads a newer one that wasn't; a newer one looked at while an older one wasn't waits for it. null when
 * the oldest unread answer hasn't been looked at.
 */
export function readUpTo(
  question: Pick<Question, 'answers' | 'read_at'>,
  confirmed: ReadonlySet<string>,
): string | null {
  let upto: string | null = null;
  for (const answer of unreadAnswersOf(question)) {
    if (!confirmed.has(answer.at)) {
      break;
    }
    upto = answer.at;
  }
  return upto;
}

/** One unread answer on the page: its question and its time. */
export interface AnswerRef {
  question: string;
  at: string;
}

/** The timer functions, so a test can drive them. */
export interface WatchTimers {
  set(run: () => void, millis: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Reading by looking: an unread answer that stays in view for `afterMs` (while `canRead`: the tab showing, the dock open)
 * counts as looked at, and once the oldest unread answers of its question up to it all have, `onRead(question, upto)` says
 * how far to mark. Timers are per answer, so a redraw or another answer's read doesn't restart them: `keep` (the answers
 * on the page after a draw) drops only those of answers that went away.
 */
export function createReadWatch({
  afterMs,
  canRead,
  find,
  onRead,
  timers = {
    set: (run, millis) => setTimeout(run, millis),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
}: {
  afterMs: number;
  canRead: () => boolean;
  find: (question: string) => Question | undefined;
  onRead: (question: string, upto: string) => void;
  timers?: WatchTimers;
}) {
  const pending = new Map<string, unknown>();
  const confirmed = new Map<string, Set<string>>();
  const keyOf = (ref: AnswerRef) => `${ref.question}|${ref.at}`;
  return {
    /** These are the unread answers on the page now: anything else's timer goes. */
    keep(refs: AnswerRef[]) {
      const keys = new Set(refs.map(keyOf));
      for (const [key, handle] of pending) {
        if (!keys.has(key)) {
          timers.clear(handle);
          pending.delete(key);
        }
      }
    },
    /** The answer came into view enough (yes) or left it. */
    inView(ref: AnswerRef, yes: boolean) {
      const key = keyOf(ref);
      if (!yes) {
        if (pending.has(key)) {
          timers.clear(pending.get(key));
          pending.delete(key);
        }
        return;
      }
      if (pending.has(key)) {
        return; // already counting
      }
      pending.set(
        key,
        timers.set(() => {
          pending.delete(key);
          if (!canRead()) {
            return;
          }
          const looked = confirmed.get(ref.question) ?? new Set<string>();
          looked.add(ref.at);
          confirmed.set(ref.question, looked);
          const question = find(ref.question);
          const upto = question ? readUpTo(question, looked) : null;
          if (upto) {
            confirmed.delete(ref.question);
            onRead(ref.question, upto);
          }
        }, afterMs),
      );
    },
    stop() {
      for (const handle of pending.values()) {
        timers.clear(handle);
      }
      pending.clear();
    },
    pending: () => pending.size,
  };
}

/** A typed but unsent question kept across a remount of the panel (a story redraw), by story. */
const drafts = new Map<string, string>();

export const askDrafts = {
  keep(storyId: string, text: string) {
    if (text.trim()) {
      drafts.set(storyId, text);
    } else {
      drafts.delete(storyId);
    }
  },
  take(storyId: string): string {
    return drafts.get(storyId) || '';
  },
  forget(storyId: string) {
    drafts.delete(storyId);
  },
};
