import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmp, writeJson, githubStory, startBridge } from './helpers.ts';
import { parseUnifiedDiff } from '@once-upon-a-diff/core/records/stories/diff';
import {
  chaptersOf,
  markUnwritten,
  type Plan,
  type PlanChapter,
} from '@once-upon-a-diff/core/records/stories/chapters';
import { upgradePlan } from '@once-upon-a-diff/core/records/stories/legacy';
import type { FileMap } from '@once-upon-a-diff/core/records/stories/story-data';
import type { StoryData } from '@once-upon-a-diff/contracts/types';
import {
  uncoveredHunks,
  SMALL_FILE_LINES,
} from '@once-upon-a-diff/core/records/stories/hunk-coverage';

const STORY = fileURLToPath(new URL('../../../skills/once-upon/bin/story.mjs', import.meta.url));
const run = promisify(execFile);

/** A modified file's diff with one hunk per [newStart, added] pair, each with a line of context on either side. */
function modified(rel: string, hunks: [number, number][]): string[] {
  const out = [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`];
  for (const [start, added] of hunks) {
    out.push(`@@ -${start},2 +${start},${added + 2} @@`, ' before');
    for (let i = 0; i < added; i++) {
      out.push(`+line ${start + 1 + i}`);
    }
    out.push(' after');
  }
  return out;
}

// big.js: 3 hunks, 60 added lines (new side 10-31, 100-121, 200-221). small.js: 1 hunk, 5 lines.
const DIFF = [
  ...modified('src/big.js', [
    [10, 20],
    [100, 20],
    [200, 20],
  ]),
  ...modified('src/small.js', [[1, 5]]),
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1,50 +0,0 @@',
  ...Array.from({ length: 50 }, (_, i) => `-gone ${i}`),
  '',
].join('\n');

const chapter = (fields: PlanChapter): PlanChapter => ({
  title: 'Chapter',
  narrative: '',
  refs: [],
  comments: [],
  ...fields,
});

test('a hunk is covered by a ref or a comment; a small file by its listing; text covers nothing', () => {
  const diff = parseUnifiedDiff(DIFF);
  assert.ok(diff.get('src/big.js')!.stats.added > SMALL_FILE_LINES);
  const plan = {
    chapters: [
      chapter({
        files: ['src/big.js', 'src/small.js', 'old.js'],
        refs: [{ id: 'first', path: 'src/big.js', side: 'R', start: 12, end: 14 }],
      }),
    ],
  };
  assert.deepEqual(uncoveredHunks(chaptersOf(plan), diff), [
    {
      rel: 'src/big.js',
      hunks: [
        { side: 'R', start: 100, end: 121, ref: 'src/big.js:100-121' },
        { side: 'R', start: 200, end: 221, ref: 'src/big.js:200-221' },
      ],
    },
  ]);

  plan.chapters.push(
    chapter({
      narrative: 'Then `src/big.js:105-110` and `big.js:210` do the work.',
      files: ['src/big.js'],
      comments: [{ path: 'big.js', line: 221, body: 'A suffix names no file.' }],
    }),
  );
  assert.equal(
    uncoveredHunks(chaptersOf(plan), diff)[0].hunks.length,
    2,
    'text and a comment on a path that is not the full one cover nothing',
  );
  plan.chapters[1].refs = [{ id: 'work', path: 'src/big.js', start: 105, end: 110 }];
  plan.chapters[1].comments = [{ path: 'src/big.js', line: 221, body: 'Could you confirm?' }];
  assert.deepEqual(
    uncoveredHunks(chaptersOf(plan), diff),
    [],
    "a later chapter's ref and comment cover the rest",
  );
});

test('"whole": true and a "Since you read it" chapter cover a big file; a file in no chapter is left to placement', () => {
  const diff = parseUnifiedDiff(DIFF);
  const whole = { chapters: [chapter({ files: [{ rel: 'src/big.js', whole: true }] })] };
  assert.deepEqual(uncoveredHunks(chaptersOf(whole), diff), []);
  // with refs too: they are jump targets, and whole still covers the rest
  const wholeWithLines = {
    chapters: [
      chapter({
        files: [{ rel: 'src/big.js', whole: true }],
        refs: [{ id: 'top', path: 'src/big.js', side: 'R', start: 1, end: 2 }],
      }),
    ],
  };
  assert.deepEqual(uncoveredHunks(chaptersOf(wholeWithLines), diff), []);
  const since = {
    chapters: [
      chapter({
        files: ['src/big.js'],
        since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 },
      }),
    ],
  };
  assert.deepEqual(uncoveredHunks(chaptersOf(since), diff), []);
  const plain = { chapters: [chapter({ files: ['src/big.js'] })] };
  assert.equal(
    uncoveredHunks(chaptersOf(plain), diff)[0].hunks.length,
    3,
    'listed with no refs, a big file has all its hunks uncovered',
  );
});

function scratch(plan: Plan): string {
  const dir = tmp('cover');
  writeFileSync(path.join(dir, 'pr.diff'), DIFF);
  writeJson(path.join(dir, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Add widgets',
  });
  writeJson(path.join(dir, 'chapters.json'), plan);
  return dir;
}

test('build refuses a story with hunks not covered, naming them, and --allow-uncovered keeps them in file-map.json', async () => {
  const dir = scratch({
    chapters: [
      chapter({
        files: ['src/big.js', 'src/small.js', 'old.js'],
        refs: [{ id: 'first', path: 'src/big.js', side: 'R', start: 10, end: 31 }],
      }),
    ],
  });
  await assert.rejects(
    run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']),
    (err: Error & { stderr: string }) => {
      assert.match(err.stderr, /hunks not covered: 2 in 1 files/);
      assert.match(err.stderr, /src\/big\.js:100-121, src\/big\.js:200-221/);
      assert.match(err.stderr, /"whole": true/);
      return true;
    },
  );
  const { stderr } = await run(process.execPath, [
    STORY,
    'build',
    '--dir',
    dir,
    '--no-bridge',
    '--allow-uncovered',
  ]);
  assert.match(stderr, /3 of 5 hunks covered/);
  const map: FileMap = JSON.parse(readFileSync(path.join(dir, 'file-map.json'), 'utf8'));
  assert.deepEqual(
    map.uncovered_hunks![0].hunks.map((hunk) => hunk.ref),
    ['src/big.js:100-121', 'src/big.js:200-221'],
  );
});

test('build passes and writes no uncovered_hunks when every hunk is told', async () => {
  const dir = scratch({
    chapters: [chapter({ files: [{ rel: 'src/big.js', whole: true }, 'src/small.js', 'old.js'] })],
  });
  const { stderr } = await run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']);
  assert.match(stderr, /5 of 5 hunks covered/);
  const map: FileMap = JSON.parse(readFileSync(path.join(dir, 'file-map.json'), 'utf8'));
  assert.equal(map.uncovered_hunks, undefined);
});

test("the bridge serves a published story's uncovered hunks for the panel's Overview note", async () => {
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  const map = JSON.parse(readFileSync(path.join(dir, 'file-map.json'), 'utf8'));
  const uncovered = [
    { rel: 'src/a.js', hunks: [{ side: 'R', start: 40, end: 58, ref: 'src/a.js:40-58' }] },
  ];
  writeJson(path.join(dir, 'file-map.json'), { ...map, uncovered_hunks: uncovered });
  const bridge = await startBridge({ home });
  try {
    const { body } = await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7');
    assert.deepEqual(body.uncovered_hunks, uncovered);
  } finally {
    await bridge.close();
  }
});

test('a skeleton (the plan, with no narratives yet) builds and passes the same checks, and a chapter with no text is unwritten', async () => {
  const dir = scratch({
    mode: 'journey',
    chapters: [
      chapter({
        title: 'Chapter 1: Big',
        headline: 'The big file lands.',
        files: [{ rel: 'src/big.js', whole: true }],
        refs: [{ id: 'first', path: 'src/big.js', side: 'R', start: 10, end: 31 }],
      }),
      chapter({
        title: 'Chapter 2: The rest',
        headline: 'The rest.',
        files: ['src/small.js', 'old.js'],
      }),
    ],
  });
  const { stderr } = await run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']);
  assert.match(stderr, /5 of 5 hunks covered/);

  const plan: Plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  plan.chapters![0].narrative = '### Chapter 1: Big\n\nThe big file.';
  const chapters = chaptersOf(plan);
  chapters.push({ ...chapters[1], key: 'since', since: { from: 'a', to: 'b', commits: 1 } });
  chapters.push({ ...chapters[1], key: 'auto', auto: true });
  markUnwritten(chapters, plan);
  assert.deepEqual(
    chapters.map((each) => !!each.unwritten),
    [false, true, false, false],
    'only a chapter with no text, not a since or leftover chapter',
  );
  const folders = chaptersOf({ chapters: [chapter({ files: ['src/small.js'] })] });
  markUnwritten(folders, { mode: 'by-folder' });
  assert.equal(folders[0].unwritten, undefined, "a by-folder story's text never comes");
});

test('build gives chapters their keys and writes them back, and refuses a chapter with no refs list', async () => {
  const dir = scratch({
    chapters: [
      chapter({ title: 'Chapter 1: Big', files: [{ rel: 'src/big.js', whole: true }] }),
      chapter({ title: 'Chapter 2: The rest', files: ['src/small.js', 'old.js'] }),
    ],
  });
  const { stderr } = await run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']);
  assert.match(stderr, /Gave 2 chapters a key: big, the rest/);
  const written: Plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  assert.deepEqual(
    written.chapters!.map((each) => each.key),
    ['big', 'the rest'],
  );

  delete written.chapters![1].refs;
  writeJson(path.join(dir, 'chapters.json'), written);
  await assert.rejects(
    run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']),
    (err: Error & { stderr: string }) => {
      assert.match(err.stderr, /chapter 2 has no refs list/);
      return true;
    },
  );
});

test("an older story's text references do not change what its hunks need: the same as before refs", () => {
  const two = parseUnifiedDiff(
    [
      ...modified('src/two.js', [
        [10, 2],
        [50, 2],
      ]),
      '',
    ].join('\n'),
  );
  // a chapter as an older story wrote it: no `refs` list
  const told = (fields: PlanChapter) =>
    chaptersOf(
      upgradePlan({ chapters: [{ title: 'Chapter', files: ['src/two.js'], ...fields }] }, [
        ...two.keys(),
      ]),
    );
  // listed and small: covered by the listing, and a text reference to one hunk does not take that away
  assert.deepEqual(uncoveredHunks(told({ narrative: 'See `two.js:11`.' }), two), []);
  const [text] = told({ narrative: 'See `two.js:11`.' });
  assert.equal(text.files[0].lines, undefined, 'and gives the file no lines of its own');
  assert.equal(text.refs[0].text, true);
  // a `lines` range is a pointer the author chose, as it was: the other hunk then needs pointing at
  const lines = told({
    files: [{ rel: 'src/two.js', lines: [{ side: 'R', start: 11, end: 12 }] }],
  });
  assert.deepEqual(
    uncoveredHunks(lines, two).map((file) => file.hunks.map((hunk) => hunk.start)),
    [[50]],
  );
});
