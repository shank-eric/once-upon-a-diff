/*
 * Questions from the panel's Ask box, with the answers a Claude session gave
 * them (`once-upon answer`), and what the reviewer did with them: dismissed
 * (Dismiss, Clear conversation) or collapsed. Those marks are kept per story
 * in state/<id>/questions.json, so a reload or another tab shows the same.
 */
import { newId } from '../../inbox/inbox.ts';
import { QA_ACTIONS, markQuestions, withMarks } from '../../inbox/conversation.ts';
import { HttpError, clipText, toInt } from '../request.ts';
import type { App, Call, ServedStory, StoryRoute } from '../../types.ts';

const MAX_IDS = 500;

/** The story's questions, oldest first, each with its answers and marks. */
export const questionsOf = (app: App, story: Pick<ServedStory, 'id'>) =>
  withMarks(app.home, story.id, app.inbox.questions(story.id));

/**
 * POST .../questions/marks {action, ids}: dismiss, restore, collapse, expand, read or unread those questions. clear
 * dismisses every question the story has that isn't dismissed yet, and says which (`cleared`), so the panel can undo
 * it. read_all marks every unread answer read. A read says `seen` ({<question id>: the newest answer's `at` the panel
 * drew}), which is what gets marked, so an answer that came in between stays unread; `auto` says the panel marked it
 * because it sat in view, which leaves a question held unread alone.
 */
function mark({ app, body, send }: Call, story: ServedStory) {
  const action = String(body.action || '');
  const seen =
    body.seen && typeof body.seen === 'object' && !Array.isArray(body.seen)
      ? (body.seen as Record<string, unknown>)
      : null;
  let ids: string[];
  let cleared: string[] | null = null;
  if (action === 'clear') {
    ids = questionsOf(app, story)
      .filter((question) => !question.dismissed)
      .map((question) => question.id);
    cleared = ids;
  } else if (action === 'read_all') {
    // the ones the panel drew (seen), when it says; every unread one for a caller that doesn't
    const drawn = seen ? new Set(Object.keys(seen)) : null;
    ids = questionsOf(app, story)
      .filter((question) => question.unread && (!drawn || drawn.has(question.id)))
      .map((question) => question.id);
  } else if (QA_ACTIONS.includes(action)) {
    const known = new Set(app.inbox.questions(story.id).map((question) => question.id));
    ids = (Array.isArray(body.ids) ? body.ids : [])
      .slice(0, MAX_IDS)
      .map(String)
      .filter((id) => known.has(id));
  } else {
    throw new HttpError(400, `action is one of clear, read_all, ${QA_ACTIONS.join(', ')}`);
  }
  const applied = ({ clear: 'dismiss', read_all: 'read' } as Record<string, string>)[action];
  markQuestions(app.home, story.id, applied || action, ids, { seen, auto: body.auto === true });
  return send(200, { questions: questionsOf(app, story), ...(cleared ? { cleared } : {}) });
}

/** GET: the story's questions and answers. POST: a new question, to the inbox. POST .../marks: see mark. */
function storyQuestions(call: Call, story: ServedStory) {
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

export const questionRoutes: StoryRoute[] = [{ what: 'questions', handle: storyQuestions }];
