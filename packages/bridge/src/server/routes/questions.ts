// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Questions from the panel's Ask box, with the answers a Claude session gave
 * them (`once-upon answer`), and what the reviewer did with them: dismissed
 * (Dismiss, Clear conversation) or collapsed. Those marks are kept per story
 * in state/<id>/questions.json, so a reload or another tab shows the same.
 */
import { newId } from '../../inbox/inbox.ts';
import { QA_ACTIONS, markQuestions, withMarks } from '../../inbox/conversation.ts';
import { HttpError, clipText, toInt } from '../request.ts';

const MAX_IDS = 500;

/** The story's questions, oldest first, each with its answers and marks. */
export const questionsOf = (app, story) =>
  withMarks(app.home, story.id, app.inbox.questions(story.id));

/**
 * POST .../questions/marks {action, ids}: dismiss, restore, collapse or expand those questions. clear dismisses
 * every question the story has that isn't dismissed yet, and says which (`cleared`), so the panel can undo it.
 */
function mark({ app, body, send }, story) {
  const action = String(body.action || '');
  let ids;
  let cleared = null;
  if (action === 'clear') {
    ids = questionsOf(app, story)
      .filter((question) => !question.dismissed)
      .map((question) => question.id);
    cleared = ids;
  } else if (QA_ACTIONS.includes(action)) {
    const known = new Set(app.inbox.questions(story.id).map((question) => question.id));
    ids = (Array.isArray(body.ids) ? body.ids : [])
      .slice(0, MAX_IDS)
      .map(String)
      .filter((id) => known.has(id));
  } else {
    throw new HttpError(400, `action is one of clear, ${QA_ACTIONS.join(', ')}`);
  }
  markQuestions(app.home, story.id, action === 'clear' ? 'dismiss' : action, ids);
  return send(200, { questions: questionsOf(app, story), ...(cleared ? { cleared } : {}) });
}

/** GET: the story's questions and answers. POST: a new question, to the inbox. POST .../marks: see mark. */
function storyQuestions(call, story) {
  const { app, req, body, send } = call;
  if (story.sub === 'marks' && req.method === 'POST') {
    return mark(call, story);
  }
  if (story.sub) {
    throw new HttpError(404, 'not found');
  }
  if (req.method === 'GET') {
    return send(200, { questions: questionsOf(app, story) });
  }
  const text = clipText(body.text, 8000);
  if (!text || !text.trim()) {
    throw new HttpError(400, 'text is required');
  }
  const question = app.inbox.append({
    type: 'question',
    id: newId('q'),
    ...story.ref,
    step: toInt(body.step),
    chapter: clipText(body.chapter, 300),
    file: clipText(body.file, 1000),
    text: text.trim(),
    url: clipText(body.url, 2000),
  });
  return send(200, question);
}

export const questionRoutes = [{ what: 'questions', handle: storyQuestions }];
