import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import { approvalAtTip, forgetTips } from '../src/approval.ts';
import { StoryStore } from '../src/store.ts';

/** An approval at the repo's HEAD, and the story meta that names it. */
function approved(carried?: { from: string }, legacy = false) {
  const { repo } = localRepo();
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const home = tmp('approval-at-tip');
  const approval = {
    at: new Date().toISOString(),
    head_oid: head,
    base_oid: null,
    ...(carried && { carried: { ...carried, at: new Date().toISOString(), run: 'fix-x' } }),
  };
  if (legacy) {
    writeJson(path.join(home, 'state', 's1', 'approved.json'), { ...approval, marked: true });
  } else {
    writeJson(path.join(home, 'state', 's1', 'review.json'), { approval });
  }
  const stories = new StoryStore({ home });
  const meta = { head_oid: head, head: 'HEAD', repo_path: repo };
  return { stories, meta, repo, head };
}

test('an approval counts while the story ref is at the approved commit, and not once the branch has moved on', () => {
  forgetTips();
  const { stories, meta, repo, head } = approved();
  assert.equal(approvalAtTip(stories, 's1', meta)?.head_oid, head);
  git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'amended');
  forgetTips();
  assert.equal(approvalAtTip(stories, 's1', meta), null, 'meta.json still names the old head');
});

test('where the ref is stays known for a couple of seconds, so polls do not each ask git', () => {
  forgetTips();
  const { stories, meta, repo, head } = approved();
  assert.equal(approvalAtTip(stories, 's1', meta)?.head_oid, head);
  git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'amended');
  assert.equal(approvalAtTip(stories, 's1', meta)?.head_oid, head, 'the kept answer');
  forgetTips();
  assert.equal(approvalAtTip(stories, 's1', meta), null);
});

test('a ref git cannot resolve (a deleted branch, a missing checkout) leaves the approval alone', () => {
  forgetTips();
  const { stories, meta, head } = approved();
  assert.equal(
    approvalAtTip(stories, 's1', { ...meta, head: 'feat/deleted' })?.head_oid,
    head,
    'a branch that is gone',
  );
  assert.equal(
    approvalAtTip(stories, 's1', { ...meta, repo_path: path.join(tmp('nothing'), 'gone') })
      ?.head_oid,
    head,
    'a checkout that is gone',
  );
});

test('a carried approval counts while the ref sits at the commit it was first given for, and not once the ref is at neither', () => {
  forgetTips();
  const { stories, meta, repo, head } = approved({ from: 'b'.repeat(40) });
  const pinned = { ...meta, head_oid: 'b'.repeat(40) }; // a story told over a branch keeps the head it was told at
  git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'amended');
  forgetTips();
  assert.equal(approvalAtTip(stories, 's1', pinned), null, 'the ref is at neither commit');
  git(repo, 'reset', '-q', '--hard', head);
  forgetTips();
  assert.equal(approvalAtTip(stories, 's1', pinned)?.head_oid, head, 'back at the approved commit');
});

test('a story folder that still has approved.json (before its first write) counts the same way', () => {
  forgetTips();
  const { stories, meta, repo, head } = approved(undefined, true);
  assert.equal(approvalAtTip(stories, 's1', meta)?.head_oid, head);
  git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'amended');
  forgetTips();
  assert.equal(approvalAtTip(stories, 's1', meta), null);
});
