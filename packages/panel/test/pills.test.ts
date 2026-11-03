import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePills, pillMarker } from '../src/overlay.ts';
import { createStoryModel } from '@once-upon-a-diff/panel/story-model';
import { createFileRefs } from '../src/file-refs.ts';
import { createMarkdown } from '../src/markdown.ts';
import type { PanelContext } from '../src/context.ts';
import type { StoryData } from '@once-upon-a-diff/protocol/types';

test("a file's status pill goes on its last mention in the chapter, and its earlier mentions get nothing", () => {
  // the shape of a chapter that names its task file in bullet 2, twice more in sub-bullets, and in its closing file list
  const marks = [
    'plugins/index.js',
    'tasks/login.js',
    'tasks/login.js',
    'tasks/login.js',
    'cli/index.ts',
    'plugins/index.js',
    'tasks/login.js',
    'cli/index.ts',
  ];
  const html = marks.map((rel, i) => `<code>${rel}</code>${pillMarker(i)}`).join(' ');
  const out = placePills(html, marks, (rel) => `[pill ${rel}]`);
  assert.equal(
    out,
    [
      '<code>plugins/index.js</code>',
      '<code>tasks/login.js</code>',
      '<code>tasks/login.js</code>',
      '<code>tasks/login.js</code>',
      '<code>cli/index.ts</code>',
      '<code>plugins/index.js</code>[pill plugins/index.js]',
      '<code>tasks/login.js</code>[pill tasks/login.js]',
      '<code>cli/index.ts</code>[pill cli/index.ts]',
    ].join(' '),
  );
  assert.equal(
    placePills(`<code>a.js</code>${pillMarker(0)}`, ['a.js'], () => 'pill'),
    '<code>a.js</code>pill',
    'one mention gets the pill',
  );
  assert.equal(
    placePills(`<code>a.js</code>${pillMarker(0)}`, ['a.js'], () => ''),
    '<code>a.js</code>',
    'a file with no pill (a later chapter finishes it) gets nothing at all',
  );
});

test('a file this chapter finishes gets its Mark viewed button at its last mention in the narrative, and nowhere earlier', () => {
  const files = ['src/a.js', 'src/b.js', 'one/board.ts', 'two/board.ts'];
  const story = createStoryModel({
    pr: { title: 'PR' },
    files: files.map((rel, i) => ({ rel, sha: `sha${i}` })),
    chapters: [
      {
        title: 'Chapter 1: A',
        files: files.map((rel) => ({ rel })),
        refs: [
          { id: 'a', path: 'src/a.js' },
          { id: 'open', path: 'src/a.js', side: 'R', start: 3, end: 9 },
          { id: 'b', path: 'src/b.js' },
        ],
      },
      { title: 'Chapter 2: B', files: [{ rel: 'src/b.js' }] },
    ],
  } as unknown as StoryData);
  const context = {
    story,
    state: { n: 1 },
    fileStatus: (rel: string, step: number) => story.statusIn(rel, step),
  } as unknown as PanelContext;
  context.refs = createFileRefs(context);
  context.markdown = createMarkdown(context);
  context.refs.startStep(files, story.data.chapters[0].refs);
  const narrative = [
    '1. [`a.js`](ref:a) opens ([`a.js:3-9`](ref:open)), and [`b.js`](ref:b) starts.',
    '2. `board.ts` is two files, so it is plain text.',
    '',
    '**Files to mark viewed:** [`a.js`](ref:a), [`src/b.js`](ref:b).',
  ].join('\n');
  const out = String(context.refs.storyWithPills(() => context.markdown.markdown(narrative)));
  const buttons = [...out.matchAll(/<button[^>]*data-mark-for="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(buttons, ['src/a.js'], 'one button, for the file this chapter finishes');
  const lastMention = out.lastIndexOf('data-rel="src/a.js"');
  assert.ok(out.indexOf('<button') > lastMention, 'the button follows the last mention');
  assert.match(
    out.slice(lastMention),
    /^data-rel="src\/a\.js"[^>]*><code>a\.js<\/code><\/span><button/,
  );
  assert.doesNotMatch(out, /data-rel="(one|two)\/board\.ts"/, 'a name with no ref is no link');
});
