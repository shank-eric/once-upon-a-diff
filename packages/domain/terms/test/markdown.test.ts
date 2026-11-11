import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown, type MarkdownLink } from '../src/html.ts';

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

test('tables: header, delimiter row and body become a table', () => {
  assert.equal(
    render('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'),
    '<div class="ou-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>',
  );
});

test('tables: colons in the delimiter row align the columns', () => {
  const out = render('| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |');
  assert.match(
    out,
    /<th data-align="left">l<\/th><th data-align="center">c<\/th><th data-align="right">r<\/th><th>n<\/th>/,
  );
  assert.match(
    out,
    /<td data-align="left">1<\/td><td data-align="center">2<\/td><td data-align="right">3<\/td><td>4<\/td>/,
  );
});

test('tables: cells take inline code, bold and links', () => {
  const out = render('| a | b | c |\n|---|---|---|\n| `x\\|y` | **bold** | [d](https://x.dev) |');
  assert.match(out, /<td><code>x\|y<\/code><\/td>/);
  assert.match(out, /<td><strong>bold<\/strong><\/td>/);
  assert.match(
    out,
    /<td><a href="https:\/\/x.dev" target="_blank" rel="noopener noreferrer">d<\/a><\/td>/,
  );
});

test('tables: an escaped pipe stays in its cell', () => {
  assert.equal(
    render('| a | b |\n|---|---|\n| one \\| two | 3 |'),
    '<div class="ou-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>one | two</td><td>3</td></tr></tbody></table></div>',
  );
});

test('tables: the leading and trailing pipes are optional', () => {
  assert.equal(
    render('a | b\n--|--\n1 | 2'),
    '<div class="ou-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  );
});

test('tables: a short row is padded and a long row is cut to the header', () => {
  assert.equal(
    render('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'),
    '<div class="ou-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  );
});

test('tables: raw html in a cell is escaped', () => {
  const out = render(
    '| <script>alert(1)</script> | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |',
  );
  assert.doesNotMatch(out, /<script|<img/);
  assert.match(out, /<th>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/th>/);
  assert.match(out, /<td>&lt;img src=x onerror=alert\(1\)&gt;<\/td>/);
  assert.equal(
    render('<table><tr><td>x</td></tr></table>'),
    '<p>&lt;table&gt;&lt;tr&gt;&lt;td&gt;x&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</p>',
  );
});

test('tables: pipes without a delimiter row stay text', () => {
  assert.equal(render('a | b\nc | d'), '<p>a | b c | d</p>');
  assert.equal(render('| a | b |\n| 1 | 2 |'), '<p>| a | b | | 1 | 2 |</p>');
});

test('tables: one in a code fence stays code', () => {
  assert.equal(
    render('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'),
    '<pre><code>| a | b |\n|---|---|\n| 1 | 2 |</code></pre>',
  );
});

test('tables: the text before and after is unchanged', () => {
  const out = render('Before **it**\n| a | b |\n|---|---|\n| 1 | 2 |\nAfter');
  assert.ok(out.startsWith('<p>Before <strong>it</strong></p><div class="ou-table"><table>'));
  assert.ok(out.endsWith('</table></div><p>After</p>'));
});

const wide = (columns: number, rows: number) =>
  `|${'a|'.repeat(columns)}\n|${'-|'.repeat(columns)}\n${'|\n'.repeat(rows)}`;

test('tables: a block over the column or row limit renders as the text it was before', () => {
  assert.ok(render(wide(64, 500)).startsWith('<div class="ou-table">'));
  for (const source of [wide(65, 2), wide(2, 501)]) {
    const out = render(source);
    assert.ok(!out.includes('<table'), 'not a table');
    assert.ok(out.startsWith('<p>|a|a|'));
  }
});

test('tables: a wide header over many short rows stays small and fast', () => {
  const source = wide(1000, 1000);
  assert.ok(source.length < 7000);
  const started = performance.now();
  const out = render(source);
  assert.ok(out.length < 300_000, `output was ${out.length} characters`);
  assert.ok(performance.now() - started < 250);
  assert.ok(render(wide(64, 500)).length < 300_000);
});

test('tables: pathological delimiter rows and cells return quickly', () => {
  const started = performance.now();
  for (const filler of ['-', '|', '\\', ' ', '-|']) {
    render(`| a |\n|${filler.repeat(100_000)}`);
    render(`|${filler.repeat(100_000)}|\n|---|`);
  }
  render(`| a | b |\n|${'-'.repeat(100_000)}|${'-'.repeat(100_000)}|\n| 1 | 2 |`);
  render('|-|\n'.repeat(20_000));
  assert.ok(performance.now() - started < 2000);
});

test('tables: a line that opens another block is not a header', () => {
  assert.equal(render('# A | B\n|---|---|\n| 1 | 2 |'), '<h1>A | B</h1><p>|---|---| | 1 | 2 |</p>');
  assert.ok(!render('- a | b\n|---|---|\n| 1 | 2 |').includes('<table'));
  assert.ok(!render('> a | b\n|---|---|\n| 1 | 2 |').includes('<table'));
});

test('tables: the body ends at a line that opens another block', () => {
  const table =
    '<div class="ou-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>';
  const head = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  assert.equal(
    render(`${head}- item | x\n- other`),
    `${table}<ul><li>item | x</li><li>other</li></ul>`,
  );
  assert.equal(render(`${head}## h | i`), `${table}<h2>h | i</h2>`);
  assert.equal(render(`${head}> q | r`), `${table}<blockquote><p>q | r</p></blockquote>`);
  assert.equal(render(`${head}\`\`\`\nx | y\n\`\`\``), `${table}<pre><code>x | y</code></pre>`);
});

test('tables: like a code fence, one under a numbered step ends the list', () => {
  // the renderer has no notion of a block nested in a list item, so a table follows the fence's lead
  assert.equal(
    render('1. one\n```\nx\n```\n2. two'),
    '<ol><li>one</li></ol><pre><code>x</code></pre><ol><li>two</li></ol>',
  );
  const out = render('1. one\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n2. two');
  assert.ok(out.startsWith('<ol><li>one</li></ol><div class="ou-table">'));
  assert.ok(out.endsWith('</div><ol><li>two</li></ol>'));
});

const centered = (columns: number, rows: number) =>
  `${'a|'.repeat(columns - 1)}a\n${':-:|'.repeat(columns - 1)}:-:\n${'|\n'.repeat(rows)}`;
const tablesIn = (out: string) => out.split('<table>').length - 1;

test('tables: many tables at the cap share one budget, so the output stays small and fast', () => {
  const source = Array.from({ length: 72 }, () => centered(64, 500)).join('\nbreak\n');
  assert.ok(source.length < 110_000);
  const started = performance.now();
  const out = render(source);
  const took = performance.now() - started;
  assert.ok(out.length < 3_000_000, `output was ${out.length} characters`);
  assert.ok(took < 500, `took ${took} ms`);
});

test('tables: a quote of tables shares the same budget', () => {
  const source = Array.from({ length: 72 }, () => centered(64, 500))
    .join('\nbreak\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const out = render(source);
  assert.ok(out.length < 3_000_000, `output was ${out.length} characters`);
  assert.ok(tablesIn(out) >= 1);
  // tables inside and outside a quote draw on one budget
  const mixed = render(
    `${centered(64, 500)}\nbreak\n> ${centered(64, 500).split('\n').join('\n> ')}`,
  );
  assert.equal(tablesIn(mixed), 1);
});

test('tables: the first tables within the budget stay tables, later ones are the text they were', () => {
  const small = '| a | b |\n|---|---|\n| 1 | 2 |';
  const source = Array.from({ length: 100 }, () => centered(64, 500)).join('\nbreak\n');
  const out = render(`${small}\n\nx\n\n${source}\n\n${small}`);
  assert.ok(out.startsWith('<div class="ou-table">'));
  const count = tablesIn(out);
  assert.ok(count >= 2 && count < 10, `${count} tables`);
  assert.ok(out.includes('<p>break a|a|a|'), 'later tables are text');
});

test('tables: two separate renders each get a full budget', () => {
  const markdown = createMarkdown();
  const source = `${centered(64, 500)}\nbreak\n${centered(64, 500)}`;
  const first = String(markdown.markdown(source));
  const second = String(markdown.markdown(source));
  assert.equal(tablesIn(first), 1);
  assert.equal(second, first);
});

test('tables: a block with more than 500 body rows is text, not a 500-row table', () => {
  const out = render(`| a |\n|---|\n${'|---|\n'.repeat(501)}`);
  assert.ok(!out.includes('<table'), 'not a table');
  assert.ok(out.startsWith('<p>| a |'));
  assert.ok(render(`| a |\n|---|\n${'|---|\n'.repeat(500)}`).includes('<table'));
});

test('tables: an over-budget table still escapes its cells', () => {
  const evil = '<script>alert(1)</script>';
  const over = centered(64, 500)
    .replace('a|', `${evil}|`)
    .replace('\n|', `\n<img src=x onerror=alert(1)>|`);
  const out = render(`${centered(64, 500)}\nbreak\n${over}`);
  assert.equal(tablesIn(out), 1, 'the second table is over the budget');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
