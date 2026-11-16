import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { localRepo } from '@once-upon-a-diff/test-kit/git';
import { chaptersOf, type Plan, type PlanChapter } from '../src/chapters.ts';
import { parseUnifiedDiff } from '../src/diff.ts';
import { expandHunks, hunkIdsOf } from '../src/hunk-ids.ts';
import { uncoveredHunks } from '../src/hunk-coverage.ts';
import { sliceOf } from '../src/fragments.ts';
import { storyFindings } from '../src/quality.ts';
import { createLocalStory } from '../src/local-story.ts';
import { noteTiming } from '../src/timings.ts';

// hunk ids in a plan: `"hunks": ["h1"]` on a chapter builds into refs that cover the hunk
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'story-evals');
const ROOT = path.resolve(HERE, '../../../..');
const STORY = path.join(ROOT, 'skills/once-upon/bin/story.mjs');
const run = promisify(execFile);

/** The recorded edge-kinds story with no ref on src/widgets.js, and its three hunks (h1, h2, h3) named by id. */
function byId(): Plan {
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'edge-kinds', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const first = (plan.chapters as PlanChapter[])[0];
  first.files = ['src/widgets.js', 'src/small.js'];
  first.refs = first.refs!.filter((ref) => ref.path !== 'src/widgets.js' || ref.id === 'first');
  first.narrative = first.narrative!.replace(/\[([^\]]+)\]\(ref:(?!first\))\w+\)/g, '$1');
  first.hunks = ['h1', 'h2', 'h3'];
  // a ref counts when the text links it, the ids' refs included
  first.narrative += ' See [the first](ref:h1), [the second](ref:h2) and [the third](ref:h3).';
  return plan;
}

function scratch(name: string, plan: Plan): string {
  const dir = tmp(`hunk-ids-${name}`);
  cpSync(path.join(FIXTURES, name, 'pr.json'), path.join(dir, 'pr.json'));
  cpSync(path.join(FIXTURES, name, 'pr.diff'), path.join(dir, 'pr.diff'));
  writeJson(path.join(dir, 'chapters.json'), plan);
  return dir;
}

async function story(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [STORY, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('build: a chapter with "hunks" gets refs that cover those hunks, written back', async () => {
  const dir = scratch('edge-kinds', byId());
  const built = await story('build', '--dir', dir, '--no-bridge');
  assert.equal(built.code, 0, built.stderr);
  assert.doesNotMatch(built.stderr, /hunks not covered/);
  assert.match(built.stderr, /Expanded 3 hunk ids into refs/);
  const written = JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8')) as Plan;
  const first = written.chapters![0];
  assert.equal(first.hunks, undefined);
  const refs = first.refs!.filter((ref) => /^h\d+$/.test(String(ref.id)));
  assert.deepEqual(
    refs.map((ref) => [ref.id, ref.side, ref.start, ref.end]),
    [
      ['h1', 'R', 10, 31],
      ['h2', 'R', 100, 121],
      ['h3', 'R', 200, 221],
    ],
  );
});

const diffOf = (name: string) =>
  parseUnifiedDiff(readFileSync(path.join(FIXTURES, name, 'pr.diff'), 'utf8'));

test('hunkIdsOf: ids run h1.. in diff order across files, a removes-only hunk points at the old side, binary has none', () => {
  const diff = diffOf('edge-kinds');
  const ids = hunkIdsOf(diff);
  assert.deepEqual(
    ids.slice(0, 4).map((entry) => [entry.id, entry.rel, entry.side, entry.start, entry.end]),
    [
      ['h1', 'src/widgets.js', 'R', 10, 31],
      ['h2', 'src/widgets.js', 'R', 100, 121],
      ['h3', 'src/widgets.js', 'R', 200, 221],
      ['h4', 'src/small.js', 'R', 1, 7],
    ],
  );
  const gone = ids.find((entry) => entry.rel === 'legacy/gone.js')!;
  assert.deepEqual([gone.side, gone.start, gone.end], ['L', 1, 50]);
  assert.ok(!ids.some((entry) => entry.rel === 'assets/logo.png'), 'a binary file has no hunks');
  assert.deepEqual(
    hunkIdsOf(diffOf('edge-kinds')).map((entry) => entry.id),
    ids.map((entry) => entry.id),
    'a second parse gives the same ids',
  );
});

test('expandHunks: the refs it makes cover the hunks; a second run changes nothing', () => {
  const diff = diffOf('edge-kinds');
  const plan = byId();
  const first = expandHunks(plan, diff);
  assert.deepEqual(first, { expanded: 3, changed: true, problems: [] });
  assert.deepEqual(uncoveredHunks(chaptersOf(plan), diff), []);
  const after = structuredClone(plan);
  assert.deepEqual(expandHunks(plan, diff), { expanded: 0, changed: false, problems: [] });
  assert.deepEqual(plan, after);
});

test('expandHunks: "hunks" alone gives the chapter its refs list, and a plan with no "hunks" is untouched', () => {
  const diff = diffOf('edge-kinds');
  const bare: Plan = {
    chapters: [{ title: 'One', files: ['src/small.js'], hunks: ['h4'] }, { title: 'Two' }],
  };
  assert.equal(expandHunks(bare, diff).expanded, 1);
  assert.equal(bare.chapters![0].refs!.length, 1);
  assert.equal('hunks' in bare.chapters![0], false);
  assert.equal('refs' in bare.chapters![1], false);
  const plain = JSON.parse(
    readFileSync(path.join(FIXTURES, 'edge-kinds', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const copy = structuredClone(plain);
  assert.deepEqual(expandHunks(plain, diff), { expanded: 0, changed: false, problems: [] });
  assert.deepEqual(plain, copy);
});

test('expandHunks: an unknown id and a file the chapter does not list are problems', () => {
  const diff = diffOf('edge-kinds');
  const total = hunkIdsOf(diff).length;
  const plan: Plan = {
    chapters: [{ files: ['src/widgets.js'], hunks: ['h99', 'h4'] }],
  };
  const { expanded, problems } = expandHunks(plan, diff);
  assert.equal(expanded, 0);
  assert.deepEqual(problems, [
    `chapter 1: hunk h99 is not in the diff (it has h1-h${total})`,
    'chapter 1: hunk h4 is in src/small.js, which the chapter does not list',
  ]);
});

test("expandHunks: an old hN ref is replaced by the hunk's own, wherever it points", () => {
  const diff = diffOf('edge-kinds');
  const stale: Plan = {
    chapters: [
      {
        files: ['src/widgets.js'],
        hunks: ['h2'],
        refs: [
          { id: 'h2', path: 'src/widgets.js', start: 2, end: 8 },
          { id: 'other', path: 'src/widgets.js', start: 1, end: 3 },
        ],
      },
    ],
  };
  assert.deepEqual(expandHunks(stale, diff), { expanded: 1, changed: true, problems: [] });
  const refs = stale.chapters![0].refs!;
  assert.deepEqual(
    refs.map((ref) => [ref.id, ref.start, ref.end]),
    [
      ['h2', 100, 121],
      ['other', 1, 3],
    ],
  );
  assert.equal('hunks' in stale.chapters![0], false);
  const live: Plan = {
    chapters: [
      {
        files: ['src/widgets.js'],
        hunks: ['h2'],
        refs: [{ id: 'h2', path: 'src/widgets.js', start: 105, end: 108 }],
      },
    ],
  };
  assert.deepEqual(expandHunks(live, diff), { expanded: 1, changed: true, problems: [] });
  assert.deepEqual(
    live.chapters![0].refs!.map((ref) => [ref.id, ref.start, ref.end]),
    [['h2', 100, 121]],
  );
});

test('storyFindings reads hunk ids as refs, and an unknown id is a plan fail; the plan itself is not changed', () => {
  const diff = diffOf('edge-kinds');
  const plan = byId();
  const copy = structuredClone(plan);
  const findings = storyFindings(plan, diff);
  assert.ok(!findings.some((finding) => finding.check === 'hunks'));
  assert.deepEqual(plan, copy);
  plan.chapters![0].hunks!.push('h99');
  assert.ok(
    storyFindings(plan, diff).some(
      (finding) => finding.check === 'plan' && /hunk h99 is not in the diff/.test(finding.message),
    ),
  );
});

test('story.mjs check on a plan with hunk ids has no uncovered hunks; an unknown id fails as plan', async () => {
  const ok = await story('check', '--dir', scratch('edge-kinds', byId()));
  assert.doesNotMatch(ok.stdout, /^fail hunks/m);
  const plan = byId();
  plan.chapters![0].hunks!.push('h99');
  const bad = await story('check', '--dir', scratch('edge-kinds', plan));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /^fail plan story: .*hunk h99 is not in the diff/m);
});

test('sliceOf lists the refs a chapter gets from its hunk ids', () => {
  const diff = diffOf('edge-kinds');
  const packet = sliceOf(byId(), '1', diff)!;
  assert.match(packet, /- h2: src\/widgets\.js R100-121/);
  assert.match(packet, /- h3: src\/widgets\.js R200-221/);
});

test('build: a hunk id in a file the chapter does not list is refused naming the file', async () => {
  const plan = byId();
  plan.chapters![0].files = ['src/small.js'];
  const built = await story('build', '--dir', scratch('edge-kinds', plan), '--no-bridge');
  assert.equal(built.code, 1);
  assert.match(
    built.stderr,
    /hunks:\n.*chapter 1: hunk h1 is in src\/widgets\.js, which the chapter does not list/,
  );
});

test('timings: build and check each add a line with their command and milliseconds; a failure is marked', async () => {
  const dir = scratch('edge-kinds', byId());
  await story('build', '--dir', dir, '--no-bridge');
  await story('check', '--dir', dir);
  const bad = byId();
  bad.chapters![0].hunks!.push('h99');
  writeJson(path.join(dir, 'chapters.json'), bad);
  const refused = await story('build', '--dir', dir, '--no-bridge'); // throws
  const failed = await story('check', '--dir', dir); // exits 1 without throwing
  assert.equal(refused.code, 1);
  assert.equal(failed.code, 1);
  const lines = readFileSync(path.join(dir, 'timings.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((line) => [line.command, line.failed ?? false]),
    [
      ['build', false],
      ['check', false],
      ['build', true],
      ['check', true],
    ],
  );
  assert.ok(lines.every((line) => typeof line.ms === 'number' && typeof line.at === 'string'));
  assert.equal(lines[0].expanded, 3);
  assert.equal(typeof lines[0].hunks, 'number');
});

test('noteTiming never throws, even when the folder is missing', () => {
  assert.doesNotThrow(() =>
    noteTiming(path.join(tmp('no-timings'), 'missing', 'deeper'), { command: 'build', ms: 1 }),
  );
});

test('brief of a local range: hunk ids with their files, hunks.txt with line numbers, no pr', async () => {
  const { repo, base } = localRepo();
  const dir = tmp('brief-local');
  const briefed = await story(
    'brief',
    '--dir',
    dir,
    '--repo',
    repo,
    '--base',
    base,
    '--head',
    'HEAD',
  );
  assert.equal(briefed.code, 0, briefed.stderr);
  const brief = JSON.parse(briefed.stdout) as {
    pr?: unknown;
    local: { base_oid: string };
    files: { rel: string; hunks: string[] }[];
    hunks: { id: string; path: string; side: string; start: number; end: number }[];
    commits: { subject: string }[];
  };
  assert.equal(brief.pr, undefined);
  assert.equal(brief.local.base_oid, base);
  assert.deepEqual(
    brief.hunks.map((hunk) => [hunk.id, hunk.path, hunk.side, hunk.start, hunk.end]),
    [
      ['h1', 'gone.txt', 'L', 1, 1],
      ['h2', 'lib/two.js', 'R', 1, 1],
      ['h3', 'one.txt', 'R', 1, 4],
    ],
  );
  assert.deepEqual(
    brief.files.map((file) => file.hunks),
    [['h1'], ['h2'], ['h3']],
  );
  assert.deepEqual(
    brief.commits.map((commit) => commit.subject),
    ['add two', 'change one'],
  );
  const text = readFileSync(path.join(dir, 'hunks.txt'), 'utf8');
  assert.match(text, /^## h3 {2}R1-4 {2}\+2 -1/m);
  assert.match(text, /^L2\t-b$/m);
  assert.match(text, /^R2\t\+B$/m);
  assert.match(text, /### gone\.txt \(deleted.* h1-h1: listing the file covers it/);
});

test('brief of a PR folder keeps its old keys and adds the hunks; with neither pr.json nor a range it says what to pass', async () => {
  const dir = scratch('edge-kinds', byId());
  const briefed = await story('brief', '--dir', dir);
  assert.equal(briefed.code, 0, briefed.stderr);
  const brief = JSON.parse(briefed.stdout) as Record<string, unknown> & { hunks: { id: string }[] };
  for (const key of ['pr', 'totals', 'files', 'commits', 'reviews', 'threads', 'ci']) {
    assert.ok(key in brief, key);
  }
  assert.equal(brief.hunks[0].id, 'h1');
  assert.ok(existsSync(path.join(dir, 'hunks.txt')));
  const empty = await story('brief', '--dir', tmp('brief-none'));
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--repo <checkout> --base <ref> --head <ref>/);
});

test('createLocalStory: hunk ids in --chapters become refs in both copies, and vet already sees them', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const folder = tmp('chapters-in');
  const chapters = path.join(folder, 'chapters.json');
  writeJson(chapters, {
    chapters: [
      {
        title: 'Everything',
        files: ['gone.txt', 'lib/two.js', 'one.txt'],
        narrative: 'It all changed.',
        hunks: ['h2', 'h3'],
      },
    ],
  });
  let seen: string[] = [];
  const made = createLocalStory({
    home,
    repo,
    base,
    head: 'HEAD',
    chapters,
    vet: ({ after }) => {
      seen = (after.chapters![0].refs || []).map((ref) => String(ref.id));
      return null;
    },
  });
  assert.deepEqual(seen, ['h2', 'h3']);
  assert.equal(made.expanded, 2);
  for (const file of [chapters, path.join(made.dir, 'chapters.json')]) {
    const written = JSON.parse(readFileSync(file, 'utf8')) as Plan;
    assert.deepEqual(
      written.chapters![0].refs!.map((ref) => ref.id),
      ['h2', 'h3'],
    );
    assert.equal(written.chapters![0].hunks, undefined);
  }
});

test('createLocalStory: hunk ids whose refs already exist, or an empty list, are still dropped from both copies', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const folder = tmp('chapters-again');
  const chapters = path.join(folder, 'chapters.json');
  const told = (hunks: string[]) => ({
    chapters: [
      {
        title: 'Everything',
        files: ['gone.txt', 'lib/two.js', 'one.txt'],
        narrative: 'All.',
        hunks,
      },
    ],
  });
  writeJson(chapters, told(['h2', 'h3']));
  const first = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  for (const hunks of [['h2', 'h3'], []]) {
    const written = JSON.parse(readFileSync(chapters, 'utf8')) as Plan; // refs made, hunks gone
    written.chapters![0].hunks = hunks; // the author's next edit puts the ids back
    writeJson(chapters, written);
    createLocalStory({ home, repo, base, head: 'HEAD', chapters, id: first.id });
    for (const file of [chapters, path.join(first.dir, 'chapters.json')]) {
      const again = JSON.parse(readFileSync(file, 'utf8')) as Plan;
      assert.equal('hunks' in again.chapters![0], false, file);
      assert.deepEqual(
        again.chapters![0].refs!.map((ref) => ref.id),
        ['h2', 'h3'],
      );
    }
  }
});

test('createLocalStory: a refused --chapters leaves storyless.json, meta.json, local.diff and chapters.json as they were, and a valid one still publishes', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const folder = tmp('chapters-refused');
  const first = createLocalStory({ home, repo, base, head: 'HEAD' });
  const mark = path.join(first.dir, 'storyless.json');
  writeJson(mark, { head_oid: 'x' });
  const names = ['storyless.json', 'meta.json', 'local.diff', 'chapters.json'];
  const bytes = () => names.map((name) => readFileSync(path.join(first.dir, name)));
  const before = bytes();
  const bad = path.join(folder, 'bad.json');
  writeJson(bad, {
    chapters: [{ title: 'Nothing', files: ['not-in-the-diff.txt'], narrative: 'Nope.' }],
  });
  assert.throws(() => createLocalStory({ home, repo, base, head: 'HEAD', chapters: bad }));
  assert.deepEqual(bytes(), before);
  const good = path.join(folder, 'good.json');
  writeJson(good, {
    chapters: [
      {
        title: 'Everything',
        files: ['gone.txt', 'lib/two.js', 'one.txt'],
        narrative: 'It all changed.',
        hunks: ['h1', 'h2', 'h3'],
      },
    ],
  });
  createLocalStory({ home, repo, base, head: 'HEAD', chapters: good });
  assert.equal(existsSync(mark), false);
});
