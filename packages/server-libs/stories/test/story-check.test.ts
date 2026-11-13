import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import type { Plan, PlanChapter } from '../src/chapters.ts';
import { findingLine } from '../src/story-report.ts';
import type { Check, Kind } from '../src/quality.ts';

// `story.mjs check`, and the findings summary `story.mjs build` prints, over the recorded fixture stories
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'story-evals');
const ROOT = path.resolve(HERE, '../../../..');
const STORY = path.join(ROOT, 'skills/once-upon/bin/story.mjs');
const run = promisify(execFile);

/** A scratch folder as the helper's build leaves it: the fixture's pr.json and pr.diff, and this plan. */
function scratch(name: string, plan?: Plan): string {
  const dir = tmp(`check-${name}`);
  cpSync(path.join(FIXTURES, name, 'pr.json'), path.join(dir, 'pr.json'));
  cpSync(path.join(FIXTURES, name, 'pr.diff'), path.join(dir, 'pr.diff'));
  const recorded = path.join(FIXTURES, name, 'recorded', 'chapters.json');
  writeJson(path.join(dir, 'chapters.json'), plan || JSON.parse(readFileSync(recorded, 'utf8')));
  return dir;
}

/** The recorded edge-kinds story with the hunks of src/widgets.js after the first one no chapter points at. */
function loose(): Plan {
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'edge-kinds', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const first = (plan.chapters as PlanChapter[])[0];
  first.files = ['src/widgets.js', 'src/small.js'];
  first.refs = first.refs!.filter((ref) => ref.path !== 'src/widgets.js' || ref.id === 'first');
  first.narrative = first.narrative!.replace(/\[([^\]]+)\]\(ref:(?!first\))\w+\)/g, '$1');
  return plan;
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

test('check: an uncovered hunk is a fail line naming the file and hunk, and the exit is 1', async () => {
  const checked = await story('check', '--dir', scratch('edge-kinds', loose()));
  assert.equal(checked.code, 1);
  assert.match(
    checked.stdout,
    /^fail hunks story: .*src\/widgets\.js:100-121, src\/widgets\.js:200-221.*\(fix: .*ref/m,
  );
});

test('check: warnings only print and exit 0', async () => {
  const checked = await story('check', '--dir', scratch('edge-kinds'));
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /^warn length chapter \d+: /m);
  assert.doesNotMatch(checked.stdout, /^fail /m);
});

test('check: a clean story says there are no findings and exits 0', async () => {
  const checked = await story('check', '--dir', scratch('inbox-87'));
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /no findings/);
});

test('check: reads a published local story, with its own local.diff', async () => {
  const dir = scratch('edge-kinds', loose());
  cpSync(path.join(dir, 'pr.diff'), path.join(dir, 'local.diff'));
  const published = tmp('published');
  cpSync(path.join(dir, 'chapters.json'), path.join(published, 'chapters.json'));
  cpSync(path.join(dir, 'pr.diff'), path.join(published, 'local.diff'));
  const checked = await story('check', '--dir', published);
  assert.equal(checked.code, 1);
  assert.match(checked.stdout, /^fail hunks /m);
});

test('build prints the findings summary and keeps its exit status', async () => {
  const warned = await story('build', '--dir', scratch('edge-kinds'), '--no-bridge');
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /Story checks: 0 fails, 2 warns/);
  const clean = await story('build', '--dir', scratch('inbox-87'), '--no-bridge');
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stderr, /Story checks: 0 fails, 0 warns/);
  // the gate refuses an uncovered hunk and still exits 1, with the same message as before
  const refused = await story('build', '--dir', scratch('edge-kinds', loose()), '--no-bridge');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /hunks not covered/);
  // --allow-uncovered lets it through (exit 0) and the summary lists the fail
  const allowed = await story(
    'build',
    '--dir',
    scratch('edge-kinds', loose()),
    '--no-bridge',
    '--allow-uncovered',
  );
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stderr, /Story checks: 1 fail, 2 warns/);
  assert.match(allowed.stderr, /^fail hunks .*src\/widgets\.js:100-121/m);
});

test('a skeleton build counts chapters still being written, not as fails', async () => {
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'inbox-87', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  for (const chapter of plan.chapters as PlanChapter[]) {
    chapter.narrative = '';
  }
  const built = await story('build', '--dir', scratch('inbox-87', plan), '--no-bridge');
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /Story checks: 0 fails, \d+ warns, \d+ chapters still being written/);
});

/** The recorded inbox-87 story with every chapter's headline an array: the gate and publish take it, the rules cannot read it. */
function unreadable(): Plan {
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'inbox-87', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  (plan.chapters as PlanChapter[])[0].headline = ['a', 'b'] as unknown as string;
  return plan;
}

test('build still exits 0 and prints one line when the findings cannot be computed', async () => {
  const dir = scratch('inbox-87', unreadable());
  const built = await story('build', '--dir', dir, '--no-bridge');
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /^findings: could not be computed: .+$/m);
  assert.doesNotMatch(built.stderr, /\n\s+at /);
  assert.ok(readFileSync(path.join(dir, 'file-map.json'), 'utf8'), 'the map is written as before');
});

test('check reports a plan the rules cannot read as one error line, exit 1', async () => {
  const checked = await story('check', '--dir', scratch('inbox-87', unreadable()));
  assert.equal(checked.code, 1);
  assert.match(checked.stderr, /^error: .+$/m);
  assert.doesNotMatch(checked.stderr, /\n\s+at /);
  assert.equal(checked.stdout, '');
});

/** The recorded inbox-87 story with its last chapter not written yet. */
function midway(): Plan {
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'inbox-87', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const chapters = plan.chapters as PlanChapter[];
  chapters[chapters.length - 1].narrative = '';
  return plan;
}

test('check counts an unwritten chapter as still being written; --final fails it', async () => {
  const dir = scratch('inbox-87', midway());
  const checked = await story('check', '--dir', dir);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /^1 chapter still being written/m);
  assert.doesNotMatch(checked.stdout, /^fail /m);
  // the chapter before it still closes with "Next is chapter N", which now names a chapter with no text: no finding either
  const final = await story('check', '--dir', dir, '--final');
  assert.equal(final.code, 1);
  assert.match(final.stdout, /^fail shape chapter \d+: the chapter has no narrative/m);
  assert.doesNotMatch(final.stdout, /still being written/);
});

test('the other rules skip an unwritten chapter', async () => {
  const plan = midway();
  const chapters = plan.chapters as PlanChapter[];
  const last = chapters[chapters.length - 1];
  last.refs = [];
  last.headline = 'One. Two sentences.';
  const checked = await story('check', '--dir', scratch('inbox-87', plan));
  assert.equal(checked.code, 0, checked.stderr);
  assert.doesNotMatch(checked.stdout, new RegExp(`chapter ${chapters.length}: `));
  assert.match(checked.stdout, /1 chapter still being written/);
});

test('findingLine: each length and shape finding gets the fix that suits it, and a bare one gets none', () => {
  const line = (kind: Kind, check: Check = 'shape') =>
    findingLine({ level: 'warn', check, kind, message: 'm', chapter: 2 });
  const hints: [Kind, Check, RegExp][] = [
    ['too-long', 'length', /fix: trim or split/],
    ['too-short', 'length', /fix: say more/],
    ['no-refs', 'length', /fix: add 2-4 refs/],
    ['too-many-refs', 'length', /fix: keep the 2-4 refs/],
    ['no-opener', 'shape', /fix: open with "### Chapter N: title"/],
    ['opener-number', 'shape', /fix: number the heading/],
    ['opener-title', 'shape', /fix: make the heading's title the chapter's title/],
    ['no-closer', 'shape', /fix: close with "Next is chapter N, title\."/],
    ['closer-number', 'shape', /fix: name the chapter that follows/],
    ['closer-title', 'shape', /fix: repeat the next chapter's title/],
    ['headline', 'shape', /fix: cut the headline to one sentence/],
    ['answer', 'shape', /fix: shorten the answer/],
    ['no-overview', 'shape', /fix: write the story's overview/],
    ['title-long', 'shape', /fix: shorten the title/],
    ['summary-long', 'shape', /fix: shorten the summary/],
  ];
  for (const [kind, check, pattern] of hints) {
    assert.match(line(kind, check), pattern, kind);
  }
  // a length or shape finding with no kind says nothing about the fix; a uniform rule keeps its own
  assert.doesNotMatch(findingLine({ level: 'warn', check: 'length', message: 'm' }), /fix:/);
  assert.doesNotMatch(findingLine({ level: 'warn', check: 'shape', message: 'm' }), /fix:/);
  assert.match(findingLine({ level: 'fail', check: 'refs', message: 'm' }), /fix: point the ref/);
});

test('quality findings carry the kind the hint is keyed by', async () => {
  const { storyFindings } = await import('../src/quality.ts');
  const { parseUnifiedDiff } = await import('../src/diff.ts');
  const plan = JSON.parse(
    readFileSync(path.join(FIXTURES, 'edge-kinds', 'recorded', 'chapters.json'), 'utf8'),
  ) as Plan;
  const chapter = (plan.chapters as PlanChapter[])[0];
  chapter.narrative = 'short';
  chapter.refs = [];
  plan.overview = '';
  plan.summary = '';
  delete plan.plan;
  const found = storyFindings(
    plan,
    parseUnifiedDiff(readFileSync(path.join(FIXTURES, 'edge-kinds', 'pr.diff'), 'utf8')),
  );
  const kinds = (check: Check) =>
    found.filter((finding) => finding.check === check).map((finding) => finding.kind);
  assert.ok(kinds('length').includes('too-short'));
  assert.ok(kinds('length').includes('no-refs'));
  assert.ok(kinds('shape').includes('no-opener'));
  assert.ok(kinds('shape').includes('no-overview'));
  assert.ok(
    found
      .filter((finding) => finding.check === 'length' || finding.check === 'shape')
      .every((finding) => finding.kind),
  );
});

test('the skill and the storyteller definition name the check command', () => {
  const skill = readFileSync(path.join(ROOT, 'skills/once-upon/SKILL.md'), 'utf8');
  const agent = readFileSync(path.join(ROOT, 'agents/once-upon-storyteller.md'), 'utf8');
  assert.match(skill, /story\.mjs check --dir/);
  assert.match(skill, /never write a script to call `quality\.ts`/i);
  assert.match(skill, /`check --final`/);
  assert.match(agent, /story\.mjs check --final/);
  assert.match(agent, /story\.mjs check/);
  assert.match(agent, /quality\.ts/);
  assert.match(skill, /hunks\.txt/);
  assert.match(agent, /hunks\.txt/);
  assert.match(agent, /"hunks": \[/);
});
