import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmp, writeJson, githubStory, startBridge } from './helpers.mjs';
import { parseUnifiedDiff } from '../bridge/util/diff.mjs';
import { chaptersOf } from '../bridge/stories/chapters.mjs';
import { uncoveredHunks, SMALL_FILE_LINES } from '../bridge/stories/hunk-coverage.mjs';

const STORY = fileURLToPath(new URL('../skills/once-upon/bin/story.mjs', import.meta.url));
const run = promisify(execFile);

/** A modified file's diff with one hunk per [newStart, added] pair, each with a line of context on either side. */
function modified(rel, hunks) {
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

const chapter = (fields) => ({ title: 'Chapter', narrative: '', comments: [], ...fields });

test('a hunk is covered by a lines range, a text reference or a comment; a small file by its listing', () => {
  const diff = parseUnifiedDiff(DIFF);
  assert.ok(diff.get('src/big.js').stats.added > SMALL_FILE_LINES);
  const plan = {
    chapters: [
      chapter({
        files: [
          { rel: 'src/big.js', lines: [{ side: 'R', start: 12, end: 14 }] },
          'src/small.js',
          'old.js',
        ],
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
      narrative: 'Then `big.js:105-110` does the work.',
      files: ['src/big.js'],
      comments: [{ path: 'big.js', line: 221, body: 'Could you confirm?' }],
    }),
  );
  assert.deepEqual(
    uncoveredHunks(chaptersOf(plan), diff),
    [],
    "a later chapter's text and comment cover the rest",
  );
});

test('"whole": true and a "Since you read it" chapter cover a big file; a file in no chapter is left to placement', () => {
  const diff = parseUnifiedDiff(DIFF);
  const whole = { chapters: [chapter({ files: [{ rel: 'src/big.js', whole: true }] })] };
  assert.deepEqual(uncoveredHunks(chaptersOf(whole), diff), []);
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
    'listed with no lines, a big file has all its hunks uncovered',
  );
});

function scratch(plan) {
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
        files: [
          { rel: 'src/big.js', lines: [{ side: 'R', start: 10, end: 31 }] },
          'src/small.js',
          'old.js',
        ],
      }),
    ],
  });
  await assert.rejects(
    run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']),
    (err) => {
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
  const map = JSON.parse(readFileSync(path.join(dir, 'file-map.json'), 'utf8'));
  assert.deepEqual(
    map.uncovered_hunks[0].hunks.map((hunk) => hunk.ref),
    ['src/big.js:100-121', 'src/big.js:200-221'],
  );
});

test('build passes and writes no uncovered_hunks when every hunk is told', async () => {
  const dir = scratch({
    chapters: [chapter({ files: [{ rel: 'src/big.js', whole: true }, 'src/small.js', 'old.js'] })],
  });
  const { stderr } = await run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']);
  assert.match(stderr, /5 of 5 hunks covered/);
  const map = JSON.parse(readFileSync(path.join(dir, 'file-map.json'), 'utf8'));
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
    const { body } = await bridge.call('GET', '/api/stories/acme-widgets-7');
    assert.deepEqual(body.uncovered_hunks, uncovered);
  } finally {
    await bridge.close();
  }
});
