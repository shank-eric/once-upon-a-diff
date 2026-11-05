import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prKey, rangeOfPath } from '../src/pr-key.ts';
import { laneLabels, resolveLane, sameLaneKey } from '../src/lane-key.ts';
import { escapeHtml, unescapeHtml, html, raw, Html } from '../src/html.ts';
import {
  FULL_SHA_RE,
  SID_RE,
  AGENT_NAME_RE,
  CARD_BRANCH_RE,
  BRANCH_RE,
  SESSION_RE,
} from '../src/patterns.ts';
import { formatLineRef, parseLineRef, toSide } from '../src/line-refs.ts';
import { prUrl } from '../src/github-urls.ts';
import { fixStage, fixState } from '../src/fix-notes.ts';
import {
  SHA_RE,
  shortSha,
  baseName,
  repoName,
  plural,
  capitalize,
  collapse,
  gateText,
} from '../src/text.ts';
import { clockTime, compactAge, minutesSince, shortDateTime } from '../src/time.ts';

test('a PR key and a commit range in a PR diff URL', () => {
  assert.equal(prKey('Acme/Widgets', 7), 'acme/widgets#7');
  assert.deepEqual(rangeOfPath('/acme/widgets/pull/7/changes/abc1234..def5678'), {
    from: 'abc1234',
    to: 'def5678',
  });
  assert.equal(rangeOfPath('/acme/widgets/pull/7/changes'), null);
});

test('the sha patterns take SHA-1 and SHA-256 forms', () => {
  assert.ok(SHA_RE.test('abc1234') && SHA_RE.test('a'.repeat(40)) && SHA_RE.test('a'.repeat(64)));
  assert.ok(!SHA_RE.test('abc123') && !SHA_RE.test('a'.repeat(65)));
  assert.ok(FULL_SHA_RE.test('a'.repeat(40)) && FULL_SHA_RE.test('a'.repeat(64)));
  assert.ok(!FULL_SHA_RE.test('a'.repeat(39)) && !FULL_SHA_RE.test('a'.repeat(41)));
  assert.ok(!FULL_SHA_RE.test('a'.repeat(65)));
  assert.ok(!FULL_SHA_RE.test('A'.repeat(40))); // git prints lower case
});

test('collapse squeezes whitespace runs and trims the ends', () => {
  assert.equal(collapse('  Tue\t Nov   4\n10:00:00 2026 '), 'Tue Nov 4 10:00:00 2026');
  assert.equal(collapse(' \n '), '');
});

test('the text helpers', () => {
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

test('minutes and the compact age since an ISO time', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const before = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  assert.equal(minutesSince(null, now), null);
  assert.equal(minutesSince('nope', now), null);
  assert.equal(minutesSince(before(5.9), now), 5);
  assert.equal(minutesSince(before(-3), now), 0);
  assert.equal(compactAge(null, now), '');
  assert.equal(compactAge('nope', now), '');
  assert.equal(compactAge(before(0), now), 'now');
  assert.equal(compactAge(before(5), now), '5m');
  assert.equal(compactAge(before(180), now), '3h');
  assert.equal(compactAge(before(2879), now), '47h');
  assert.equal(compactAge(before(2880), now), '2d');
  assert.equal(compactAge(before(1500), now, 24), '1d');
});

test('what an agent at a gate is doing', () => {
  assert.equal(gateText({ name: 'a', gate: { kind: 'plan', findings: null } }), 'plan check');
  assert.equal(gateText({ name: 'a', gate: { kind: 'fixing', findings: null } }), 'fixing');
  assert.equal(gateText({ name: 'a', gate: { kind: 'fixing', findings: 1 } }), 'fixing 1 finding');
  assert.equal(gateText({ name: 'a', gate: { kind: 'fixing', findings: 5 } }), 'fixing 5 findings');
  assert.equal(
    gateText({ name: 'review-x', gate: { kind: 'review', findings: null } }),
    'agent review · review-x',
  );
});

test('lane keys: a short label unless two lanes share it, and a tag resolves only when one repo has that name', () => {
  assert.deepEqual(
    [...laneLabels(['a/foo', 'b/foo', 'acme/widgets', 'tmp-dir'])],
    [
      ['a/foo', 'a/foo'],
      ['b/foo', 'b/foo'],
      ['acme/widgets', 'widgets'],
      ['tmp-dir', 'tmp-dir'],
    ],
  );
  assert.equal(laneLabels(['a/foo']).get('a/foo'), 'foo');
  assert.equal(laneLabels(['a/foo', 'foo']).get('a/foo'), 'a/foo', 'a folder named foo counts');
  assert.equal(resolveLane('widgets', ['acme/widgets', 'a/foo', 'b/foo']), 'acme/widgets');
  assert.equal(resolveLane('foo', ['a/foo', 'b/foo']), 'foo');
  assert.equal(resolveLane('nothing', ['a/foo']), 'nothing');
});

test('lane keys ignore case, and a key with no short name is labeled by itself', () => {
  assert.equal(laneLabels(['EverFi/x', 'everfi/x']).get('EverFi/x'), 'x', 'one repo spelled twice');
  assert.equal(laneLabels(['EverFi/x', 'other/x']).get('EverFi/x'), 'EverFi/x');
  assert.equal(laneLabels(['/', 'acme/widgets']).get('/'), '/');
  assert.equal(resolveLane('x', ['EverFi/x', 'everfi/x']), 'EverFi/x');
  assert.equal(sameLaneKey('EverFi/x', 'everfi/X'), true);
  assert.equal(sameLaneKey('a/x', 'b/x'), false);
});

test('when two repos share a short name, every spelling of one is labeled by the first spelling given', () => {
  const labels = laneLabels(['EverFi/x', 'other/x', 'everfi/x']);
  assert.equal(labels.get('EverFi/x'), 'EverFi/x');
  assert.equal(labels.get('everfi/x'), 'EverFi/x', 'the lane’s own spelling, not the worktree’s');
  assert.equal(labels.get('other/x'), 'other/x');
});

test('toSide keeps L and turns anything else into R', () => {
  assert.equal(toSide('L'), 'L');
  assert.equal(toSide('R'), 'R');
  assert.equal(toSide(undefined), 'R');
  assert.equal(toSide(null), 'R');
  assert.equal(toSide('left'), 'R');
});

test('formatLineRef writes the form parseLineRef reads', () => {
  assert.equal(formatLineRef('src/a.ts', { side: 'R', start: 45 }), 'src/a.ts:45');
  assert.equal(formatLineRef('src/a.ts', { start: 45 }), 'src/a.ts:45');
  assert.equal(formatLineRef('src/a.ts', { side: 'L', start: 12 }), 'src/a.ts:L12');
  assert.equal(formatLineRef('src/a.ts', { side: 'R', start: 40, end: 58 }), 'src/a.ts:40-58');
  assert.equal(formatLineRef('src/a.ts', { side: 'L', start: 7, end: 7 }), 'src/a.ts:L7');
  for (const line of [
    { side: 'R', start: 45, end: 45 },
    { side: 'L', start: 12, end: 12 },
    { side: 'R', start: 40, end: 58 },
  ] as const) {
    assert.deepEqual(parseLineRef(formatLineRef('x/y.ts', line)), { name: 'x/y.ts', line });
  }
});

test('prUrl names a PR and its tab', () => {
  assert.equal(prUrl('acme/widgets', 7), 'https://github.com/acme/widgets/pull/7');
  assert.equal(prUrl('acme/widgets', '7', 'files'), 'https://github.com/acme/widgets/pull/7/files');
  assert.equal(
    prUrl('acme/widgets', 7, 'changes') + '#ou-ask',
    'https://github.com/acme/widgets/pull/7/changes#ou-ask',
  );
});

test('repoName is the part after the slash', () => {
  assert.equal(repoName('acme/widgets'), 'widgets');
  assert.equal(repoName('widgets'), '');
  assert.equal(repoName(null), '');
  assert.equal(repoName(undefined), '');
});

test('the sid, name and branch patterns', () => {
  assert.ok(SID_RE.test('989b3246') && !SID_RE.test('989b324') && !SID_RE.test('989B3246'));
  assert.ok(!SID_RE.test('989b32467'));
  assert.ok(AGENT_NAME_RE.test('domain-helpers') && AGENT_NAME_RE.test('a.b_c'));
  assert.ok(!AGENT_NAME_RE.test('') && !AGENT_NAME_RE.test('a b') && !AGENT_NAME_RE.test('a/b'));
  assert.ok(!AGENT_NAME_RE.test('a'.repeat(101)));
  assert.ok(CARD_BRANCH_RE.test('backlog/slug-abcd') && !CARD_BRANCH_RE.test('a b'));
  assert.ok(!CARD_BRANCH_RE.test('a'.repeat(201)) && !CARD_BRANCH_RE.test('feat~1'));
  assert.ok(BRANCH_RE.test('feat') && SESSION_RE.test('abc-1'));
});

test('a fix note goes draft, queued or sent, then fixed', () => {
  const sent = { request: 'r', to: 'agent', at: 't' };
  assert.equal(fixStage({}), 'draft');
  assert.equal(fixStage({ sent: null, fixed: null }), 'draft');
  assert.equal(fixStage({ sent: { ...sent, to: null } }), 'queued');
  assert.equal(fixStage({ sent }), 'sent');
  assert.equal(fixStage({ sent, fixed: { sha: 'abc' } }), 'fixed');
  assert.equal(fixState({}), 'draft');
  assert.equal(fixState({ sent: { ...sent, to: null } }), 'sent');
  assert.equal(fixState({ sent }), 'sent');
  assert.equal(fixState({ fixed: { sha: 'abc' } }), 'fixed');
});
