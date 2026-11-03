import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson, githubStory, startBridge, runCli } from './helpers.ts';
import { answerRefs, chapterProblems } from '../src/services/stories/validate.ts';
import { upgradePlan } from '../src/services/stories/legacy.ts';
import type { Plan } from '../src/services/stories/chapters.ts';
import type { QuestionEntry } from '../src/services/inbox/inbox.ts';
import type { StoryData } from '@once-upon-a-diff/protocol/types';

const RELS = ['src/a.js', 'src/b.js'];

test("an answer's refs are checked like a chapter's, and every ref: link in its text must be one of them", () => {
  assert.deepEqual(
    answerRefs([{ id: 'load', path: 'src/a.js', start: '40', end: 58 }], 'See [it](ref:load).'),
    [{ id: 'load', path: 'src/a.js', side: 'R', start: 40, end: 58 }],
  );
  assert.throws(() => answerRefs({ id: 'x' }, 'x'), /must hold a JSON list/);
  assert.throws(() => answerRefs([], 'See [it](ref:nope).'), /text links to ref:nope/);
  assert.throws(
    () =>
      answerRefs(
        [
          { id: 'a', path: 'src/a.js' },
          { id: 'a', path: 'src/b.js', start: 3, end: 1 },
        ],
        '',
      ),
    /ref "a" is used twice[\s\S]*not a range/,
  );
});

test("the overview, summary and plan link by the plan's own refs, which may be on any file", () => {
  const plan: Plan = {
    overview: 'The [entry](ref:entry) and [a ghost](ref:ghost).',
    summary: 'Nothing here.',
    refs: [{ id: 'entry', path: 'src/b.js', start: 3, end: 4 }],
    chapters: [],
  };
  assert.deepEqual(chapterProblems(plan), [
    'the overview: the text links to ref:ghost, which has no ref',
  ]);
  plan.overview = 'The [entry](ref:entry).';
  assert.deepEqual(chapterProblems(plan), []);
});

test("an older story's overview is upgraded too: its backticked names link among every file of the story", () => {
  const plan = upgradePlan(
    {
      overview: 'It starts in `src/a.js:3-9`, and `b.js` follows. `nothing.js` is not a file.',
      chapters: [{ title: 'Chapter 1', files: ['src/a.js'] }],
    },
    RELS,
  );
  assert.equal(
    plan.overview,
    'It starts in [`src/a.js:3-9`](ref:t1), and [`b.js`](ref:t2) follows. `nothing.js` is not a file.',
  );
  assert.deepEqual(plan.refs, [
    { id: 't1', path: 'src/a.js', side: 'R', start: 3, end: 9, text: true },
    { id: 't2', path: 'src/b.js', text: true },
  ]);
});

test('a plan told with refs has no overview upgrade, and one with overview text needs its refs list', () => {
  const plan: Plan = {
    overview: 'It starts in `src/a.js:3-9`.',
    refs: [],
    chapters: [{ key: 'one', title: 'Chapter 1', files: ['src/a.js'], refs: [] }],
  };
  assert.equal(upgradePlan(plan, RELS), plan, 'its backticks stay code');
  assert.deepEqual(chapterProblems({ ...plan, refs: undefined }), [
    'the overview has no refs list: give the plan `"refs": []`, or the places its text links to',
  ]);
  assert.deepEqual(
    chapterProblems({ ...plan, overview: '', refs: undefined }),
    [],
    'no text, nothing to link',
  );
});

test('once-upon answer --refs stores the refs, the bridge serves them with the answer, and a bad link is refused', async () => {
  const home = tmp('answer-home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    const asked = await bridge.call<QuestionEntry>(
      'POST',
      '/api/stories/acme-widgets-7/questions',
      {
        text: 'Where?',
        step: 1,
      },
    );
    const refs = path.join(tmp('answer-refs'), 'refs.json');
    writeJson(refs, [{ id: 'top', path: 'src/a.js', side: 'R', start: 1, end: 3 }]);
    const bad = await runCli(home, [
      'answer',
      '--question',
      asked.body.id,
      '--text',
      'See [it](ref:nope).',
      '--refs',
      refs,
    ]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /text links to ref:nope/);
    const elsewhere = path.join(tmp('answer-refs2'), 'refs.json');
    writeJson(elsewhere, [{ id: 'top', path: 'a.js', start: 1 }]);
    const suffix = await runCli(home, [
      'answer',
      '--question',
      asked.body.id,
      '--text',
      'See [it](ref:top).',
      '--refs',
      elsewhere,
    ]);
    assert.notEqual(suffix.code, 0);
    assert.match(suffix.stderr, /ref "top" is on a\.js, which the story does not list/);
    const ok = await runCli(home, [
      'answer',
      '--question',
      asked.body.id,
      '--text',
      'See [it](ref:top).',
      '--refs',
      refs,
    ]);
    assert.equal(ok.code, 0, ok.stderr);
    const { body } = await bridge.call<{
      questions: { answers: { text: string; refs?: unknown[] }[] }[];
    }>('GET', '/api/stories/acme-widgets-7/questions');
    assert.deepEqual(body.questions[0].answers[0].refs, [
      { id: 'top', path: 'src/a.js', side: 'R', start: 1, end: 3 },
    ]);
    const story = await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7');
    assert.deepEqual(story.body.overview_refs, []);
  } finally {
    await bridge.close();
  }
});
