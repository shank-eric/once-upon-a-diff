/*
 * Questions from the panel's Ask box, and their answers: from a Claude
 * session (`diff-story answer`, POST /api/answers).
 */
import { newId } from '../../inbox/inbox.mjs';
import { HttpError, clipText, toInt } from '../request.mjs';

function answer({ app, body, send }) {
  const question = app.inbox.questions().find((entry) => entry.id === body.question);
  if (!question) {
    throw new HttpError(404, 'no such question');
  }
  const text = clipText(body.text, 20000);
  if (!text) {
    throw new HttpError(400, 'text is required');
  }
  return send(
    200,
    app.inbox.append({
      type: 'answer',
      id: newId('a'),
      question: question.id,
      story: question.story,
      text,
    }),
  );
}

/** GET: the story's questions and answers. POST: a new question, to the inbox. */
function storyQuestions({ app, req, body, send }, story) {
  if (req.method === 'GET') {
    return send(200, { questions: app.inbox.questions(story.id) });
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

export const answerRoutes = [{ path: '/api/answers', method: 'POST', handle: answer }];
export const questionRoutes = [{ what: 'questions', handle: storyQuestions }];
