import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { parseUnifiedDiff } from '../src/diff.ts';
import type { Plan, PlanChapter } from '../src/chapters.ts';
import { updateProblems } from '../src/rebuild.ts';
import { chapterProblems } from '../src/validate.ts';

const HEAD = 'b'.repeat(40);
// the branch's diff now: src/a.js only (a fix round removed src/gone.js)
const diff = parseUnifiedDiff(
  [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,2 +10,4 @@ fn',
    ' before',
    '+line 11',
    '+line 12',
    ' after',
    '',
  ].join('\n'),
);

const since = (): PlanChapter => ({
  key: 'since',
  title: 'Since you read it',
  narrative: 'A fix round removed a file.',
  files: [],
  refs: [],
  since: { from: 'a'.repeat(40), to: HEAD, commits: 1 },
});
// the chapter as published: it told src/gone.js too
const published = (): PlanChapter => ({
  key: 'a',
  title: 'Chapter 1: A',
  narrative: 'It does a thing, [here](ref:here).',
  files: ['src/a.js', 'src/gone.js'],
  refs: [
    { id: 'here', path: 'src/a.js', side: 'R', start: 10, end: 13 },
    { id: 'old', path: 'src/gone.js', side: 'R', start: 1, end: 5 },
  ],
});
const before: Plan = { mode: 'journey', chapters: [published()] };
const updateWith = (kept: PlanChapter): Plan => ({ mode: 'journey', chapters: [since(), kept] });

test('an update keeps a chapter whose refs and files on a removed file are dropped', () => {
  const kept = published();
  kept.files = ['src/a.js'];
  kept.refs = kept.refs!.filter((ref) => ref.path === 'src/a.js');
  assert.deepEqual(updateProblems(before, updateWith(kept), HEAD, diff), []);
});

test('an update still refuses a kept chapter that changed in any other way', () => {
  const kept = published();
  kept.files = ['src/a.js'];
  kept.refs = kept.refs!.filter((ref) => ref.path === 'src/a.js');
  kept.narrative = 'It does another thing, [here](ref:here).';
  assert.match(updateProblems(before, updateWith(kept), HEAD, diff).join('\n'), /changed/);

  const movedRef = published();
  movedRef.files = ['src/a.js'];
  movedRef.refs = [{ id: 'here', path: 'src/a.js', side: 'R', start: 11, end: 12 }];
  assert.match(updateProblems(before, updateWith(movedRef), HEAD, diff).join('\n'), /changed/);

  const droppedLive = published();
  droppedLive.files = ['src/a.js'];
  droppedLive.refs = [{ id: 'old', path: 'src/gone.js', side: 'R', start: 1, end: 5 }];
  assert.match(updateProblems(before, updateWith(droppedLive), HEAD, diff).join('\n'), /changed/);
});

test('an update that keeps the removed file byte for byte is told only that the file is not in the diff', () => {
  const problems = updateProblems(before, updateWith(published()), HEAD, diff);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /names src\/gone\.js, which is not in the diff/);
});

test('a refused kept chapter names what changed', () => {
  const kept = published();
  kept.files = ['src/a.js', 'src/gone.js', 'src/extra.js'];
  kept.narrative = 'It does another thing, [here](ref:here).';
  const text = updateProblems(before, updateWith(kept), HEAD, diff).join('\n');
  assert.match(text, /changed \(narrative, files it did not list\)/);
  assert.doesNotMatch(text, /copy them from/);
});

// the whole publish: the update gate, then readyPlan's chapterProblems over the same diff
const publishProblems = (plan: Plan) => [
  ...updateProblems(before, plan, HEAD, diff),
  ...chapterProblems(plan, { diff, served: before }),
];

test('a kept chapter whose text links the dropped ref publishes', () => {
  const linking = published();
  linking.narrative = 'It does a thing, [here](ref:here), once at [the old spot](ref:old).';
  const served: Plan = { mode: 'journey', chapters: [linking] };
  const kept = structuredClone(linking);
  kept.files = ['src/a.js'];
  kept.refs = kept.refs!.filter((ref) => ref.path === 'src/a.js');
  const plan = updateWith(kept);
  assert.deepEqual(updateProblems(served, plan, HEAD, diff), []);
  assert.deepEqual(chapterProblems(plan, { diff, served }), []);
  // a link to a ref the chapter never had is still refused
  kept.narrative += ' And [nowhere](ref:nope).';
  assert.match(chapterProblems(plan, { diff, served }).join('\n'), /links to ref:nope/);
});

test('a kept chapter that lost only the removed file still counts as kept as published', () => {
  const served = published();
  // a remaining ref outside the hunk and a comment on a line in no hunk: a kept chapter skips both checks
  served.refs!.push({ id: 'far', path: 'src/a.js', side: 'R', start: 40, end: 42 });
  served.comments = [{ path: 'src/a.js', line: 41, body: 'far away' }];
  const wasServed: Plan = { mode: 'journey', chapters: [served] };
  const kept = structuredClone(served);
  kept.files = ['src/a.js'];
  kept.refs = kept.refs!.filter((ref) => ref.path === 'src/a.js');
  assert.deepEqual(chapterProblems(updateWith(kept), { diff, served: wasServed }), []);
  // the same chapter with the far ref moved is a changed chapter: its places are checked again
  kept.refs = kept.refs!.map((ref) => (ref.id === 'far' ? { ...ref, start: 43, end: 44 } : ref));
  assert.match(
    chapterProblems(updateWith(kept), { diff, served: wasServed }).join('\n'),
    /in no hunk/,
  );
  assert.match(
    updateProblems(wasServed, updateWith(kept), HEAD, diff).join('\n'),
    /changed \(refs\)/,
  );
});

test('the clean drop passes the gate and the validation together', () => {
  const kept = published();
  kept.files = ['src/a.js'];
  kept.refs = kept.refs!.filter((ref) => ref.path === 'src/a.js');
  assert.deepEqual(publishProblems(updateWith(kept)), []);
});
