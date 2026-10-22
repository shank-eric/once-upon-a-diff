import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filesChangedPr,
  conversationPr,
  isPullListPage,
  pageKindOf,
  rangeOfPath,
} from '../src/shared/util/github-paths.js';
import { escapeHtml, unescapeHtml } from '../src/shared/util/html.js';
import { shortSha, baseName, plural, capitalize } from '../src/shared/util/text.js';
import { clockTime, shortDateTime } from '../src/shared/util/time.js';

const locationOf = (url) => {
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
  assert.equal(filesChangedPr('/acme/widgets/pull/7/files/abc1234..def5678').view, 'files');
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
  assert.deepEqual(rangeOfPath('/acme/widgets/pull/7/changes/abc1234..def5678'), {
    from: 'abc1234',
    to: 'def5678',
  });
});

test('the shared text helpers', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(unescapeHtml(escapeHtml('a < b & "c"')), 'a < b & "c"');
  assert.equal(shortSha('0123456789abcdef'), '0123456');
  assert.equal(shortSha(null), '');
  assert.equal(baseName('src/app/main.js'), 'main.js');
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(2, 'file'), '2 files');
  assert.equal(capitalize('chapter 2'), 'Chapter 2');
  assert.equal(clockTime('not a date'), '');
  assert.equal(shortDateTime(''), '');
  assert.notEqual(shortDateTime('2026-10-21T15:41:00Z'), '');
});
