import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { parseUnifiedDiff } from '../src/diff.ts';
import { answerRefs, chapterProblems } from '../src/validate.ts';
import type { Plan, PlanChapter } from '../src/chapters.ts';

/** a.js has one hunk, new lines 10-13 */
const diff = parseUnifiedDiff(
  [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,2 +10,4 @@ fn',
    ' before',
    '+l1',
    '+l2',
    ' after',
    '',
  ].join('\n'),
);

const chapterOf = (extra: Partial<PlanChapter> = {}): PlanChapter => ({
  key: 'a',
  headline: 'A.',
  narrative: 'text [x](ref:x)',
  files: ['src/a.js'],
  refs: [{ id: 'x', path: 'src/a.js', side: 'R', start: 10, end: 12 }],
  ...extra,
});
const ref = (extra: object) => ({ id: 'x', path: 'src/a.js', start: 10, end: 12, ...extra });
const far = {
  chapters: [
    chapterOf({
      refs: [ref({ start: 400 })],
      comments: [{ path: 'src/a.js', line: 400 }],
    }),
  ],
  refs: [],
};

const cases: [string, Plan, object][] = [
  ['clean', { chapters: [chapterOf()], refs: [] }, { diff }],
  ['no diff', { chapters: [chapterOf()], refs: [] }, {}],
  [
    'keys',
    {
      chapters: [chapterOf({ key: '' }), chapterOf({ key: 'k' }), chapterOf({ key: 'k' })],
      refs: [],
    },
    { diff },
  ],
  ['no refs lists', { chapters: [chapterOf({ refs: undefined })], overview: 'text' }, { diff }],
  [
    'kept without a refs list',
    { chapters: [chapterOf({ refs: undefined })], overview: 'text' },
    { diff, served: { chapters: [chapterOf({ refs: undefined })], overview: 'text' } },
  ],
  [
    'overview links',
    { chapters: [], overview: 'see [y](ref:y)', refs: [{ id: 'z', path: 'nope.js', start: 1 }] },
    { diff },
  ],
  [
    'overview off page',
    { chapters: [], overview: 'o', refs: [ref({ start: 400, end: 410 })] },
    { diff },
  ],
  [
    'overview unchanged',
    { chapters: [], overview: 'o', refs: [ref({ start: 400, end: 410 })] },
    { diff, served: { chapters: [], overview: 'o', refs: [ref({ start: 400, end: 410 })] } },
  ],
  [
    'overview served without a list',
    { chapters: [], overview: 'o', summary: 's' },
    { diff, served: { chapters: [], overview: 'o', summary: 's' } },
  ],
  [
    'bad refs',
    {
      chapters: [
        chapterOf({
          refs: [
            ref({ id: 'Bad Id' }),
            ref({ id: 'x' }),
            ref({ id: 'x', path: '' }),
            ref({ id: 'y', path: 'zz.js' }),
            ref({ id: 'w', start: 0 }),
            ref({ id: 'v', start: 5, end: 2 }),
            ref({ id: 'u', start: 'a' }),
            ref({ id: 't', side: 'Q' }),
            ref({ id: 's', start: '', side: 'Q' }),
            ref({ id: 'r', start: 1.5 }),
            ref({ id: 'q', start: 3, end: undefined }),
          ],
        }),
      ],
    },
    { diff },
  ],
  [
    'text links missing',
    {
      chapters: [chapterOf({ narrative: 'a [b](ref:b) and [x](ref:x)', summary: 'ref:c' })],
      refs: [],
    },
    { diff },
  ],
  [
    'off page refs and comments',
    {
      chapters: [
        chapterOf({
          refs: [ref({ start: 400 })],
          comments: [
            { path: 'src/a.js', line: 400 },
            { path: 'src/a.js', line: 11 },
          ],
        }),
      ],
      refs: [],
    },
    { diff },
  ],
  ['pointers off', far, { diff, pointers: false }],
  ['kept chapter skips pointers', far, { diff, served: far }],
  [
    'comment paths',
    {
      chapters: [
        chapterOf({
          comments: [
            { path: 'other.js', line: 3 },
            { path: '(general)' },
            { path: '', line: 1 },
            { path: 'x.js', carried: true },
            { path: 'y.js', unmapped: true },
            { path: 'src/a.js', line: 11 },
          ],
        }),
      ],
      refs: [],
    },
    { diff },
  ],
  [
    'story map',
    {
      chapters: [
        chapterOf({ narrative: 'The story map is here\n\n### Chapter 1 A\nbody [x](ref:x)' }),
      ],
      refs: [],
    },
    { diff },
  ],
  [
    'file entries as objects',
    {
      chapters: [
        chapterOf({ files: [{ rel: 'src/a.js' } as never], refs: [ref({ path: 'src/b.js' })] }),
      ],
      refs: [],
    },
    { diff },
  ],
  ['empty plan', {}, { diff }],
];

const answerCases: [string, unknown, string, string[] | undefined][] = [
  ['good', [ref({})], 'ref:x', ['src/a.js']],
  ['duplicate id and missing link', [ref({}), ref({})], 'ref:y', ['src/a.js']],
  ['path not in files', [ref({ path: 'q.js' })], 'ok', ['src/a.js']],
  ['bad range, any file', [ref({ start: 0 })], 'ok', undefined],
  ['not a list', 'x', '', undefined],
];

// What each case reported before chapterProblems and refListProblems were split into per-field checks.
const expected: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('./fixtures/validate-problems.json', import.meta.url), 'utf8'),
);

test('chapterProblems reports each plan problem as it always has, in order', () => {
  for (const [name, plan, opts] of cases) {
    assert.deepEqual(chapterProblems(plan, opts), expected[name], name);
  }
});

test('answerRefs checks an answer’s refs like a chapter’s and throws with every problem', () => {
  for (const [name, raw, text, files] of answerCases) {
    const key = `answer: ${name}`;
    if (typeof expected[key] === 'string') {
      assert.throws(
        () => answerRefs(raw, text, files),
        { message: (expected[key] as string).slice('throws: '.length) },
        name,
      );
    } else {
      assert.deepEqual(answerRefs(raw, text, files), expected[key], name);
    }
  }
});
