import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answersBadge,
  tagFor,
  tagHtml,
  requestFor,
  missingListeners,
  wantsAskDock,
  withAskDock,
} from '../src/content/ui/story-tag.ts';
import { conversationPr } from '@once-upon-a-diff/shared/util/github-paths';

const pr = { repo: 'octo-org/api-server', number: 42 };

test('one tag per PR, and the tag is the control', () => {
  const ready = tagFor({ state: 'ready', story: 's', story_head: 'abc1234def' }, pr);
  assert.deepEqual(
    [ready.kind, ready.label, ready.href],
    ['link', 'Story', 'https://github.com/octo-org/api-server/pull/42/changes'],
  );
  const none = tagFor({ state: 'none' }, pr);
  assert.deepEqual([none.kind, none.act, none.label], ['button', 'build', 'Build story']);
  assert.equal(tagFor(null, pr).act, 'build', 'no answer yet reads as none');
  assert.match(
    tagFor({ state: 'none', request: { status: 'failed' } }, pr).title,
    /The last build failed/,
  );
  const stale = tagFor(
    { state: 'ready', stale: true, story_head: 'abc1234', current_head: 'def5678' },
    pr,
  );
  assert.deepEqual(
    [stale.kind, stale.act, stale.label, stale.base],
    ['button', 'update', 'Story out of date · Update', 'abc1234'],
  );
  const queued = tagFor({ state: 'queued', request: { requested_at: '2026-10-21T17:00:00Z' } }, pr);
  assert.deepEqual(
    [queued.kind, queued.label],
    ['progress', 'Queued'],
    'queued shows progress and is not clickable',
  );
  const building = tagFor({ state: 'building' }, pr);
  assert.deepEqual([building.kind, building.label, building.spin], ['progress', 'Building…', true]);
  assert.equal(
    tagFor({ state: 'ready', updating: true, update_state: 'queued', stale: true }, pr).label,
    'Update queued',
  );
  assert.equal(
    tagFor({ state: 'ready', updating: true, update_state: 'building' }, pr).label,
    'Updating…',
  );
});

test('the HTML is one element: a link, a button, or a span', () => {
  const count = (html: string) => (html.match(/<(a|button|span) class="b/g) || []).length;
  for (const result of [
    { state: 'ready' },
    { state: 'none' },
    { state: 'queued' },
    { state: 'building' },
    { state: 'ready', stale: true, story_head: 'a' },
  ]) {
    assert.equal(count(String(tagHtml(tagFor(result, pr)))), 1, JSON.stringify(result));
  }
  assert.match(String(tagHtml(tagFor({ state: 'queued' }, pr))), /^<span /);
  assert.match(String(tagHtml(tagFor({ state: 'none' }, pr))), /^<button [^>]*data-act="build"/);
  assert.ok(
    !String(tagHtml({ kind: 'progress', cls: '', label: '<x>', title: '"' })).includes('<x>'),
    'escapes',
  );
});

test('Build story sends a build request, and Update sends an update from the story head', () => {
  const build = requestFor(tagFor({ state: 'none' }, pr), pr);
  assert.equal(build.url, 'https://github.com/octo-org/api-server/pull/42');
  assert.equal(build.mode, undefined);
  const upd = requestFor(tagFor({ state: 'ready', stale: true, story_head: 'abc1234' }, pr), pr);
  assert.deepEqual([upd.mode, upd.base_sha], ['update', 'abc1234']);
});

test('the notice lists only the repos with no listener', () => {
  const missing = missingListeners({
    'octo-org/api-server': {
      ok: false,
      prompt: '/once-upon-listen octo-org/api-server',
      details: 'long',
      checkout: '~/Development/api-server',
    },
    'octo-org/web-app': { ok: true, prompt: '/once-upon-listen octo-org/web-app' },
  });
  assert.deepEqual(missing, [
    {
      repo: 'octo-org/api-server',
      prompt: '/once-upon-listen octo-org/api-server',
      details: 'long',
      checkout: '~/Development/api-server',
    },
  ]);
  assert.deepEqual(missingListeners(undefined), []);
});

test('the Conversation tab is /owner/repo/pull/N and nothing after it', () => {
  assert.deepEqual(conversationPr('/octo-org/api-server/pull/42'), pr);
  assert.deepEqual(conversationPr('/octo-org/api-server/pull/42/'), pr);
  for (const pathname of [
    '/octo-org/api-server/pull/42/files',
    '/octo-org/api-server/pull/42/changes',
    '/octo-org/api-server/pull/42/commits',
    '/octo-org/api-server/pulls',
  ]) {
    assert.equal(conversationPr(pathname), null, pathname);
  }
});

test('a #ou-step-N hash names the step to open on', async () => {
  const { stepOfHash } = await import('../src/content/ui/story-tag.ts');
  assert.equal(stepOfHash('#ou-step-3'), 3);
  for (const hash of ['', '#diff-abc', '#ou-step-', '#ou-step-x']) {
    assert.equal(stepOfHash(hash), null, hash);
  }
});

test('a PR with unread answers gets a badge beside its one tag, linking Files changed with the Ask dock open', () => {
  const pr = { repo: 'acme/widgets', number: 7 };
  const ready = { state: 'ready', story: 's', story_head: 'abc1234def' };
  assert.equal(answersBadge({ ...ready, unread_answers: 0 }, pr), null);
  assert.equal(answersBadge(ready, pr), null, 'an older bridge says nothing');
  assert.equal(answersBadge({ state: 'none', unread_answers: 2 }, pr), null, 'no story, no badge');
  const one = String(answersBadge({ ...ready, unread_answers: 1 }, pr));
  assert.match(one, /href="https:\/\/github.com\/acme\/widgets\/pull\/7\/changes#ou-ask"/);
  assert.match(one, />1 new answer</);
  assert.match(String(answersBadge({ ...ready, unread_answers: 3 }, pr)), />3 new answers</);
  // the badge is not a second tag
  assert.equal((String(tagHtml(tagFor(ready, pr))).match(/class="b /g) || []).length, 1);
  assert.equal(wantsAskDock('#ou-ask'), true);
  assert.equal(wantsAskDock('#ou-step-2'), false);
  assert.equal(wantsAskDock(''), false);
});

test('the Ask dock opens once for a #ou-ask URL and stays as the reviewer leaves it', () => {
  const href = 'https://github.com/acme/widgets/pull/7/changes#ou-ask';
  const saved = { n: 2, chatOpen: false };
  const first = withAskDock(saved, { hash: '#ou-ask', href, opened: undefined });
  assert.equal(first.panel.chatOpen, true);
  assert.equal(first.opened, href);
  assert.equal(saved.chatOpen, false, 'the saved state is not changed');
  // the panel is mounted again on this URL (the reviewer closed the dock): it stays closed
  const again = withAskDock(saved, { hash: '#ou-ask', href, opened: first.opened });
  assert.equal(again.panel.chatOpen, false);
  // another hash, or none: the saved state as it is
  assert.equal(withAskDock(saved, { hash: '#ou-step-2', href, opened: undefined }).panel, saved);
  assert.equal(withAskDock(saved, { hash: '', href, opened: undefined }).panel, saved);
});
