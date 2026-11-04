import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown, type MarkdownLink } from '../src/markdown.ts';

const render = (source: string, link?: MarkdownLink) =>
  String(createMarkdown({ link }).markdown(source));

test('blocks: paragraphs, headings, quotes, code fences and nested lists', () => {
  assert.equal(render('one\ntwo\n\nthree'), '<p>one two</p><p>three</p>');
  assert.equal(render('## Title'), '<h2>Title</h2>');
  assert.equal(render('> quoted\n> more'), '<blockquote><p>quoted more</p></blockquote>');
  assert.equal(render('```\n<b>&\n```'), '<pre><code>&lt;b&gt;&amp;</code></pre>');
  assert.equal(render('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('inline: escaped first, then code, bold and italics', () => {
  assert.equal(render('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(
    render('`a<b>` **bold** *it* _it2_'),
    '<p><code>a&lt;b&gt;</code> <strong>bold</strong> <em>it</em> <em>it2</em></p>',
  );
  assert.equal(render('**not `code` here**'), '<p><strong>not <code>code</code> here</strong></p>');
});

test('links: http(s), relative and #anchors only, and a bad one stays text', () => {
  assert.equal(
    render('[docs](https://x.dev/a?b=1)'),
    '<p><a href="https://x.dev/a?b=1" target="_blank" rel="noopener noreferrer">docs</a></p>',
  );
  assert.match(render('[home](/board)'), /<a href="\/board"/);
  assert.match(render('[up](../x)'), /<a href="\.\.\/x"/);
  assert.match(render('[sec](#part)'), /<a href="#part"/);
  for (const bad of [
    'javascript:alert(1)',
    '//evil.test/x',
    'data:text/html,x',
    'https://x.dev/"onmouseover=1',
  ]) {
    assert.doesNotMatch(render(`[t](${bad})`), /<a /, bad);
  }
  assert.equal(render('[t](javascript:alert(1))'), '<p>[t](javascript:alert(1))</p>');
});

test('a host link is asked first, gets the emphasized words, and null leaves the link to the safe-href rule', () => {
  const asked: [string, string][] = [];
  const link = (url: string, text: string) => {
    asked.push([url, text]);
    return url.startsWith('ref:') ? `<span data-ref="${url}">${text}</span>` : null;
  };
  assert.equal(
    render('see [**the** file](ref:a1) and [web](https://x.dev)', link),
    '<p>see <span data-ref="ref:a1"><strong>the</strong> file</span> and <a href="https://x.dev" target="_blank" rel="noopener noreferrer">web</a></p>',
  );
  assert.deepEqual(
    asked.map(([url]) => url),
    ['ref:a1', 'https://x.dev'],
  );
  assert.equal(
    render('[words](ref:gone)', () => 'words'),
    '<p>words</p>',
    'an unknown ref is its words',
  );
});
