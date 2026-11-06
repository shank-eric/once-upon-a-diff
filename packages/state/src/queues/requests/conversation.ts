/**
 * The panel's conversation around the inbox's questions: which ones the
 * reviewer dismissed or collapsed, which session each was handed to, and
 * which listener a question goes to.
 *
 *   <home>/state/<story id>/questions.json   {dismissed: {<question id>: at}, collapsed: {<question id>: true},
 *                                             moved: {<question id>: step}, read: {<question id>: when its answer was last read}}
 *
 * `moved` is where a rebuild put a question asked on a chapter it re-told (0: the Overview), so it shows with the
 * chapter that tells its file now (stories/src/rebuild.ts).
 *   <home>/handed.json                       {<question id>: {consumer, at}}, written by `once-upon wait`
 *   <home>/asking.json                       {<question id>: {note, at, by}}, written by `once-upon asking` while a session
 *                                            works on a question, cleared by `once-upon answer`
 *
 * Routing: a question goes to a live listener for its story (`wait --story`)
 * when there is one. A repo-wide or catch-all wait leaves it alone while that
 * story listener is live, and takes it once the story listener is gone. A
 * question already handed to one session, or dismissed, isn't handed to another.
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import { updateJson } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { stateFile, stateFileToWrite } from '@once-upon-a-diff/foundation/settings';
import { STORY_ID_RE } from '@once-upon-a-diff/domain/patterns';
import { listeners, type Listener } from '../../records/listeners/listeners.ts';
import type { Inbox } from './inbox.ts';

/** A story's marks on its questions (questions.json). */
export interface QaMarks {
  dismissed: Record<string, string>;
  collapsed: Record<string, boolean>;
  moved: Record<string, number>;
  /** when the reviewer last read each question's answer: an answer newer than this is unread */
  read: Record<string, string>;
  /** Mark unread was clicked: looking at the answer doesn't read it again until Mark read or Mark all read */
  held: Record<string, string>;
}

export type QaAction = 'dismiss' | 'restore' | 'collapse' | 'expand' | 'read' | 'unread';

/** Who a wait handed each question to (handed.json). */
/** `via` is the relay wait that handed it to the agent `consumer` (binding.ts). */
type Handed = Record<string, { consumer: string; at: string; via?: string }>;

export const QA_ACTIONS: string[] = [
  'dismiss',
  'restore',
  'collapse',
  'expand',
  'read',
  'unread',
] satisfies QaAction[];

const MARKS = 'questions.json';
const marksFile = (home: string, story: string) => stateFile(home, story, MARKS);

/** The story's {dismissed, collapsed, moved} marks, empty for an unknown or odd id. */
export function readQaMarks(home: string, story: string | null | undefined): QaMarks {
  if (!STORY_ID_RE.test(String(story || ''))) {
    return { dismissed: {}, collapsed: {}, moved: {}, read: {}, held: {} };
  }
  const saved = readJson<Partial<QaMarks>>(marksFile(home, story as string), {}) || {};
  return {
    dismissed: saved.dismissed || {},
    collapsed: saved.collapsed || {},
    moved: saved.moved || {},
    read: saved.read || {},
    held: saved.held || {},
  };
}

/** A rebuild moved these questions: {<question id>: step}. */
export function moveQuestions(home: string, story: string, moves: Record<string, number>): void {
  if (!Object.keys(moves).length || !STORY_ID_RE.test(String(story || ''))) {
    return;
  }
  const marks = readQaMarks(home, story);
  Object.assign(marks.moved, moves);
  writeJsonAtomic(stateFileToWrite(home, story, MARKS), marks);
}

/** A time a client says it has seen up to, as the ISO string to keep, or null when it isn't one (or is in the future). */
function seenTime(value: unknown, now: number): string | null {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : new Date(Math.min(time, now)).toISOString();
}

/** What a client adds to a read: the newest answer it showed for each question, and that it was looked at without a click. */
export interface ReadOptions {
  /** {<question id>: the `at` of the newest answer drawn}: the mark is that, not the time the request arrives */
  seen?: Record<string, unknown> | null;
  /** the panel marked it by itself (the answer sat in view), so it leaves a held question alone */
  auto?: boolean;
}

/**
 * Applies one of QA_ACTIONS to the question ids, and returns the marks. A read keeps the newest answer the client says
 * it saw (never the time of the request, so an answer that arrived in between stays unread) and never moves a mark
 * back. An unread holds the question unread until an explicit read.
 */
export function markQuestions(
  home: string,
  story: string,
  action: string,
  ids: string[],
  { seen = null, auto = false }: ReadOptions = {},
): QaMarks {
  if (!QA_ACTIONS.includes(action)) {
    throw new Error(`unknown action ${action}`);
  }
  const marks = readQaMarks(home, story);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  for (const id of ids) {
    if (action === 'dismiss') {
      marks.dismissed[id] = now;
    } else if (action === 'read') {
      if (auto && marks.held[id]) {
        continue;
      }
      const upto = seenTime(seen?.[id], nowMs) ?? now;
      const before = Date.parse(marks.read[id] || '') || 0;
      marks.read[id] = Date.parse(upto) > before ? upto : marks.read[id];
      if (!auto) {
        delete marks.held[id];
      }
    } else if (action === 'unread') {
      marks.read[id] = NEVER_READ; // unread whatever its age
      marks.held[id] = now;
    } else if (action === 'restore') {
      delete marks.dismissed[id];
    } else if (action === 'collapse') {
      marks.collapsed[id] = true;
    } else {
      delete marks.collapsed[id];
    }
  }
  writeJsonAtomic(stateFileToWrite(home, story, MARKS), marks);
  return marks;
}

const handedFile = (home: string) => path.join(home, 'handed.json');

/** {<question id>: {consumer, at}} for every question a wait has handed over. */
export const readHanded = (home: string): Handed => readJson<Handed>(handedFile(home), {}) || {};

/** Notes that `wait` handed these questions to `consumer`, or relayed them to the agent `consumer` as `via`. */
export function noteHanded(home: string, ids: string[], consumer: string, via?: string): void {
  if (!ids.length) {
    return;
  }
  const now = new Date().toISOString();
  updateJson<Handed, void>(handedFile(home), {}, (handed) => {
    for (const id of ids) {
      handed[id] = { consumer, at: now, ...(via ? { via } : {}) };
    }
  });
}

/** The mark `unread` leaves: older than any answer, so the answer is unread whatever its age. */
const NEVER_READ = new Date(0).toISOString();

/** An answer nobody has marked read counts as unread for this long, so old stories don't light up. */
export const UNREAD_DAYS = 7;

/** What a question needs to be judged unread: when it was asked, its answers, and whether it was dismissed. */
interface Judged {
  id: string;
  answers: { at: string }[];
}

/**
 * Whether the question has an answer the reviewer hasn't read: one newer than the question's read mark, or, with no
 * mark, one under UNREAD_DAYS old. A dismissed question has nothing unread.
 */
export function isUnread(question: Judged, marks: QaMarks, now = Date.now()): boolean {
  if (!question.answers.length || marks.dismissed[question.id]) {
    return false;
  }
  const latest = Math.max(...question.answers.map((answer) => Date.parse(answer.at) || 0));
  const mark = marks.read[question.id];
  if (mark) {
    return latest > (Date.parse(mark) || 0);
  }
  return now - latest < UNREAD_DAYS * 24 * 3600 * 1000;
}

/** How many questions of each story have an unread answer: {<story id>: n}, only stories with some. */
export function unreadAnswers(home: string, inbox: Inbox, now = Date.now()): Map<string, number> {
  const counts = new Map<string, number>();
  const marks = new Map<string, QaMarks>();
  for (const question of inbox.questions()) {
    if (!question.answers.length) {
      continue;
    }
    if (!marks.has(question.story)) {
      marks.set(question.story, readQaMarks(home, question.story));
    }
    if (isUnread(question, marks.get(question.story) as QaMarks, now)) {
      counts.set(question.story, (counts.get(question.story) || 0) + 1);
    }
  }
  return counts;
}

// ---------- what a session says it is doing for a question

/** What a session last said about a question it is answering (asking.json). */
type Asking = Record<string, { note: string; at: string; by: string | null }>;

const askingFile = (home: string) => path.join(home, 'asking.json');

export const readAsking = (home: string): Asking => readJson<Asking>(askingFile(home), {}) || {};

/** A session working on a question says what it is up to (`once-upon asking`). */
export function noteAsking(home: string, id: string, note: string, session: string | null): void {
  const asking = readAsking(home);
  asking[id] = { note: note.trim().slice(0, 200), at: new Date().toISOString(), by: session };
  writeJsonAtomic(askingFile(home), asking);
}

/** The question is answered: its note goes. */
export function clearAsking(home: string, id: string): void {
  const asking = readAsking(home);
  if (id in asking) {
    delete asking[id];
    writeJsonAtomic(askingFile(home), asking);
  }
}

/** No word from the session for this long, and its listener not handling the question: it looks abandoned. */
export const STALL_MS = 5 * 60 * 1000;

/**
 * A relayed question the agent hasn't said a word about yet has to wait for the owner session to send it (it may be
 * in the middle of a turn) and for the agent to resume, so it gets longer before it counts as gone quiet.
 */
export const RELAY_STALL_MS = 15 * 60 * 1000;

/** Where an unanswered question stands: queued, being worked on by a session, or worked on and gone quiet. */
export interface QuestionStatus {
  state: 'queued' | 'relaying' | 'working' | 'stalled';
  by: string | null;
  /** the session that relayed it to `by`, the story's agent */
  via: string | null;
  /** when a session took it */
  since: string | null;
  note: string | null;
  note_at: string | null;
}

/**
 * A question's status from what the wait handed over and the session said since. It is working while a listener's beat
 * says it is handling this question (`handling`), or while the handover or the session's last note is under STALL_MS
 * old. A session that took it and went back to waiting, or went away, without answering is stalled once it has been
 * quiet that long. A listener back in `wait` is no sign of work on it. A relayed question is `relaying` until the agent
 * says something (`once-upon asking`), and stalls after RELAY_STALL_MS instead.
 */
export function statusOf(
  handed: Handed[string] | undefined,
  asking: Asking[string] | undefined,
  handling: boolean,
  now = Date.now(),
): QuestionStatus {
  if (!handed && !asking) {
    return { state: 'queued', by: null, via: null, since: null, note: null, note_at: null };
  }
  const signs = [handed?.at, asking?.at].map((time) => Date.parse(time || '') || 0);
  // relayed, and the agent hasn't spoken yet: the owner session still has to send it
  const relaying = !!handed?.via && !asking;
  const quiet = now - Math.max(...signs) > (relaying ? RELAY_STALL_MS : STALL_MS);
  let state: QuestionStatus['state'] = relaying ? 'relaying' : 'working';
  if (quiet && !handling) {
    state = 'stalled';
  }
  return {
    state,
    by: asking?.by || handed?.consumer || null,
    via: handed?.via || null,
    since: handed?.at || asking?.at || null,
    note: asking?.note || null,
    note_at: asking?.at || null,
  };
}

/**
 * The story's questions as the panel shows them: each marked dismissed or collapsed, who it went to, whether its answer
 * is unread, and for one with no answer yet its status. A question a rebuild moved shows on its new step, with the step
 * it was asked on as `asked_on`.
 */
export function withMarks<
  Q extends { id: string; step?: number | null; answers: { at: string }[] },
>(home: string, story: string, questions: Q[], now = Date.now()) {
  const marks = readQaMarks(home, story);
  const handed = readHanded(home);
  const asking = readAsking(home);
  // the questions a live listener says it is handling right now (its beat is `handling`, naming them)
  const handling = new Set(
    listeners(home, now)
      .filter((listener) => listener.live && listener.state === 'handling')
      .flatMap((listener) => [listener.question, ...listener.questions]),
  );
  return questions.map((question) => ({
    ...question,
    ...(question.id in marks.moved
      ? { step: marks.moved[question.id], asked_on: question.step ?? null }
      : {}),
    dismissed: !!marks.dismissed[question.id],
    collapsed: !!marks.collapsed[question.id],
    handed_to: handed[question.id] ? handed[question.id].consumer : null,
    unread: isUnread(question, marks, now),
    read_at: marks.read[question.id] || null,
    held: !!marks.held[question.id],
    status: question.answers.length
      ? null
      : statusOf(handed[question.id], asking[question.id], handling.has(question.id), now),
  }));
}

/**
 * Which of these questions `consumer` (waiting with `scope`, {repo} or {story} or neither) should take now:
 * {take, defer}. Deferred ones belong to a live story listener for now, and the wait looks at them again.
 * Dismissed questions, and ones handed to another session, are dropped. The ones taken are noted handed to `consumer`
 * in the same locked write as the check, so two waits can't both take one.
 */
export function routeQuestions<Q extends { id: string; story: string }>(
  home: string,
  consumer: string,
  scope: { repo?: string | null; story?: string | null },
  questions: Q[],
  { live = null }: { live?: Listener[] | null } = {},
): { take: Q[]; defer: Q[] } {
  const take: Q[] = [];
  const defer: Q[] = [];
  if (!questions.length) {
    return { take, defer };
  }
  const storyListeners = (live || listeners(home)).filter(
    (listener) => listener.live && listener.story && listener.consumer !== consumer,
  );
  updateJson<Handed, void>(handedFile(home), {}, (handed) => {
    const now = new Date().toISOString();
    for (const question of questions) {
      const owner =
        handed[question.id] && (handed[question.id].via || handed[question.id].consumer);
      const elsewhere = owner && owner !== consumer;
      if (elsewhere || readQaMarks(home, question.story).dismissed[question.id]) {
        continue;
      }
      const ownedByStory =
        !scope.story && storyListeners.some((listener) => listener.story === question.story);
      if (ownedByStory) {
        defer.push(question);
      } else {
        take.push(question);
        handed[question.id] ??= { consumer, at: now };
      }
    }
  });
  return { take, defer };
}
