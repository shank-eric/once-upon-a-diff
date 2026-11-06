import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { parseUnifiedDiff } from '../src/diff.ts';
import type { Plan, PlanChapter } from '../src/chapters.ts';
import {
  rulesHash,
  storyFindings,
  storyRulesOf,
  wordCount,
  type Check,
  type Finding,
} from '../src/quality.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'story-evals');
const STORY = path.resolve(HERE, '../../../../skills/once-upon/bin/story.mjs');
const SKILL = path.resolve(HERE, '../../../../skills/once-upon/SKILL.md');
const RUNNER = path.resolve(HERE, '../scripts/story-eval.ts');
const run = promisify(execFile);

const NAMES = readdirSync(FIXTURES).filter((name) =>
  statSync(path.join(FIXTURES, name)).isDirectory(),
);

function load(name: string) {
  const dir = path.join(FIXTURES, name);
  const plan = JSON.parse(
    readFileSync(path.join(dir, 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const diff = parseUnifiedDiff(readFileSync(path.join(dir, 'pr.diff'), 'utf8'));
  return { dir, plan, diff };
}

/** A copy of a recorded plan the test may change. */
const clone = (plan: Plan): Plan => JSON.parse(JSON.stringify(plan)) as Plan;
const fails = (findings: Finding[], check?: Check) =>
  findings.filter((finding) => finding.level === 'fail' && (!check || finding.check === check));
const warns = (findings: Finding[], check?: Check) =>
  findings.filter((finding) => finding.level === 'warn' && (!check || finding.check === check));

/** A scratch folder `story.mjs build` can write into: the fixture's pr.json and pr.diff, and this plan. */
function scratch(name: string, plan: Plan): string {
  const dir = tmp(`quality-${name}`);
  cpSync(path.join(FIXTURES, name, 'pr.json'), path.join(dir, 'pr.json'));
  cpSync(path.join(FIXTURES, name, 'pr.diff'), path.join(dir, 'pr.diff'));
  writeJson(path.join(dir, 'chapters.json'), plan);
  return dir;
}

/** Whether the build gate accepts the plan (exit 0), and what it said. */
async function gate(name: string, plan: Plan): Promise<{ ok: boolean; stderr: string }> {
  const dir = scratch(name, plan);
  try {
    const { stderr } = await run(process.execPath, [STORY, 'build', '--dir', dir, '--no-bridge']);
    return { ok: true, stderr };
  } catch (error) {
    return { ok: false, stderr: (error as { stderr: string }).stderr };
  }
}

const narrativeOf = (plan: Plan, index: number) =>
  (plan.chapters as PlanChapter[])[index].narrative!;

// ---------- the success check: a gap the build gate really has

test('story-eval: a ref outside every hunk fails the harness, though the build gate lets it through', async () => {
  const { plan, diff } = load('edge-kinds');
  const far = clone(plan);
  (far.chapters as PlanChapter[])[0].refs!.push({
    id: 'far',
    path: 'src/small.js',
    side: 'R',
    start: 500,
    end: 510,
    label: 'a place the diff does not show',
  });
  const built = await gate('edge-kinds', far);
  assert.ok(built.ok, `the gate accepts it on main: ${built.stderr}`);
  const found = fails(storyFindings(far, diff), 'refs');
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].message, /ref "far".*src\/small\.js:500-510.*no hunk/);
  assert.equal(found[0].chapter, 1);
});

test('a ref that overlaps a hunk, on the side it names, is fine; an L ref on a file that only adds lines is not', () => {
  const { plan, diff } = load('edge-kinds');
  assert.deepEqual(fails(storyFindings(plan, diff), 'refs'), []);
  const side = clone(plan);
  (side.chapters as PlanChapter[])[0].refs!.push({
    id: 'old',
    path: 'src/small.js',
    side: 'L',
    start: 40,
    end: 41,
  });
  assert.equal(fails(storyFindings(side, diff), 'refs').length, 1);
  const overlap = clone(plan);
  (overlap.chapters as PlanChapter[])[0].refs!.push({
    id: 'edge',
    path: 'src/small.js',
    side: 'R',
    start: 7,
    end: 12,
  });
  assert.deepEqual(
    fails(storyFindings(overlap, diff), 'refs'),
    [],
    'a range reaching into a hunk counts, as in hunk coverage',
  );
});

test("the overview's refs are checked the same way", () => {
  const { plan, diff } = load('edge-kinds');
  const bad = clone(plan);
  bad.refs = [{ id: 'nowhere', path: 'src/small.js', side: 'R', start: 90, end: 91 }];
  bad.overview = `${bad.overview}\n\nSee [this](ref:nowhere).`;
  const found = fails(storyFindings(bad, diff), 'refs');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /overview/);
});

// ---------- placement, hunks, plan: what the gate also refuses

test('story-eval: a recorded story with an unplaced file fails the harness, as the gate does', async () => {
  for (const name of NAMES) {
    const { plan, diff } = load(name);
    const cut = clone(plan);
    const lastChapter = (cut.chapters as PlanChapter[]).at(-1)!;
    const gone = lastChapter.files!.pop()!;
    const rel = typeof gone === 'string' ? gone : gone.rel;
    const found = fails(storyFindings(cut, diff), 'placement');
    assert.equal(found.length, 1, name);
    assert.ok(found[0].message.includes(rel), found[0].message);
    const built = await gate(name, cut);
    assert.ok(!built.ok && built.stderr.includes(rel), `${name}: the gate refuses it too`);
  }
});

test('a chapter naming a file that is not in the diff fails', () => {
  const { plan, diff } = load('inbox-91');
  const bad = clone(plan);
  (bad.chapters as PlanChapter[])[0].files!.push('src/nowhere.js');
  assert.match(
    fails(storyFindings(bad, diff), 'placement')[0].message,
    /src\/nowhere\.js is not in the diff/,
  );
});

test('a hunk of a big file that no chapter points at fails; "whole" covers it', async () => {
  const { plan, diff } = load('edge-kinds');
  const loose = clone(plan);
  const first = (loose.chapters as PlanChapter[])[0];
  first.files = ['src/widgets.js', 'src/small.js'];
  first.refs = first.refs!.filter((ref) => ref.path !== 'src/widgets.js' || ref.id === 'first');
  first.narrative = narrativeOf(loose, 0).replace(
    /\[the (second|third) block\]\(ref:\w+\)/g,
    'the $1 block',
  );
  const found = fails(storyFindings(loose, diff), 'hunks');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /src\/widgets\.js:100-121, src\/widgets\.js:200-221/);
  assert.ok(!(await gate('edge-kinds', loose)).ok, 'the gate refuses it too');
});

test("a plan the gate would refuse for its shape fails with the gate's own lines", () => {
  const { plan, diff } = load('inbox-91');
  const bad = clone(plan);
  delete (bad.chapters as PlanChapter[])[1].refs;
  assert.match(fails(storyFindings(bad, diff), 'plan')[0].message, /chapter 2 has no refs list/);
});

// ---------- partials: the gate lets them through, so they only warn

test('a partial file that no later chapter finishes is a warning, and the build gate accepts it', async () => {
  const { plan, diff } = load('inbox-91');
  const partial = clone(plan);
  const second = (partial.chapters as PlanChapter[])[1];
  second.files![1] = {
    rel: 'src/js/outlook/outlookUtils.js',
    partial: true,
    note: 'the lookups only',
  };
  const findings = storyFindings(partial, diff);
  assert.deepEqual(fails(findings, 'placement'), []);
  const found = warns(findings, 'partials');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /outlookUtils\.js is partial in chapter 2/);
  assert.ok((await gate('inbox-91', partial)).ok, 'build exits 0 on main');
});

test('a partial that a later chapter lists plainly is finished, and says nothing', () => {
  const { plan, diff } = load('inbox-91');
  const finished = clone(plan);
  (finished.chapters as PlanChapter[])[0].files![0] = {
    rel: 'src/js/outlook/bundle.js',
    partial: true,
    note: 'the top',
  };
  (finished.chapters as PlanChapter[])[1].files!.push('src/js/outlook/bundle.js');
  assert.deepEqual(warns(storyFindings(finished, diff), 'partials'), []);
});

// ---------- comments

test('a drafted comment on a line that is in no hunk fails; one inside a hunk, or carried from an earlier telling, does not', () => {
  const { plan, diff } = load('inbox-91');
  const withComment = (line: number, extra: Record<string, unknown> = {}) => {
    const next = clone(plan);
    (next.chapters as PlanChapter[])[0].comments = [
      { path: 'src/js/outlook/email.js', line, body: 'Could you confirm?', ...extra },
    ];
    return storyFindings(next, diff);
  };
  assert.deepEqual(fails(withComment(100), 'comments'), []);
  assert.equal(fails(withComment(400), 'comments').length, 1);
  assert.deepEqual(fails(withComment(400, { carried: true }), 'comments'), []);
});

// ---------- length: words warn, files fail past 12 with the skill's exemptions

test('words only warn: a long chapter and a short one are reported, never failed', () => {
  const { plan, diff } = load('inbox-91');
  const long = clone(plan);
  const first = (long.chapters as PlanChapter[])[0];
  first.narrative = first.narrative!.replace(
    'What to check:',
    `${'word '.repeat(600)}\n\nWhat to check:`,
  );
  const found = warns(storyFindings(long, diff), 'length');
  assert.ok(found.some((finding) => finding.chapter === 1 && /words/.test(finding.message)));
  assert.deepEqual(fails(storyFindings(long, diff)), []);
  assert.equal(wordCount('a [b c](ref:x) d'), 4, 'a ref link counts its text');
});

/** A plan of one journey chapter listing `count` files of a diff made for the test. */
function manyFiles(count: number, extra: string[] = [], added = 1) {
  const rels = Array.from({ length: count }, (_, i) => `src/f${i}.js`);
  const text = [
    ...rels.map(
      (rel) =>
        `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n@@ -1,1 +1,${added + 1} @@\n a\n${'+b\n'.repeat(added).trimEnd()}`,
    ),
    ...extra,
  ].join('\n');
  const diff = parseUnifiedDiff(`${text}\n`);
  return { rels, diff };
}
const oneChapter = (files: PlanChapter['files'], mode = 'journey'): Plan => ({
  mode,
  title: 'T',
  overview: 'O',
  refs: [],
  chapters: [
    {
      title: 'Chapter 1: All of it',
      headline: 'One step.',
      files,
      refs: [],
      narrative: '### Chapter 1: All of it\n\nThe scenario: all of it.',
    },
  ],
});

test('more than 12 files in one journey step fails, 9 to 12 warn', () => {
  const thirteen = manyFiles(13, [], 50);
  assert.equal(fails(storyFindings(oneChapter(thirteen.rels), thirteen.diff), 'files').length, 1);
  const nine = manyFiles(9, [], 50);
  const found = storyFindings(oneChapter(nine.rels), nine.diff);
  assert.deepEqual(fails(found, 'files'), []);
  assert.equal(warns(found, 'files').length, 1);
});

test('the skill\'s exemptions: whole files, lockfiles, deleted files, "Since you read it" and chronological stories', () => {
  const lock =
    'diff --git a/yarn.lock b/yarn.lock\n--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1,1 +1,2 @@\n a\n+b';
  const gone =
    'diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a';
  const { rels, diff } = manyFiles(13, [lock, gone], 50);
  const files = [
    ...rels.slice(0, 8),
    ...rels.slice(8).map((rel) => ({ rel, whole: true })),
    'yarn.lock',
    'old.js',
  ];
  assert.deepEqual(
    fails(storyFindings(oneChapter(files), diff), 'files'),
    [],
    'only 8 files count',
  );
  assert.equal(
    fails(storyFindings(oneChapter(rels), diff), 'files').length,
    1,
    'the same 13 files with no exemption do fail',
  );
  const chronological = oneChapter([...rels, 'yarn.lock', 'old.js'], 'chronological');
  assert.deepEqual(fails(storyFindings(chronological, diff), 'files'), []);
  const since = oneChapter([...rels, 'yarn.lock', 'old.js']);
  Object.assign((since.chapters as PlanChapter[])[0], {
    since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 2 },
  });
  assert.deepEqual(fails(storyFindings(since, diff), 'files'), []);
});

// ---------- shape

test('a sweep of small files is a warning, not a failure: only files over the small-file size count toward 12', () => {
  const sweep = manyFiles(30);
  const found = storyFindings(oneChapter(sweep.rels), sweep.diff);
  assert.deepEqual(fails(found, 'files'), []);
  const warning = warns(found, 'files');
  assert.equal(warning.length, 1);
  assert.match(warning[0].message, /30 files.*small/);
});

test('a narrative must open at its own "### Chapter N: title" and close naming the chapter that follows', () => {
  const { plan, diff } = load('inbox-91');
  const wrongNumber = clone(plan);
  (wrongNumber.chapters as PlanChapter[])[1].narrative = narrativeOf(wrongNumber, 1).replace(
    '### Chapter 2:',
    '### Chapter 3:',
  );
  assert.match(
    fails(storyFindings(wrongNumber, diff), 'shape')[0].message,
    /opens as chapter 3, not chapter 2/,
  );

  const noHeading = clone(plan);
  (noHeading.chapters as PlanChapter[])[0].narrative = narrativeOf(noHeading, 0).replace(
    /^### .*\n\n/,
    '',
  );
  assert.match(fails(storyFindings(noHeading, diff), 'shape')[0].message, /does not open with/);

  const wrongNext = clone(plan);
  (wrongNext.chapters as PlanChapter[])[0].narrative = narrativeOf(wrongNext, 0).replace(
    /Next is chapter 2,.*$/,
    'Next is chapter 3, Something else.',
  );
  assert.match(fails(storyFindings(wrongNext, diff), 'shape')[0].message, /closing line/);

  const noCloser = clone(plan);
  (noCloser.chapters as PlanChapter[])[0].narrative = narrativeOf(noCloser, 0).replace(
    /Next is chapter 2,.*$/,
    'And that is it.',
  );
  assert.match(fails(storyFindings(noCloser, diff), 'shape')[0].message, /does not close with/);
});

test('a "Since you read it" chapter has no number, so the chapters after it keep theirs', () => {
  const { plan, diff } = load('inbox-91');
  const updated = clone(plan);
  (updated.chapters as PlanChapter[]).unshift({
    key: 'since-abc-def',
    title: 'Since you read it: 1 new commit',
    headline: 'One commit.',
    since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 },
    files: ['src/js/outlook/email.js'],
    refs: [],
    narrative: '### Since you read it\n\nOne commit.',
  });
  assert.deepEqual(fails(storyFindings(updated, diff), 'shape'), []);
});

test('text that looks like a link but is not one is a warning', () => {
  const { plan, diff } = load('inbox-91');
  const text = clone(plan);
  (text.chapters as PlanChapter[])[0].narrative = narrativeOf(text, 0).replace(
    'What to check',
    'See `src/js/outlook/email.js:100` for it. What to check',
  );
  assert.equal(warns(storyFindings(text, diff), 'links').length, 1);
});

test('a closer that shortens the next title only warns; a wrong number still fails', () => {
  const { plan, diff } = load('inbox-91');
  const short = clone(plan);
  (short.chapters as PlanChapter[])[0].narrative = narrativeOf(short, 0).replace(
    /Next is chapter 2,.*$/,
    'Next is chapter 2, the keyboard.',
  );
  const findings = storyFindings(short, diff);
  assert.deepEqual(fails(findings, 'shape'), []);
  assert.match(warns(findings, 'shape')[0].message, /closing line.*keyboard/);
  const wrong = clone(plan);
  (wrong.chapters as PlanChapter[])[0].narrative = narrativeOf(wrong, 0).replace(
    /Next is chapter 2,.*$/,
    'Next is chapter 3, Keyboard walks the visible rows.',
  );
  assert.equal(fails(storyFindings(wrong, diff), 'shape').length, 1);
});

test('inline code in a heading or a closer does not make it differ from the plain title', () => {
  const { plan, diff } = load('inbox-91');
  const coded = clone(plan);
  const chapters = coded.chapters as PlanChapter[];
  chapters[1].title = 'Chapter 2: The Widget loader';
  chapters[1].narrative = narrativeOf(coded, 1).replace(
    '### Chapter 2: Keyboard walks the visible rows',
    '### Chapter 2: The `Widget` loader',
  );
  chapters[0].narrative = narrativeOf(coded, 0).replace(
    /Next is chapter 2,.*$/,
    'Next is chapter 2, The `Widget` loader.',
  );
  assert.deepEqual(fails(storyFindings(coded, diff), 'shape'), []);
  assert.deepEqual(warns(storyFindings(coded, diff), 'shape'), []);
});

test('a numbered chapter with no narrative fails', () => {
  const { plan, diff } = load('inbox-91');
  const skeleton = clone(plan);
  (skeleton.chapters as PlanChapter[])[1].narrative = '';
  const found = fails(storyFindings(skeleton, diff), 'shape');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /no narrative/);
  assert.equal(found[0].chapter, 2);
});

test('findings name the chapter the panel numbers, which is not its place in the list after a "Since you read it" chapter', () => {
  const { plan, diff } = load('inbox-91');
  const updated = clone(plan);
  (updated.chapters as PlanChapter[]).unshift({
    key: 'since-abc-def',
    title: 'Since you read it: 1 new commit',
    headline: 'One commit.',
    since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1 },
    files: ['src/js/outlook/email.js'],
    refs: [],
    narrative: '### Since you read it\n\nOne commit.',
  });
  (updated.chapters as PlanChapter[])[1].refs!.push({
    id: 'far',
    path: 'src/js/outlook/bundle.js',
    side: 'R',
    start: 900,
    end: 910,
  });
  const found = fails(storyFindings(updated, diff), 'refs');
  assert.equal(found.length, 1);
  assert.equal(found[0].chapter, 1, 'the panel numbers it chapter 1');
  assert.match(found[0].message, /chapter 1/);
});

// ---------- the recorded stories

test('every recorded fixture story passes the checks (warnings are listed, not failed)', (ctx) => {
  assert.ok(NAMES.length >= 3, 'three to five fixtures');
  for (const name of NAMES) {
    const { plan, diff } = load(name);
    const findings = storyFindings(plan, diff);
    assert.deepEqual(fails(findings), [], `${name}: ${JSON.stringify(fails(findings))}`);
    for (const warning of warns(findings)) {
      ctx.diagnostic(
        `${name}: ${warning.check}${warning.chapter ? ` (chapter ${warning.chapter})` : ''}: ${warning.message}`,
      );
    }
  }
});

test('every recorded story is also accepted by the real build gate, in a copy', async () => {
  for (const name of NAMES) {
    const { plan } = load(name);
    const built = await gate(name, plan);
    assert.ok(built.ok, `${name}: ${built.stderr}`);
  }
});

test('a fixture whose rules hash is stale is reported, not failed', (ctx) => {
  const current = rulesHash(readFileSync(SKILL, 'utf8'));
  for (const name of NAMES) {
    const record = JSON.parse(
      readFileSync(path.join(FIXTURES, name, 'recorded', 'record.json'), 'utf8'),
    ) as {
      rulesHash: string;
    };
    assert.match(record.rulesHash, /^[0-9a-f]{16}$/, name);
    if (record.rulesHash !== current) {
      ctx.diagnostic(
        `${name}: recorded under rules ${record.rulesHash}, SKILL.md's are now ${current}: run yarn eval:stories --record`,
      );
    }
  }
});

test('the rules sent to the model are SKILL.md\'s step 2 and "How the story sounds", and a renamed heading is an error', () => {
  const skill = readFileSync(SKILL, 'utf8');
  const rules = storyRulesOf(skill);
  assert.match(rules, /^2\. \*\*Plan chapters\.\*\*/);
  assert.match(rules, /## How the story sounds/);
  assert.ok(!/3\. \*\*Build and publish the skeleton/.test(rules) && !/## Voice mode/.test(rules));
  assert.throws(
    () => storyRulesOf(skill.replace('## How the story sounds', '## How it sounds')),
    /How the story sounds/,
  );
  assert.throws(
    () => storyRulesOf(skill.replace('2. **Plan chapters.**', '2. **Plan the chapters.**')),
    /step 2/,
  );
  assert.notEqual(
    rulesHash(skill),
    rulesHash(skill.replace('Tell it as a user journey', 'Tell it as a trip')),
  );
  assert.equal(
    rulesHash(skill),
    rulesHash(skill.replace('## Voice mode\n', '## Voice mode\n\nextra words\n')),
    'text outside the slices does not change it',
  );
});

// ---------- what a fixture may hold

test('fixtures hold no email address, and pr.json only the public fields', () => {
  const allowed = new Set([
    'number',
    'title',
    'body',
    'url',
    'author',
    'baseRefName',
    'headRefName',
    'commits',
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : [file];
    });
  for (const file of walk(FIXTURES)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      text,
      /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
      `${path.relative(FIXTURES, file)} holds an email address`,
    );
    if (path.basename(file) === 'pr.json') {
      const pr = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(pr).filter((key) => !allowed.has(key)),
        [],
        file,
      );
      assert.deepEqual(Object.keys(pr.author as object), ['login'], file);
      for (const commit of pr.commits as Record<string, unknown>[]) {
        assert.deepEqual(
          Object.keys(commit).sort(),
          ['messageBody', 'messageHeadline', 'oid'],
          file,
        );
      }
      assert.doesNotMatch(text, /co-authored-by/i, `${file} keeps no trailer`);
      assert.match(
        pr.url as string,
        /^https:\/\/github\.com\/(shank-eric\/inbox-in-gmail|acme\/widgets)\/pull\/\d+$/,
        "a public PR of Eric's or a synthetic one",
      );
    }
  }
});

// ---------- the runner, with a stubbed claude

/** A `claude` on PATH that writes the stored story for $STORY_EVAL_FIXTURE into its cwd, as a model would. */
function stubClaude(): string {
  const bin = tmp('stub-claude');
  const file = path.join(bin, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh\ncat > /dev/null\necho "$@" > "$PWD/claude-args.txt"\ncp "${FIXTURES}/$STORY_EVAL_FIXTURE/recorded/chapters.json" "$PWD/chapters.json"\n`,
    { mode: 0o755 },
  );
  return bin;
}

test('yarn eval:stories with a stubbed claude: builds, checks and prints a table; --record updates the fixture copy', async () => {
  const bin = stubClaude();
  const fixtures = tmp('fixtures-copy');
  cpSync(FIXTURES, fixtures, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: tmp('runner-tmp'),
  };
  const { stdout } = await run(
    process.execPath,
    [RUNNER, '--fixtures', fixtures, '--fixture', 'edge-kinds', '--record'],
    { env, timeout: 120_000 },
  );
  assert.match(stdout, /edge-kinds\s+2 chapters/);
  assert.match(stdout, /0 fail/);
  const record = JSON.parse(
    readFileSync(path.join(fixtures, 'edge-kinds', 'recorded', 'record.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(record.rulesHash, rulesHash(readFileSync(SKILL, 'utf8')));
  assert.match(String(record.source), /claude -p/);
  assert.ok(existsSync(path.join(fixtures, 'edge-kinds', 'recorded', 'chapters.json')));
});

test('yarn eval:stories: a telling with no keys passes the gate, which gives them, and then the checks', async () => {
  const bin = tmp('stub-claude-keyless');
  writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncat > /dev/null\nnode -e 'const p=JSON.parse(require("fs").readFileSync("${FIXTURES}/inbox-91/recorded/chapters.json","utf8"));p.chapters.forEach((c)=>{delete c.key});require("fs").writeFileSync("chapters.json",JSON.stringify(p))'\n`,
    { mode: 0o755 },
  );
  const scratchTmp = tmp('runner-tmp');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratchTmp };
  const { stdout } = await run(process.execPath, [RUNNER, '--fixture', 'inbox-91'], {
    env,
    timeout: 120_000,
  });
  assert.match(stdout, /inbox-91\s+2 chapters/);
  assert.match(stdout, /0 fail/);
  assert.match(stdout, /gate ok/);
  assert.deepEqual(readdirSync(scratchTmp), [], 'a passing run leaves no folder in the temp dir');
});

test('yarn eval:stories exits 1 when the telling fails a check', async () => {
  const bin = tmp('stub-claude-bad');
  writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncat > /dev/null\nnode -e 'const p=JSON.parse(require("fs").readFileSync("${FIXTURES}/edge-kinds/recorded/chapters.json","utf8"));p.chapters[1].files.pop();require("fs").writeFileSync("chapters.json",JSON.stringify(p))'\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: tmp('runner-tmp'),
  };
  await assert.rejects(
    run(process.execPath, [RUNNER, '--fixture', 'edge-kinds'], { env, timeout: 120_000 }),
    (error: Error & { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /placement/);
      return true;
    },
  );
});
