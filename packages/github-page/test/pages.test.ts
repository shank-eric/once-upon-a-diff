import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesChangedPr, conversationPr, isPullListPage, pageKindOf } from '../src/pages.ts';

const locationOf = (url: string) => {
  const parsed = new URL(url, 'https://github.com');
  return { pathname: parsed.pathname, search: parsed.search };
};

test('a PR Files changed path, on /changes, /files and below them', () => {
  assert.deepEqual(filesChangedPr('/Acme/Widgets/pull/7/changes'), {
    owner: 'Acme',
    repo: 'Widgets',
    number: 7,
    key: 'acme/widgets#7',
    view: 'changes',
  });
  assert.equal(filesChangedPr('/acme/widgets/pull/7/files/abc1234..def5678')!.view, 'files');
  assert.equal(filesChangedPr('/acme/widgets/pull/7'), null);
  assert.equal(filesChangedPr('/acme/widgets/pull/7/filesx'), null);
});

test('the page kind the content script routes on', () => {
  assert.equal(pageKindOf(locationOf('/acme/widgets/pull/7/files')), 'files');
  assert.equal(pageKindOf(locationOf('/acme/widgets/pull/7')), 'conversation');
  assert.equal(pageKindOf(locationOf('/acme/widgets/pull/7/commits')), 'other');
  assert.equal(pageKindOf(locationOf('/acme/widgets/pulls')), 'list');
  assert.equal(pageKindOf(locationOf('/pulls')), 'list');
  assert.equal(pageKindOf(locationOf('/search?q=is%3Apr+author%3Ame')), 'list');
  assert.equal(pageKindOf(locationOf('/search?type=pullrequests&q=x')), 'list');
  assert.equal(pageKindOf(locationOf('/search?q=x')), 'other');
  assert.equal(pageKindOf(locationOf('/acme/widgets/issues?q=is%3Apr')), 'list');
  assert.equal(pageKindOf(locationOf('/acme/widgets/issues')), 'other');
  assert.deepEqual(conversationPr('/acme/widgets/pull/7/'), { repo: 'acme/widgets', number: 7 });
  assert.equal(isPullListPage(locationOf('/acme/widgets')), false);
});
