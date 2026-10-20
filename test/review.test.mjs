import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { addToPendingReview } from '../bridge/lib/review.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh-review.mjs');
chmodSync(fake, 0o755);

function withFake(env, fn) {
  const saved = { gh: process.env.DIFF_STORY_GH, log: process.env.FAKE_GH_LOG, pending: process.env.FAKE_GH_PENDING };
  const log = path.join(tmp('gh'), 'calls.jsonl');
  process.env.DIFF_STORY_GH = fake;
  process.env.FAKE_GH_LOG = log;
  if (env.pending) process.env.FAKE_GH_PENDING = '1'; else delete process.env.FAKE_GH_PENDING;
  const restore = () => {
    for (const [k, v] of [['DIFF_STORY_GH', saved.gh], ['FAKE_GH_LOG', saved.log], ['FAKE_GH_PENDING', saved.pending]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return fn(() => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))).finally(restore);
}
const queryOf = call => call.find(a => a.startsWith('query='));

test('starts a pending review when Eric has none, then adds the thread; never submits', () => withFake({}, async calls => {
  const r = await addToPendingReview('acme/widgets', 7, { path: 'src/a.js', line: 12, body: 'Could you confirm this?' });
  assert.equal(r.started, true);
  assert.equal(r.review, 'PRR_new');
  assert.match(r.url, /discussion_r1/);
  const qs = calls().map(queryOf);
  assert.equal(qs.length, 3);
  assert.ok(qs[1].includes('addPullRequestReview('));
  for (const q of qs) {
    assert.ok(!/submitPullRequestReview|event:|APPROVE|REQUEST_CHANGES|addPullRequestReviewComment|addComment\(/.test(q), 'nothing that submits or posts');
  }
}));

test('reuses his existing pending review and sends RIGHT side by default', () => withFake({ pending: true }, async calls => {
  const r = await addToPendingReview('acme/widgets', 7, { path: 'src/a.js', line: 12, body: 'x' });
  assert.equal(r.started, false);
  assert.equal(r.review, 'PRR_old');
  const thread = calls()[1];
  assert.ok(thread.includes('review=PRR_old'));
  assert.ok(thread.includes('side=RIGHT'));
}));

test('general comments and empty drafts are refused without calling gh', () => withFake({}, async () => {
  await assert.rejects(addToPendingReview('acme/widgets', 7, { path: '', line: 0, body: 'general' }), /only line comments/);
  await assert.rejects(addToPendingReview('acme/widgets', 7, { path: 'a.js', line: 3, body: '  ' }), /empty/);
}));
