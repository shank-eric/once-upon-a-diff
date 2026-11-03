import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from './helpers.ts';
import { publishPrStory } from '../src/services/stories/publish.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { assignKeys, chapterProblems } from '../src/services/stories/validate.ts';
import { parseUnifiedDiff } from '../src/services/stories/diff.ts';
import type { Plan } from '../src/services/stories/chapters.ts';

const DIFF = parseUnifiedDiff(
  [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
    'diff --git a/lib/a.js b/lib/a.js',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -1 +1,2 @@',
    ' x',
    '+y',
    '',
  ].join('\n'),
);

const chapter = (extra: Record<string, unknown> = {}) => ({
  key: 'start',
  title: 'Chapter 1: Start',
  files: ['src/a.js'],
  refs: [{ id: 'top', path: 'src/a.js', side: 'R', start: 1, end: 3 }],
  narrative: 'It starts at [the top](ref:top).',
  comments: [],
  ...extra,
});

test('a chapter without refs, and one without a key, are refused', () => {
  const noRefs = chapter({ refs: undefined });
  const noKey = chapter({ key: undefined });
  const problems = chapterProblems({ chapters: [noRefs, noKey] } as Plan);
  assert.ok(
    problems.some((line) => /chapter 1 .*no refs/.test(line)),
    problems.join('\n'),
  );
  assert.ok(
    problems.some((line) => /chapter 2 .*no key/.test(line)),
    problems.join('\n'),
  );
  assert.deepEqual(chapterProblems({ chapters: [chapter()] } as Plan, { diff: DIFF }), []);
});

test('keys are assigned from the title, deduplicated, and an existing key is kept', () => {
  const plan = {
    chapters: [
      { title: 'Chapter 1: The loader', files: [] },
      { title: 'Chapter 2: The loader', files: [] },
      { title: '', files: [] },
      { key: 'kept', title: 'Chapter 4: Other', files: [] },
    ],
  } as Plan;
  assert.deepEqual(assignKeys(plan), ['the loader', 'the loader 2', 'chapter-3']);
  assert.deepEqual(
    plan.chapters!.map((one) => one.key),
    ['the loader', 'the loader 2', 'chapter-3', 'kept'],
  );
  assert.deepEqual(assignKeys(plan), [], 'a second pass changes nothing');
});

test('bad refs, links, comment paths and story maps are named', () => {
  const plan = {
    chapters: [
      chapter({
        files: ['src/a.js'],
        refs: [
          { id: 'top', path: 'src/a.js', side: 'R', start: 1, end: 3 },
          { id: 'top', path: 'src/a.js', side: 'R', start: 2, end: 2 },
          { id: 'Bad Id', path: 'src/a.js', side: 'R', start: 1, end: 1 },
          { id: 'far', path: 'lib/a.js', side: 'R', start: 1, end: 2 },
          { id: 'back', path: 'src/a.js', side: 'R', start: 5, end: 2 },
        ],
        narrative: 'See [here](ref:nope).',
        comments: [{ path: 'a.js', line: 2, body: 'suffix' }],
      }),
      chapter({
        key: 'two',
        narrative: 'The story map\n\n- one\n\n### Chapter 2: Two\n\nText [x](ref:top).',
      }),
    ],
  } as Plan;
  const problems = chapterProblems(plan, { diff: DIFF }).join('\n');
  assert.match(problems, /chapter 1: ref "top" is used twice/);
  assert.match(problems, /chapter 1: ref "Bad Id"/);
  assert.match(problems, /chapter 1: ref "far" is on lib\/a\.js, which the chapter does not list/);
  assert.match(problems, /chapter 1: ref "back"/);
  assert.match(problems, /chapter 1: the text links to ref:nope/);
  assert.match(problems, /chapter 1: the comment on a\.js:2 needs the file's full path/);
  assert.match(problems, /chapter 2's narrative opens with a story map/);
});

test('a chapter without refs passes only when it is the one already published', () => {
  const old = { key: 'start', title: 'Chapter 1: Start', files: ['src/a.js'], narrative: 'Old.' };
  assert.deepEqual(
    chapterProblems({ chapters: [old] } as Plan, { served: { chapters: [old] } as Plan }),
    [],
  );
  assert.equal(
    chapterProblems({ chapters: [{ ...old, narrative: 'New.' }] } as Plan, {
      served: { chapters: [old] } as Plan,
    }).length,
    1,
  );
});

/** A once-upon folder (pr.json, pr.diff, chapters.json) for acme/widgets#7. */
function folder(chapters: unknown[]): string {
  const dir = tmp('validate-pub');
  writeJson(path.join(dir, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Widgets',
  });
  writeFileSync(
    path.join(dir, 'pr.diff'),
    [
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      '',
    ].join('\n'),
  );
  writeJson(path.join(dir, 'chapters.json'), { chapters });
  return dir;
}

test('publish refuses a chapter with no refs list, and writes assigned keys back to the author file', () => {
  const home = tmp('validate-home');
  const dir = folder([{ title: 'Chapter 1: Start', files: ['src/a.js'], narrative: '' }]);
  assert.throws(
    () => publishPrStory(home, { dir, allowUncovered: false }),
    /chapter 1 has no refs list/,
  );
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [{ title: 'Chapter 1: Start', files: ['src/a.js'], refs: [], narrative: '' }],
  });
  const { dest } = publishPrStory(home, { dir, allowUncovered: false });
  const source = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  assert.equal(source.chapters[0].key, 'start', 'the author keeps the key from now on');
  const served = JSON.parse(readFileSync(path.join(dest, 'chapters.json'), 'utf8'));
  assert.equal(served.chapters[0].key, 'start');
  assert.equal(
    new StoryStore({ home }).load('acme-widgets-7')!.chapters[0].key,
    'start',
    'and the panel reads it',
  );
});

test('a story published before refs still reads, and can be republished with its chapters kept as they were', () => {
  const home = tmp('validate-old');
  const dir = folder([{ title: 'Chapter 1: Old', files: ['src/a.js'], narrative: 'Old text.' }]);
  const dest = path.join(home, 'acme-widgets-7');
  writeJson(path.join(dest, 'meta.json'), { kind: 'github', repo: 'acme/widgets', number: 7 });
  writeJson(
    path.join(dest, 'chapters.json'),
    JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8')),
  );
  const data = new StoryStore({ home }).load('acme-widgets-7')!;
  assert.equal(data.chapters[0].key, 'old', 'the key the panel always derived');
  assert.deepEqual(data.chapters[0].refs, []);
  // the same chapter again passes, and a changed one is a new chapter that needs its refs
  publishPrStory(home, { dir, id: 'acme-widgets-7', allowUncovered: false });
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [{ title: 'Chapter 1: Old', files: ['src/a.js'], narrative: 'Reworded.' }],
  });
  assert.throws(
    () => publishPrStory(home, { dir, id: 'acme-widgets-7', allowUncovered: false }),
    /chapter 1 has no refs list/,
  );
});

test('rebuilding an older story from chapter 2: its kept chapter may have been given its key since it was published', () => {
  const home = tmp('validate-rebuild');
  const dir = folder([]);
  const meta = { kind: 'github', repo: 'acme/widgets', number: 7 } as const;
  const dest = path.join(home, 'acme-widgets-7');
  // as the story was published before refs: no keys, no refs, `lines` on an entry
  writeJson(path.join(dest, 'meta.json'), meta);
  writeJson(path.join(dest, 'chapters.json'), {
    chapters: [
      {
        title: 'Chapter 1: Old',
        narrative: 'Old text.',
        files: [{ rel: 'src/a.js', lines: [{ side: 'R', start: 1, end: 2, label: 'top' }] }],
      },
      { title: 'Chapter 2: Older', narrative: 'Older text.', files: ['src/b.js'] },
    ],
  });
  new Builds(home).requestRebuild({
    story: 'acme-widgets-7',
    meta,
    mode: 'rebuild_from',
    from_step: 2,
    chapters: 2,
  });
  writeFileSync(
    path.join(dir, 'pr.diff'),
    [
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      'diff --git a/src/b.js b/src/b.js',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      '',
    ].join('\n'),
  );
  // what `story.ts build` writes: chapter 1 as published, and now with the key assignKeys gave it
  const served = JSON.parse(readFileSync(path.join(dest, 'chapters.json'), 'utf8'));
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [
      { ...served.chapters[0], key: 'old' },
      { title: 'Chapter 2: Redone', files: ['src/b.js'], refs: [], narrative: '' },
    ],
  });
  publishPrStory(home, { dir, id: 'acme-widgets-7', allowUncovered: false });
  const now = new StoryStore({ home }).load('acme-widgets-7')!;
  assert.deepEqual(
    now.chapters.map((chapter) => chapter.key),
    ['old', 'redone'],
  );
  // a kept chapter that really changed is still refused
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [
      { ...served.chapters[0], key: 'old', narrative: 'Reworded.' },
      { title: 'Chapter 2: Redone', files: ['src/b.js'], refs: [], narrative: '' },
    ],
  });
  new Builds(home).requestRebuild({
    story: 'acme-widgets-7',
    meta,
    mode: 'rebuild_from',
    from_step: 2,
    chapters: 2,
  });
  assert.throws(
    () => publishPrStory(home, { dir, id: 'acme-widgets-7', allowUncovered: false }),
    /chapter 1 .*changed/,
  );
});
