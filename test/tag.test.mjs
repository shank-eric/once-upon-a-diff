import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFor, tagHtml, requestFor, missingListeners, conversationPr } from '../src/js/content/tag.js';

const pr = { repo: 'EverFi/furnace', number: 3058 };

test('one tag per PR, and the tag is the control', () => {
  const ready = tagFor({ state: 'ready', story: 's', story_head: 'abc1234def' }, pr);
  assert.deepEqual([ready.kind, ready.label, ready.href], ['link', 'Story', 'https://github.com/EverFi/furnace/pull/3058/changes']);
  const none = tagFor({ state: 'none' }, pr);
  assert.deepEqual([none.kind, none.act, none.label], ['button', 'build', 'Build story']);
  assert.equal(tagFor(null, pr).act, 'build', 'no answer yet reads as none');
  const stale = tagFor({ state: 'ready', stale: true, story_head: 'abc1234', current_head: 'def5678' }, pr);
  assert.deepEqual([stale.kind, stale.act, stale.label, stale.base], ['button', 'update', 'Story out of date · Update', 'abc1234']);
  const queued = tagFor({ state: 'queued', request: { requested_at: '2026-10-21T17:00:00Z' } }, pr);
  assert.deepEqual([queued.kind, queued.label], ['progress', 'Queued'], 'queued shows progress and is not clickable');
  const building = tagFor({ state: 'building' }, pr);
  assert.deepEqual([building.kind, building.label, building.spin], ['progress', 'Building…', true]);
  assert.equal(tagFor({ state: 'ready', updating: true, update_state: 'queued', stale: true }, pr).label, 'Update queued');
  assert.equal(tagFor({ state: 'ready', updating: true, update_state: 'building' }, pr).label, 'Updating…');
});

test('the HTML is one element: a link, a button, or a span', () => {
  const count = html => (html.match(/<(a|button|span) class="b/g) || []).length;
  for (const r of [{ state: 'ready' }, { state: 'none' }, { state: 'queued' }, { state: 'building' }, { state: 'ready', stale: true, story_head: 'a' }]) {
    assert.equal(count(tagHtml(tagFor(r, pr))), 1, JSON.stringify(r));
  }
  assert.match(tagHtml(tagFor({ state: 'queued' }, pr)), /^<span /);
  assert.match(tagHtml(tagFor({ state: 'none' }, pr)), /^<button [^>]*data-act="build"/);
  assert.ok(!tagHtml({ kind: 'progress', cls: '', label: '<x>', title: '"' }).includes('<x>'), 'escapes');
});

test('Build story sends a build request, and Update sends an update from the story head', () => {
  const build = requestFor(tagFor({ state: 'none' }, pr), pr);
  assert.equal(build.url, 'https://github.com/EverFi/furnace/pull/3058');
  assert.equal(build.mode, undefined);
  const upd = requestFor(tagFor({ state: 'ready', stale: true, story_head: 'abc1234' }, pr), pr);
  assert.deepEqual([upd.mode, upd.base_sha], ['update', 'abc1234']);
});

test('the notice lists only the repos with no listener', () => {
  const m = missingListeners({
    'EverFi/furnace': { ok: false, prompt: '/diff-story-listen EverFi/furnace', details: 'long', checkout: '~/Development/SDK/furnace' },
    'EverFi/everfi-frontend': { ok: true, prompt: '/diff-story-listen EverFi/everfi-frontend' },
  });
  assert.deepEqual(m, [{ repo: 'EverFi/furnace', prompt: '/diff-story-listen EverFi/furnace', details: 'long', checkout: '~/Development/SDK/furnace' }]);
  assert.deepEqual(missingListeners(undefined), []);
});

test('the Conversation tab is /owner/repo/pull/N and nothing after it', () => {
  assert.deepEqual(conversationPr({ pathname: '/EverFi/furnace/pull/3058' }), pr);
  assert.deepEqual(conversationPr({ pathname: '/EverFi/furnace/pull/3058/' }), pr);
  for (const p of ['/EverFi/furnace/pull/3058/files', '/EverFi/furnace/pull/3058/changes', '/EverFi/furnace/pull/3058/commits', '/EverFi/furnace/pulls']) assert.equal(conversationPr({ pathname: p }), null, p);
});

test('a #dsm-step-N hash names the step to open on', async () => {
  const { stepOfHash } = await import('../src/js/content/tag.js');
  assert.equal(stepOfHash('#dsm-step-3'), 3);
  for (const h of ['', '#diff-abc', '#dsm-step-', '#dsm-step-x']) assert.equal(stepOfHash(h), null, h);
});
