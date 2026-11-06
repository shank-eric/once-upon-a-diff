import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { localRepo } from '@once-upon-a-diff/test-kit/git';
import { upgradePlan, REF_NOTE } from '../src/legacy.ts';
import { chaptersOf } from '../src/chapters.ts';
import { lintTextRefs } from '../src/text-refs.ts';
import { pathSha } from '../src/diff.ts';
import { StoryStore } from '../src/store.ts';
import { createLocalStory } from '../src/local-story.ts';
import { finishedInOf } from '@once-upon-a-diff/terms/chapters';
import type { Plan } from '../src/chapters.ts';

const RELS = [
  'libs/hooks/useOptions.ts',
  'apps/a/DateField.tsx',
  'apps/a/index.ts',
  'apps/b/index.ts',
  'apps/a/Orders.tsx',
];

const upgraded = (chapters: Plan['chapters']) => upgradePlan({ chapters }, RELS).chapters!;

test("an older story's text references and lines ranges become refs, and its text links to them by id", () => {
  const [chapter] = upgraded([
    {
      title: 'Chapter 1: Orders',
      narrative: [
        'A filter joins Status (`Orders.tsx:97-108`), then `:68-76` builds the query.',
        'Optional: `useOptions.ts:45` (chapter 2) and `DateField.tsx`, named with no line.',
        `See [the load](https://github.com/o/r/pull/1/changes#diff-${pathSha('apps/a/DateField.tsx')}R54).`,
        '`index.ts:3` fits two files, so it is skipped. ```\n`apps/b/index.ts:9` in a code block\n```',
      ].join('\n'),
      files: [
        {
          rel: 'apps/a/Orders.tsx',
          lines: [{ side: 'R', start: 10, end: 12, label: 'the filter' }],
        },
        'apps/a/DateField.tsx',
      ],
    },
  ]);
  assert.equal(chapter.key, 'orders', 'the key the panel always derived from the title');
  const byId = Object.fromEntries((chapter.refs || []).map((ref) => [ref.id, ref]));
  assert.deepEqual(byId.l1, {
    id: 'l1',
    path: 'apps/a/Orders.tsx',
    side: 'R',
    start: 10,
    end: 12,
    label: 'the filter',
  });
  assert.deepEqual(byId.t1, {
    id: 't1',
    path: 'apps/a/Orders.tsx',
    side: 'R',
    start: 97,
    end: 108,
    text: true,
  });
  assert.deepEqual(byId.t2, {
    id: 't2',
    path: 'apps/a/Orders.tsx',
    side: 'R',
    start: 68,
    end: 76,
    text: true,
  });
  assert.equal(byId.t3.path, 'libs/hooks/useOptions.ts');
  assert.equal(byId.t3.label, 'pointed at in the text');
  assert.deepEqual(
    byId.t4,
    { id: 't4', path: 'apps/a/DateField.tsx', text: true },
    'a name with no line links the file',
  );
  assert.deepEqual(byId.t5, {
    id: 't5',
    path: 'apps/a/DateField.tsx',
    side: 'R',
    start: 54,
    end: 54,
    text: true,
  });
  const text = chapter.narrative as string;
  assert.match(text, /\[`Orders\.tsx:97-108`\]\(ref:t1\)/);
  assert.match(text, /\[`Orders\.tsx:68-76`\]\(ref:t2\)/, 'a bare :N is drawn with its file');
  assert.match(text, /\[the load\]\(ref:t5\)/);
  assert.match(text, /`index\.ts:3` fits two files/, 'an ambiguous name is left as text');
  assert.match(text, /`apps\/b\/index\.ts:9` in a code block/, 'code blocks are not references');
  assert.deepEqual(
    (chapter.files as unknown[]).map((entry) =>
      typeof entry === 'string' ? entry : (entry as { rel: string }).rel,
    ),
    ['apps/a/Orders.tsx', 'apps/a/DateField.tsx', 'libs/hooks/useOptions.ts'],
    'a file the text points at joins the chapter',
  );
});

test("a name two of the chapter's own files fit is not a reference, unless the file named just before settles it", () => {
  const files = ['apps/a/index.ts', 'apps/b/index.ts', 'apps/a/Orders.tsx'];
  const [alone] = upgraded([{ title: 'One', narrative: '`index.ts:3` is one of two.', files }]);
  assert.deepEqual(alone.refs, []);
  const [settled] = upgraded([
    { title: 'Two', narrative: '`apps/b/index.ts` opens, then `index.ts:3`.', files },
  ]);
  assert.deepEqual(
    (settled.refs || []).map((ref) => [ref.id, ref.path, ref.start]),
    [
      ['t1', 'apps/b/index.ts', undefined],
      ['t2', 'apps/b/index.ts', 3],
    ],
  );
});

test("an older story keeps where each file is finished: a later chapter that points at a file's lines finishes it", () => {
  const chapters = chaptersOf({
    chapters: upgraded([
      {
        title: 'Chapter 1: Options',
        narrative: 'The hook (`useOptions.ts:12`).',
        files: ['libs/hooks/useOptions.ts'],
      },
      {
        title: 'Chapter 2: Filter',
        narrative: 'Comments: `Orders.tsx:99`, and `useOptions.ts:45` (chapter 1).',
        files: ['apps/a/Orders.tsx'],
      },
      {
        title: 'Chapter 3: Tests',
        narrative: 'The tests name `useOptions.ts` but point at no line.',
        files: ['apps/a/index.ts'],
      },
    ]),
  });
  assert.deepEqual(chapters[1].files[1], {
    rel: 'libs/hooks/useOptions.ts',
    partial: true,
    note: REF_NOTE,
    ref: true,
    lines: [{ side: 'R', start: 45, end: 45, label: 'pointed at in the text' }],
  });
  assert.equal(chapters[0].files.length, 1, 'a reference to a file the chapter lists adds nothing');
  assert.equal(chapters[2].files.length, 1, 'a name with no line is not a reference');
  assert.equal(finishedInOf(chapters)['libs/hooks/useOptions.ts'], 2);

  const since = upgradePlan(
    {
      chapters: [
        {
          title: 'Since you read it',
          since: { from: 'a'.repeat(40), to: 'b'.repeat(40) },
          narrative: '`DateField.tsx:54`',
          files: ['apps/a/Orders.tsx'],
        },
      ],
    },
    RELS,
  ).chapters!;
  assert.equal(since[0].files!.length, 1, 'a "Since you read it" chapter gets no referenced files');
});

test('a plan told with refs is left alone: its text points at nothing, and lints', () => {
  const plan: Plan = {
    chapters: [
      {
        key: 'a',
        title: 'Chapter 1: A',
        narrative: 'See [the load](ref:load), then `src/a.js:7` and `a.js`.',
        files: ['src/a.js'],
        refs: [{ id: 'load', path: 'src/a.js', side: 'R', start: 3, end: 4 }],
      },
    ],
  };
  assert.equal(upgradePlan(plan, RELS), plan);
  const [chapter] = chaptersOf(plan);
  assert.deepEqual(chapter.files, [
    {
      rel: 'src/a.js',
      partial: false,
      note: null,
      lines: [{ side: 'R', start: 3, end: 4, label: '' }],
    },
  ]);
  assert.deepEqual(lintTextRefs(plan), [
    'chapter 1: `src/a.js:7` is text, not a link: add a ref and write [text](ref:<id>)',
    'chapter 1: `a.js` is text, not a link: add a ref and write [text](ref:<id>)',
  ]);
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
  const data = new StoryStore({ home }).load('acme-widgets-8')!;
  assert.deepEqual(
    data.chapters.map((chapter) => chapter.key),
    ['a', 'b'],
    'older chapters read with their title keys',
  );
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
  const data = new StoryStore({ home }).load(made.id)!;
  assert.ok(
    data.chapters[1].files.some((file) => file.rel === 'one.txt' && file.ref),
    'one.txt joins chapter 2',
  );
  assert.equal(finishedInOf(data.chapters)['one.txt'], 2);
});
