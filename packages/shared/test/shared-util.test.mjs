import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filesChangedPr,
  conversationPr,
  isPullListPage,
  pageKindOf,
  rangeOfPath,
} from '../src/util/github-paths.ts';
import { escapeHtml, unescapeHtml, html, raw, Html } from '../src/util/html.ts';
import { shortSha, baseName, plural, capitalize } from '../src/util/text.ts';
import { clockTime, shortDateTime } from '../src/util/time.ts';

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
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(unescapeHtml(escapeHtml(`a < b & "c" 'd'`)), `a < b & "c" 'd'`);
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

describe('the html`` tag', () => {
  const evil = '<img src=x onerror="alert(1)">';

  test('escapes every value, in text and in attributes', () => {
    const markup = html`<p title="${evil}">${evil} & ${"it's"}</p>`;
    assert.ok(markup instanceof Html);
    assert.equal(
      String(markup),
      '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; & it&#39;s</p>',
    );
    // a value can't close a quoted attribute and add its own
    assert.doesNotMatch(String(html`<a href="${'" onclick="x'}">`), /" onclick="/);
    assert.doesNotMatch(String(html`<a href='${"' onclick='x"}'>`), /' onclick='/);
  });

  test('puts html`` results and raw() in as is', () => {
    const inner = html`<b>${'<i>'}</b>`;
    assert.equal(String(html`<p>${inner}</p>`), '<p><b>&lt;i&gt;</b></p>');
    assert.equal(String(html`<p>${raw('<em>ok</em>')}</p>`), '<p><em>ok</em></p>');
    assert.equal(raw(inner), inner, 'raw() of markup is the same markup');
    assert.equal(String(raw(null)), '');
  });

  test('joins arrays, escaping their strings and keeping their markup', () => {
    const items = ['<a>', html`<li>b</li>`, ['<c>', html`<d/>`]];
    assert.equal(String(html`<ul>${items}</ul>`), '<ul>&lt;a&gt;<li>b</li>&lt;c&gt;<d/></ul>');
    assert.equal(String(html`<ul>${[]}</ul>`), '<ul></ul>');
  });

  test('null, undefined and false give nothing; 0 and true are text', () => {
    assert.equal(String(html`[${null}${undefined}${false}]`), '[]');
    assert.equal(String(html`[${0}|${true}|${''}]`), '[0|true|]');
    const [hidden, open] = [false, true];
    assert.equal(String(html`<p${hidden && html` hidden`}${open && html` open`}>`), '<p open>');
  });

  test('turns into its markup wherever a string is wanted', () => {
    const markup = html`<i>${'&'}</i>`;
    assert.equal(`${markup}`, '<i>&amp;</i>');
    assert.equal('x' + markup, 'x<i>&amp;</i>');
    assert.equal(markup.markup, '<i>&amp;</i>');
  });
});
