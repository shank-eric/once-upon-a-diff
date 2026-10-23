/**
 * The panel's conversation around the inbox's questions: which ones the
 * reviewer dismissed or collapsed, which session each was handed to, and
 * which listener a question goes to.
 *
 *   <home>/state/<story id>/questions.json   {dismissed: {<question id>: at}, collapsed: {<question id>: true},
 *                                             moved: {<question id>: step}}
 *
 * `moved` is where a rebuild put a question asked on a chapter it re-told (0: the Overview), so it shows with the
 * chapter that tells its file now (../stories/rebuild.ts).
 *   <home>/handed.json                       {<question id>: {consumer, at}}, written by `once-upon wait`
 *
 * Routing: a question goes to a live listener for its story (`wait --story`)
 * when there is one. A repo-wide or catch-all wait leaves it alone while that
 * story listener is live, and takes it once the story listener is gone. A
 * question already handed to one session, or dismissed, isn't handed to another.
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/json-file.ts';
import { stateFile } from '../config/settings.ts';
import { ID_RE } from '../stories/meta.ts';
import { listeners, type Listener } from '../listeners/listeners.ts';

/** A story's marks on its questions (questions.json). */
export interface QaMarks {
  dismissed: Record<string, string>;
  collapsed: Record<string, boolean>;
  moved: Record<string, number>;
}

export type QaAction = 'dismiss' | 'restore' | 'collapse' | 'expand';

/** Who a wait handed each question to (handed.json). */
type Handed = Record<string, { consumer: string; at: string }>;

export const QA_ACTIONS: string[] = [
  'dismiss',
  'restore',
  'collapse',
  'expand',
] satisfies QaAction[];

const marksFile = (home: string, story: string) => stateFile(home, story, 'questions.json');

/** The story's {dismissed, collapsed, moved} marks, empty for an unknown or odd id. */
export function readQaMarks(home: string, story: string | null | undefined): QaMarks {
  if (!ID_RE.test(String(story || ''))) {
    return { dismissed: {}, collapsed: {}, moved: {} };
  }
  const saved = readJson<Partial<QaMarks>>(marksFile(home, story as string), {}) || {};
  return {
    dismissed: saved.dismissed || {},
    collapsed: saved.collapsed || {},
    moved: saved.moved || {},
  };
}

/** A rebuild moved these questions: {<question id>: step}. */
export function moveQuestions(home: string, story: string, moves: Record<string, number>): void {
  if (!Object.keys(moves).length || !ID_RE.test(String(story || ''))) {
    return;
  }
  const marks = readQaMarks(home, story);
  Object.assign(marks.moved, moves);
  writeJsonAtomic(marksFile(home, story), marks);
}

/** Applies one of QA_ACTIONS to the question ids, and returns the marks. */
export function markQuestions(home: string, story: string, action: string, ids: string[]): QaMarks {
  if (!QA_ACTIONS.includes(action)) {
    throw new Error(`unknown action ${action}`);
  }
  const marks = readQaMarks(home, story);
  const now = new Date().toISOString();
  for (const id of ids) {
    if (action === 'dismiss') {
      marks.dismissed[id] = now;
    } else if (action === 'restore') {
      delete marks.dismissed[id];
    } else if (action === 'collapse') {
      marks.collapsed[id] = true;
    } else {
      delete marks.collapsed[id];
    }
  }
  writeJsonAtomic(marksFile(home, story), marks);
  return marks;
}

const handedFile = (home: string) => path.join(home, 'handed.json');

/** {<question id>: {consumer, at}} for every question a wait has handed over. */
export const readHanded = (home: string): Handed => readJson<Handed>(handedFile(home), {}) || {};

/** Notes that `wait` handed these questions to `consumer`. */
export function noteHanded(home: string, ids: string[], consumer: string): void {
  if (!ids.length) {
    return;
  }
  const handed = readHanded(home);
  const now = new Date().toISOString();
  for (const id of ids) {
    handed[id] = { consumer, at: now };
  }
  writeJsonAtomic(handedFile(home), handed);
}

/**
 * The story's questions as the panel shows them: each marked dismissed or collapsed, and who it went to. A question a
 * rebuild moved shows on its new step, with the step it was asked on as `asked_on`.
 */
export function withMarks<Q extends { id: string; step?: number | null }>(
  home: string,
  story: string,
  questions: Q[],
) {
  const marks = readQaMarks(home, story);
  const handed = readHanded(home);
  return questions.map((question) => ({
    ...question,
    ...(question.id in marks.moved
      ? { step: marks.moved[question.id], asked_on: question.step ?? null }
      : {}),
    dismissed: !!marks.dismissed[question.id],
    collapsed: !!marks.collapsed[question.id],
    handed_to: handed[question.id] ? handed[question.id].consumer : null,
  }));
}

/**
 * Which of these questions `consumer` (waiting with `scope`, {repo} or {story} or neither) should take now:
 * {take, defer}. Deferred ones belong to a live story listener for now, and the wait looks at them again.
 * Dismissed questions, and ones handed to another session, are dropped.
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
  const handed = readHanded(home);
  const storyListeners = (live || listeners(home)).filter(
    (listener) => listener.live && listener.story && listener.consumer !== consumer,
  );
  for (const question of questions) {
    const elsewhere = handed[question.id] && handed[question.id].consumer !== consumer;
    if (elsewhere || readQaMarks(home, question.story).dismissed[question.id]) {
      continue;
    }
    const ownedByStory =
      !scope.story && storyListeners.some((listener) => listener.story === question.story);
    (ownedByStory ? defer : take).push(question);
  }
  return { take, defer };
}
