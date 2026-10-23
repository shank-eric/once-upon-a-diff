import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson, localRepo } from './helpers.mjs';
import { lineRefsOf, addTextRefs, REF_NOTE } from '../src/stories/text-refs.ts';
import { pathSha } from '../src/util/diff.ts';
import { StoryStore } from '../src/stories/store.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { finishedInOf } from '@once-upon-a-diff/shared/overlay';

const RELS = [
  'libs/hooks/useOptions.ts',
  'apps/a/DateField.tsx',
  'apps/a/index.ts',
  'apps/b/index.ts',
  'apps/a/Orders.tsx',
];

test("line references in a chapter's text: path:N, ranges, bare :N, and diff links with a line", () => {
  const text = [
    'A filter joins Status (`Orders.tsx:97-108`), then `:68-76` builds the query.',
    'Optional: `useOptions.ts:45` (chapter 2) and `DateField.tsx`, named with no line.',
    `See [the load](https://github.com/o/r/pull/1/changes#diff-${pathSha('apps/a/DateField.tsx')}R54).`,
    '`index.ts:3` fits two files, so it is skipped. ```\n`apps/b/index.ts:9` in a code block\n```',
  ].join('\n');
  assert.deepEqual(lineRefsOf(text, ['apps/a/Orders.tsx'], RELS), [
    {
      rel: 'apps/a/Orders.tsx',
      lines: [
        { side: 'R', start: 97, end: 108 },
        { side: 'R', start: 68, end: 76 },
      ],
    },
    { rel: 'libs/hooks/useOptions.ts', lines: [{ side: 'R', start: 45, end: 45 }] },
    { rel: 'apps/a/DateField.tsx', lines: [{ side: 'R', start: 54, end: 54 }] },
  ]);
  assert.deepEqual(
    lineRefsOf('`index.ts:3`', ['apps/b/index.ts'], RELS),
    [{ rel: 'apps/b/index.ts', lines: [{ side: 'R', start: 3, end: 3 }] }],
    "the chapter's own file settles a basename",
  );
});

test('a later chapter that points at a file\'s lines finishes it; "Since you read it" chapters only finish what they list', () => {
  const chapters = [
    {
      title: 'Chapter 1: Options',
      narrative: 'The hook (`useOptions.ts:12`).',
      files: [{ rel: 'libs/hooks/useOptions.ts', partial: false, note: null }],
    },
    {
      title: 'Chapter 2: Filter',
      narrative: 'Comments: `Orders.tsx:99`, and `useOptions.ts:45` (chapter 1).',
      files: [{ rel: 'apps/a/Orders.tsx', partial: false, note: null }],
    },
    {
      title: 'Chapter 3: Tests',
      narrative: 'The tests name `useOptions.ts` but point at no line.',
      files: [{ rel: 'apps/a/index.ts', partial: false, note: null }],
    },
  ];
  assert.deepEqual(
    finishedInOf(chapters)['libs/hooks/useOptions.ts'],
    1,
    'before: only the listing counts',
  );
  addTextRefs(chapters, RELS);
  assert.deepEqual(chapters[1].files[1], {
    rel: 'libs/hooks/useOptions.ts',
    partial: true,
    note: REF_NOTE,
    ref: true,
    lines: [{ side: 'R', start: 45, end: 45, label: 'pointed at in the text' }],
  });
  assert.equal(chapters[0].files.length, 1, 'a reference to a file the chapter lists adds nothing');
  assert.equal(chapters[2].files.length, 1, 'a name with no line is not a reference');
  assert.equal(
    finishedInOf(chapters)['libs/hooks/useOptions.ts'],
    2,
    'after: Mark viewed moves to the last chapter to point at it',
  );

  const since = [
    {
      title: 'Since you read it',
      since: { from: 'a'.repeat(40), to: 'b'.repeat(40) },
      narrative: '`DateField.tsx:54`',
      files: [{ rel: 'apps/a/Orders.tsx', partial: false, note: null }],
    },
    ...chapters,
  ];
  addTextRefs(since, RELS);
  assert.equal(since[0].files.length, 1, 'a "Since you read it" chapter gets no referenced files');
  assert.equal(finishedInOf(since)['apps/a/Orders.tsx'], 1, 'and still finishes what it lists');
});

test("the bridge adds referenced files to a GitHub story's chapters", () => {
  const home = tmp('refs-gh');
  const dir = path.join(home, 'acme-widgets-8');
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 8,
    url: 'https://github.com/acme/widgets/pull/8',
    pr_title: 'Refs',
  });
  writeJson(path.join(dir, 'file-map.json'), {
    pr: 'acme/widgets#8',
    files: {
      'src/a.js': { chapters: [1], partial_in: [], finished_in: 1 },
      'src/b.js': { chapters: [2], partial_in: [], finished_in: 2 },
    },
  });
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [
      { title: 'Chapter 1: A', narrative: '`a.js:3`', files: ['src/a.js'] },
      {
        title: 'Chapter 2: B',
        narrative: 'Recap: `b.js:1`, and `a.js:7` from chapter 1.',
        files: ['src/b.js'],
      },
    ],
  });
  const data = new StoryStore({ home }).load('acme-widgets-8');
  assert.deepEqual(
    data.chapters[1].files.map((file) => [file.rel, !!file.ref]),
    [
      ['src/b.js', false],
      ['src/a.js', true],
    ],
  );
  assert.deepEqual(finishedInOf(data.chapters), { 'src/a.js': 2, 'src/b.js': 2 });
});

test("the bridge adds referenced files to a local story's chapters", () => {
  const { repo, base } = localRepo();
  const home = tmp('refs-local');
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  writeJson(path.join(made.dir, 'chapters.json'), {
    chapters: [
      { title: 'Chapter 1: One', narrative: '`one.txt:2`', files: ['one.txt'] },
      {
        title: 'Chapter 2: Two',
        narrative: '`two.js:1`, then back to `one.txt:4`.',
        files: ['lib/two.js', 'gone.txt'],
      },
    ],
  });
  const data = new StoryStore({ home }).load(made.id);
  assert.ok(
    data.chapters[1].files.some((file) => file.rel === 'one.txt' && file.ref),
    'one.txt joins chapter 2',
  );
  assert.equal(finishedInOf(data.chapters)['one.txt'], 2);
});
