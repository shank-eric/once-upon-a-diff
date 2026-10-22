/**
 * The panel's conversation around the inbox's questions: which ones the
 * reviewer dismissed or collapsed, which session each was handed to, and
 * which listener a question goes to.
 *
 *   <home>/state/<story id>/questions.json   {dismissed: {<question id>: at}, collapsed: {<question id>: true}}
 *   <home>/handed.json                       {<question id>: {consumer, at}}, written by `once-upon wait`
 *
 * Routing: a question goes to a live listener for its story (`wait --story`)
 * when there is one. A repo-wide or catch-all wait leaves it alone while that
 * story listener is live, and takes it once the story listener is gone. A
 * question already handed to one session, or dismissed, isn't handed to another.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/json-file.mjs';
import { ID_RE } from '../stories/meta.mjs';
import { listeners } from '../listeners/listeners.mjs';

export const QA_ACTIONS = ['dismiss', 'restore', 'collapse', 'expand'];

const marksFile = (home, story) => path.join(home, 'state', story, 'questions.json');

/** The story's {dismissed, collapsed} marks, empty for an unknown or odd id. */
export function readQaMarks(home, story) {
  if (!ID_RE.test(String(story || ''))) {
    return { dismissed: {}, collapsed: {} };
  }
  const saved = readJson(marksFile(home, story), {}) || {};
  return { dismissed: saved.dismissed || {}, collapsed: saved.collapsed || {} };
}

/** Applies one of QA_ACTIONS to the question ids, and returns the marks. */
export function markQuestions(home, story, action, ids) {
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
  mkdirSync(path.dirname(marksFile(home, story)), { recursive: true });
  writeJsonAtomic(marksFile(home, story), marks);
  return marks;
}

const handedFile = (home) => path.join(home, 'handed.json');

/** {<question id>: {consumer, at}} for every question a wait has handed over. */
export const readHanded = (home) => readJson(handedFile(home), {}) || {};

/** Notes that `wait` handed these questions to `consumer`. */
export function noteHanded(home, ids, consumer) {
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

/** The story's questions as the panel shows them: each marked dismissed or collapsed, and who it went to. */
export function withMarks(home, story, questions) {
  const marks = readQaMarks(home, story);
  const handed = readHanded(home);
  return questions.map((question) => ({
    ...question,
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
export function routeQuestions(home, consumer, scope, questions, { live = null } = {}) {
  const take = [];
  const defer = [];
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
