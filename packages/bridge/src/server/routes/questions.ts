/*
 * Questions from the panel's Ask box, with the answers a Claude session gave
 * them (`once-upon answer`), and what the reviewer did with them: dismissed
 * (Dismiss, Clear conversation) or collapsed. Those marks are kept per story
 * in state/<id>/questions.json, so a reload or another tab shows the same.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { newId } from '../../services/inbox/inbox.ts';
import { markQuestions, withMarks } from '../../services/inbox/conversation.ts';
import { HttpError } from '../request.ts';
import { parseBody } from '../validate.ts';
import type { ServedStory } from '../../services/stories/types.ts';
import type { App, Call, StoryRoute } from '../types.ts';

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
function mark({ app, body: raw, send }: Call, story: ServedStory) {
  const { action, seen, auto, ids: asked } = parseBody('questionMarks', raw);
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
  } else {
    const known = new Set(app.inbox.questions(story.id).map((question) => question.id));
    ids = asked.filter((id) => known.has(id));
  }
  const applied = ({ clear: 'dismiss', read_all: 'read' } as Record<string, string>)[action];
  markQuestions(app.home, story.id, applied || action, ids, { seen, auto });
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
  const { text, step, chapter, file, url } = parseBody('questionAsk', body);
  if (!text.trim()) {
    throw new HttpError(400, 'text is required');
  }
  const question = app.inbox.append({
    type: 'question',
    id: newId('q'),
    ...story.ref,
    step,
    chapter,
    file,
    text: text.trim(),
    url,
  });
  return send(200, question);
}

export const questionRoutes: StoryRoute[] = [
  { route: ROUTES.questionsRead, handle: storyQuestions },
  { route: ROUTES.questionAsk, handle: storyQuestions },
  { route: ROUTES.questionMarks, handle: storyQuestions },
];
