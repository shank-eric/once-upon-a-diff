import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { parseUnifiedDiff } from '../src/diff.ts';
import { mergeFragments, sliceOf } from '../src/fragments.ts';
import type { Plan } from '../src/chapters.ts';

const STORY = fileURLToPath(new URL('../../../../skills/once-upon/bin/story.mjs', import.meta.url));
const run = promisify(execFile);

/** A modified file's diff with one hunk per [newStart, added] pair, a line of context on either side. */
function modified(rel: string, hunks: [number, number][]): string[] {
  const out = [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`];
  for (const [start, added] of hunks) {
    out.push(`@@ -${start},2 +${start},${added + 2} @@ fn`, ' before');
    for (let i = 0; i < added; i++) {
      out.push(`+line ${start + 1 + i}`);
    }
    out.push(' after');
  }
  return out;
}

// every file is small, so listing it covers it. New-side lines 10-13 are the added ones in each.
const DIFF = [
  ...['src/a.js', 'src/b.js', 'test/b.test.js', 'src/board.ts', 'web/board.ts', 'src/d.js'].flatMap(
    (rel) => modified(rel, [[10, 2]]),
  ),
  '',
].join('\n');
const diff = parseUnifiedDiff(DIFF);

const plan = (): Plan => ({
  mode: 'journey',
  chapters: [
    { key: 'a', title: 'Chapter 1: A', headline: 'A.', files: ['src/a.js'], refs: [] },
    {
      key: 'b',
      title: 'Chapter 2: B',
      headline: 'B.',
      files: ['src/b.js', 'test/b.test.js'],
      refs: [],
    },
    {
      key: 'c',
      title: 'Chapter 3: C',
      headline: 'C.',
      files: ['src/board.ts', 'web/board.ts'],
      refs: [],
    },
    {
      key: 'd',
      title: 'Chapter 4: D',
      headline: 'D.',
      files: ['src/d.js', { rel: 'src/a.js', partial: true }],
      refs: [],
    },
  ],
});

const text = (num: number) => `### Chapter ${num}: Told\n\nIt does a thing.`;

test('a fragment fills an empty chapter, with its answer and comments, and leaves the input plan alone', () => {
  const input = plan();
  const { plan: out, outcomes } = mergeFragments(
    input,
    [
      {
        key: 'a',
        narrative: `${text(1)} See [the line](ref:new).`,
        answer: 'Short.',
        refs: [{ id: 'new', path: 'src/a.js', side: 'R', start: 11, end: 11 }],
        comments: [
          { path: 'src/a.js', line: 11, body: 'Could you confirm?' },
          { body: 'General.' },
        ],
        title: 'Ignored',
        files: ['x.js'],
      },
    ],
    diff,
  );
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.key, outcome.status]),
    [['a', 'merged']],
  );
  const chapter = out.chapters![0];
  assert.match(chapter.narrative!, /^### Chapter 1/);
  assert.equal(chapter.answer, 'Short.');
  assert.deepEqual(chapter.comments, [
    { path: 'src/a.js', line: 11, body: 'Could you confirm?' },
    { path: '(general)', line: 0, body: 'General.' },
  ]);
  assert.deepEqual(chapter.refs, [{ id: 'new', path: 'src/a.js', side: 'R', start: 11, end: 11 }]);
  assert.equal(chapter.title, 'Chapter 1: A', 'a fragment cannot retitle');
  assert.deepEqual(chapter.files, ['src/a.js'], 'or move files');
  assert.equal(input.chapters![0].narrative, undefined, 'the input plan is not changed');
});

test('a second merge changes nothing, and a chapter that already has text is skipped, not overwritten', () => {
  const fragments = [{ key: 'b', narrative: text(2) }];
  const first = mergeFragments(plan(), fragments, diff);
  const again = mergeFragments(first.plan, fragments, diff);
  assert.deepEqual(again.plan, first.plan);
  assert.equal(again.outcomes[0].status, 'skipped');

  const kept = plan();
  kept.chapters![0].narrative = 'Kept chapter, byte for byte.';
  kept.chapters![0].comments = [{ path: 'src/a.js', line: 10, body: 'carried', carried: true }];
  const out = mergeFragments(kept, [{ key: 'a', narrative: 'Other.' }], diff);
  assert.equal(out.outcomes[0].status, 'skipped');
  assert.deepEqual(out.plan.chapters![0], kept.chapters![0]);
});

test('several fragments merge in one call, in any order, and each is judged on its own', () => {
  const { plan: out, outcomes } = mergeFragments(
    plan(),
    [
      { key: 'c', narrative: text(3) },
      { key: 'a', narrative: text(1) },
      { key: 'nope', narrative: 'x' },
    ],
    diff,
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['merged', 'merged', 'rejected'],
  );
  assert.ok(out.chapters![0].narrative && out.chapters![2].narrative);
  assert.equal(out.chapters![1].narrative, undefined);
});

test("comments go after the chapter's earlier drafts, without an exact duplicate", () => {
  const input = plan();
  input.chapters![0].comments = [{ path: 'src/a.js', line: 11, body: 'Carried.', carried: true }];
  const { plan: out } = mergeFragments(
    input,
    [
      {
        key: 'a',
        narrative: text(1),
        comments: [
          { path: 'src/a.js', line: 11, body: 'Carried.' },
          { path: 'src/a.js', line: 12, body: 'New.' },
        ],
      },
    ],
    diff,
  );
  assert.deepEqual(
    out.chapters![0].comments!.map((comment) => comment.body),
    ['Carried.', 'New.'],
  );
  assert.equal(out.chapters![0].comments![0].carried, true, 'the carried one keeps its mark');
});

test('a fragment is refused, and its chapter stays unwritten, for each of these', () => {
  const refused = (fragment: unknown, why: RegExp) => {
    const { plan: out, outcomes } = mergeFragments(plan(), [fragment], diff);
    assert.equal(outcomes[0].status, 'rejected', JSON.stringify(fragment));
    assert.match(outcomes[0].why, why);
    assert.deepEqual(out, plan(), 'nothing merged');
  };
  refused(null, /not a JSON object/);
  refused({ narrative: 'x' }, /no key/);
  refused({ key: 'a', narrative: '   ' }, /no narrative/);
  refused({ key: 'zzz', narrative: 'x' }, /no chapter has this key/);
  refused({ key: 'a', narrative: 'x', comments: 'no' }, /comments is not a list/);
  refused({ key: 'a', narrative: 'x', comments: [{ path: 'src/a.js', line: 11 }] }, /no body/);
  refused({ key: 'a', narrative: 'x', comments: [{ path: 'src/a.js', body: 'b' }] }, /no line/);
  refused(
    { key: 'a', narrative: 'x', comments: [{ path: 'src/b.js', line: 11, body: 'b' }] },
    /does not list/,
  );
  refused(
    { key: 'a', narrative: 'x', comments: [{ path: 'src/a.js', line: 99, body: 'b' }] },
    /not on a line in the diff/,
  );
  // a ref on a file the chapter doesn't list would add it to the chapter and move where it finishes
  refused(
    { key: 'b', narrative: 'See [it](ref:x).', refs: [{ id: 'x', path: 'src/a.js', start: 11 }] },
    /ref "x" is on src\/a\.js, which the chapter does not list/,
  );
  refused({ key: 'a', narrative: 'x', refs: 'no' }, /refs is not a list/);
  // the text links to a ref the chapter does not have
  refused({ key: 'c', narrative: 'The [board](ref:board) file.' }, /links to ref:board/);
  // a comment's path is the full path: a suffix names no file
  refused(
    { key: 'c', narrative: 'x', comments: [{ path: 'board.ts', line: 11, body: 'b' }] },
    /board\.ts, which the chapter does not list \(write the file's full path\)/,
  );
  // a ref id the chapter has, on other lines
  const held = plan();
  held.chapters![0].refs = [{ id: 'new', path: 'src/a.js', start: 10, end: 12 }];
  const clash = mergeFragments(
    held,
    [{ key: 'a', narrative: 'x', refs: [{ id: 'new', path: 'src/a.js', start: 11 }] }],
    diff,
  );
  assert.match(clash.outcomes[0].why, /ref "new" is already in the chapter/);
});

test('text that names files is just text, and an old-side comment is checked on the old side', () => {
  const { outcomes } = mergeFragments(
    plan(),
    [
      {
        key: 'c',
        narrative:
          'The `src/board.ts` file and `web/board.ts:11`, not `a.js`.\n\n```\nsrc/a.js:11\n```',
        comments: [{ path: 'src/board.ts', line: 11, body: 'Old side.', side: 'L' }],
      },
      { key: 'b', narrative: 'The tests in `a.js` and `src/a.js` by name only.' },
    ],
    diff,
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['merged', 'merged'],
  );
});

test('a "Since you read it" chapter is not merged into, and two chapters with one key refuse', () => {
  const input = plan();
  input.chapters!.unshift({
    key: 'since-1',
    since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 },
    files: ['src/a.js'],
  });
  const dup = mergeFragments(input, [{ key: 'since-1', narrative: 'x' }], diff);
  assert.match(dup.outcomes[0].why, /Since you read it/);
  input.chapters![1].key = 'b';
  const two = mergeFragments(input, [{ key: 'b', narrative: 'x' }], diff);
  assert.match(two.outcomes[0].why, /2 chapters share this key/);
});

test('a chapter with no key is found by the key its title gives it', () => {
  const input = plan();
  delete input.chapters![1].key;
  const { outcomes } = mergeFragments(input, [{ key: 'b', narrative: text(2) }], diff);
  assert.equal(outcomes[0].status, 'merged');
});

test('sliceOf gives the map, neighbours, points and the chapter files numbered on each side', () => {
  const withDeleted = parseUnifiedDiff(
    [
      DIFF,
      'diff --git a/src/b.js b/src/b.js',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -20,3 +20,2 @@ g',
      ' keep',
      '-gone',
      ' tail',
      '',
    ].join('\n'),
  );
  const out = sliceOf(plan(), 'b', withDeleted, {
    b: { points: ['It does X'], hands_off: ['A owns the loader'] },
  })!;
  assert.match(out, /^# Chapter to write: Chapter 2: B/);
  assert.match(out, /Previous chapter: Chapter 1: A: A\./);
  assert.match(out, /Next chapter: Chapter 3: C: C\./);
  assert.match(out, /2\. Chapter 2: B: B\. {2}<- yours/);
  assert.match(out, /- It does X/);
  assert.match(out, /- A owns the loader/);
  assert.match(out, /### src\/b\.js/);
  assert.match(out, /### test\/b\.test\.js/);
  assert.match(out, /R11\t\+line 11/);
  assert.match(out, /L21\t-gone/);
  assert.doesNotMatch(out, /src\/a\.js \(/, "only the chapter's own files");
  assert.equal(
    sliceOf(plan(), '2', diff),
    sliceOf(plan(), 'b', diff),
    'a number names the chapter too',
  );
  assert.equal(sliceOf(plan(), 'nope', diff), null);
});

/** A scratch folder as story.mjs reads it: pr.diff, pr.json, chapters.json and fragments/. */
function scratch(fragments: Record<string, unknown>): string {
  const dir = tmp('fragments');
  writeFileSync(path.join(dir, 'pr.diff'), DIFF);
  writeJson(path.join(dir, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
  });
  writeJson(path.join(dir, 'chapters.json'), plan());
  mkdirSync(path.join(dir, 'fragments'));
  for (const [name, value] of Object.entries(fragments)) {
    if (typeof value === 'string') {
      writeFileSync(path.join(dir, 'fragments', name), value);
    } else {
      writeJson(path.join(dir, 'fragments', name), value);
    }
  }
  return dir;
}

test('story.mjs merge writes chapters.json, says what happened per fragment and exits 1 only when one is refused', async () => {
  const dir = scratch({
    '01-a.json': { key: 'a', narrative: text(1) },
    '02-b.json': {
      key: 'b',
      narrative: 'See [it](ref:x).',
      refs: [{ id: 'x', path: 'src/a.js', start: 11 }],
    },
    '03-bad.json': '{not json',
  });
  await assert.rejects(
    run(process.execPath, [STORY, 'merge', '--dir', dir]),
    (err: Error & { stderr: string; code: number }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /merged\s+01-a\.json \(a\)/);
      assert.match(err.stderr, /rejected\s+02-b\.json \(b\): .*does not list/);
      assert.match(err.stderr, /rejected\s+03-bad\.json/);
      assert.match(err.stderr, /1 merged, 2 refused, 3 chapters still without text/);
      return true;
    },
  );
  const written: Plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  assert.match(written.chapters![0].narrative!, /Chapter 1/);
  assert.equal(written.chapters![1].narrative, undefined);

  // fix the refused ones, run again: the first stays as it is, the rest land, exit 0
  writeJson(path.join(dir, 'fragments', '02-b.json'), { key: 'b', narrative: text(2) });
  writeJson(path.join(dir, 'fragments', '03-bad.json'), { key: 'c', narrative: text(3) });
  const { stderr } = await run(process.execPath, [STORY, 'merge', '--dir', dir]);
  assert.match(stderr, /skipped\s+01-a\.json/);
  assert.match(stderr, /2 merged, 0 refused, 1 chapters still without text/);
});

test('story.mjs merge with no fragments folder is a no-op, and slice prints a chapter or fails naming the flag', async () => {
  const dir = scratch({});
  const before = readFileSync(path.join(dir, 'chapters.json'), 'utf8');
  const { stderr } = await run(process.execPath, [STORY, 'merge', '--dir', dir]);
  assert.match(stderr, /0 merged, 0 refused, 4 chapters still without text/);
  assert.equal(readFileSync(path.join(dir, 'chapters.json'), 'utf8'), before);

  writeJson(path.join(dir, 'points.json'), { d: { points: ['The tail.'] } });
  const out = await run(process.execPath, [STORY, 'slice', '--dir', dir, '--chapter', 'd']);
  assert.match(out.stdout, /# Chapter to write: Chapter 4: D/);
  assert.match(out.stdout, /- The tail\./);
  await assert.rejects(run(process.execPath, [STORY, 'slice', '--dir', dir]), /--chapter/);
});

test('a comment is a duplicate only on the same path, side, line and body, and one fragment does not repeat itself', () => {
  const input = plan();
  input.chapters![0].comments = [{ path: 'src/a.js', line: 11, body: 'Same.' }];
  const { plan: out } = mergeFragments(
    input,
    [
      {
        key: 'a',
        narrative: text(1),
        comments: [
          { path: 'src/a.js', line: 11, body: 'Same.', side: 'L' }, // old side: a different comment
          { path: 'src/a.js', line: 11, body: 'Same.' }, // the existing one
          { path: 'src/a.js', line: 12, body: 'Twice.' },
          { path: 'src/a.js', line: 12, body: 'Twice.' },
        ],
      },
    ],
    diff,
  );
  assert.deepEqual(
    out.chapters![0].comments!.map((comment) => [comment.line, comment.body, comment.side]),
    [
      [11, 'Same.', undefined],
      [11, 'Same.', 'L'],
      [12, 'Twice.', undefined],
    ],
  );
});

test('the packet numbers chapters as the reader sees them: a "Since you read it" chapter has no number and is no neighbour', () => {
  const input = plan();
  input.chapters!.unshift({
    key: 'since-1',
    title: 'Since you read it: 1 new commit',
    headline: 'New.',
    since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 },
    files: ['src/a.js'],
  });
  const first = sliceOf(input, '1', diff)!; // the reader's chapter 1 is `a`, the second in the list
  assert.match(first, /^# Chapter to write: Chapter 1: A/);
  assert.match(first, /number: 1\n/);
  assert.match(first, /Previous chapter: none\n/, 'the since chapter is not a neighbour');
  assert.match(first, /Next chapter: Chapter 2: B/);
  assert.match(first, /-\. Since you read it: 1 new commit: New\. {2}\(not numbered\)/);
  assert.match(first, /1\. Chapter 1: A: A\. {2}<- yours/);
  assert.match(first, /4\. Chapter 4: D/, 'the last numbered chapter is 4, not 5');
  assert.match(sliceOf(input, 'since-1', diff)!, /number: none/);
  assert.equal(sliceOf(input, '5', diff), null, 'there is no reader chapter 5');
});

/** A git checkout with a base commit and a head commit that changes two files. */
function checkout(): string {
  const repo = tmp('local-repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'A');
  git('config', 'commit.gpgsign', 'false');
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  writeFileSync(path.join(repo, 'a.js'), body.join('\n') + '\n');
  writeFileSync(path.join(repo, 'b.js'), body.join('\n') + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(
    path.join(repo, 'a.js'),
    body.map((row, i) => (i === 9 ? 'changed' : row)).join('\n') + '\n',
  );
  writeFileSync(
    path.join(repo, 'b.js'),
    body.map((row, i) => (i === 4 ? 'other' : row)).join('\n') + '\n',
  );
  git('commit', '-q', '-am', 'head');
  return repo;
}

test('a local story has no pr.diff: merge and slice take its range, or a --diff file, and say what is missing', async () => {
  const repo = checkout();
  const dir = tmp('local-d'); // a local story's scratch folder: chapters.json and fragments, no pr.diff, no pr.json
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [
      { key: 'a', title: 'Chapter 1: A', files: ['a.js'] },
      { key: 'b', title: 'Chapter 2: B', files: ['b.js'] },
    ],
  });
  writeJson(path.join(dir, 'fragments', 'a.json'), {
    key: 'a',
    narrative: text(1) + ' See `a.js:10`.',
  });
  const range = ['--repo', repo, '--base', 'main', '--head', 'feature'];

  await assert.rejects(run(process.execPath, [STORY, 'merge', '--dir', dir]), /no diff to read/);
  const sliced = await run(process.execPath, [
    STORY,
    'slice',
    '--dir',
    dir,
    '--chapter',
    'b',
    ...range,
  ]);
  assert.match(sliced.stdout, /### b\.js \(modified, \+1 -1\)/);
  assert.match(sliced.stdout, /R5\t\+other/);
  assert.match(sliced.stdout, /L5\t-line 5/);

  const { stderr } = await run(process.execPath, [STORY, 'merge', '--dir', dir, ...range]);
  assert.match(stderr, /merged\s+a\.json \(a\)/);
  assert.match(stderr, /1 merged, 0 refused, 1 chapters still without text/);

  // the same through a --diff file
  const file = path.join(dir, 'range.diff');
  writeFileSync(file, execFileSync('git', ['-C', repo, 'diff', 'main', 'feature']));
  writeJson(path.join(dir, 'fragments', 'b.json'), { key: 'b', narrative: text(2) });
  const viaFile = await run(process.execPath, [STORY, 'merge', '--dir', dir, '--diff', file]);
  assert.match(viaFile.stderr, /2 merged|1 merged/);
  assert.match(viaFile.stderr, /0 chapters still without text/);
});

test('--clear removes fragments left by an earlier telling, so a rebuild is not filled with old text and an orphan does not fail merge', async () => {
  const dir = scratch({
    'a.json': { key: 'a', narrative: 'The OLD telling of chapter 1.' },
    'gone.json': { key: 'removed-in-the-rebuild', narrative: 'x' },
  });
  // the rebuild's skeleton: the chapters are unwritten again, the folder is the same
  const cleared = await run(process.execPath, [STORY, 'merge', '--dir', dir, '--clear']);
  assert.match(cleared.stderr, /cleared 2 fragments/);
  const { stderr } = await run(process.execPath, [STORY, 'merge', '--dir', dir]); // exits 0: nothing stale is left
  assert.match(stderr, /0 merged, 0 refused, 4 chapters still without text/);
  const untouched: Plan = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  assert.equal(untouched.chapters![0].narrative, undefined);

  // a fragment the new writer hands back lands as usual; --clear only touches .json fragments, in this folder
  writeJson(path.join(dir, 'fragments', 'a.json'), { key: 'a', narrative: text(1) });
  const again = await run(process.execPath, [STORY, 'merge', '--dir', dir]);
  assert.match(again.stderr, /1 merged/);
});

test("the packet lists the chapter's refs, so its writer links to them by id", () => {
  const input = plan();
  input.chapters![1].refs = [
    { id: 'loader', path: 'src/b.js', side: 'R', start: 11, end: 12, label: 'the loader' },
  ];
  const out = sliceOf(input, 'b', diff)!;
  assert.match(out, /## Refs this chapter has/);
  assert.match(out, /- loader: src\/b\.js R11-12 the loader/);
  assert.match(sliceOf(plan(), 'b', diff)!, /\(none yet\)/);
});

test('a fragment that repeats a planned ref with the same lines is fine, whatever its label; other lines are refused, saying where', () => {
  const input = plan();
  input.chapters![0].refs = [
    { id: 'new', path: 'src/a.js', side: 'R', start: 10, end: 12, label: 'the planned label' },
  ];
  const same = (ref: Record<string, unknown>) =>
    mergeFragments(input, [{ key: 'a', narrative: 'See [it](ref:new).', refs: [ref] }], diff);
  for (const ref of [
    { id: 'new', path: 'src/a.js', start: 10, end: 12 },
    { id: 'new', path: 'src/a.js', side: 'R', start: 10, end: 12, label: 'another label' },
  ]) {
    const merged = same(ref);
    assert.equal(merged.outcomes[0].status, 'merged', JSON.stringify(ref));
    assert.deepEqual(
      merged.plan.chapters![0].refs,
      input.chapters![0].refs,
      "the chapter's own ref stays",
    );
  }
  const moved = same({ id: 'new', path: 'src/a.js', start: 11, end: 12 });
  assert.equal(moved.outcomes[0].status, 'rejected');
  assert.match(
    moved.outcomes[0].why,
    /ref "new" is already in the chapter on src\/a\.js R10-12, and the fragment has it on src\/a\.js R11-12/,
  );
});
