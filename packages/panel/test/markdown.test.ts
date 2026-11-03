import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown } from '../src/markdown.ts';
import type { PanelContext } from '../src/context.ts';

/** A file name git allows, chosen to look like attributes if it ever got out of its quotes. */
const EVIL = 'a onfocus=alert(1) autofocus tabindex=1 x.js';

/** The markdown renderer with just the refs it calls: the ref `evil` is EVIL's line 40. */
function render(source: string): string {
  const refs = {
    inScope: () => true,
    pill: () => '',
    refById: (id: string) =>
      id === 'evil' ? { id, path: EVIL, side: 'R', start: 40, end: 40 } : null,
    fileOf: (path: string) => path,
    lineOf: (ref: { side: string; start: number; end: number }) => ({
      side: ref.side,
      start: ref.start,
      end: ref.end,
    }),
  };
  const context = { story: { shaToPath: new Map<string, string>() }, refs };
  return String(createMarkdown(context as unknown as PanelContext).markdown(source));
}

/** Every attribute name on every tag, quoted values or not, the way an HTML parser would split them. */
function attributeNames(markup: string): string[] {
  const names: string[] = [];
  for (const tag of markup.matchAll(/<[a-z]+((?:\s+[^\s=>]+(?:=(?:"[^"]*"|[^\s>]*))?)*)\s*>/g)) {
    for (const attr of tag[1].matchAll(/\s+([^\s=>]+)(?:=(?:"[^"]*"|[^\s>]*))?/g)) {
      names.push(attr[1]);
    }
  }
  return names;
}

const SAFE_ATTRS = new Set([
  'href',
  'target',
  'rel',
  'data-rel',
  'role',
  'tabindex',
  'title',
  'data-side',
  'data-start',
  'data-end',
]);

test('a ref to a file named like attributes keeps its name inside its quotes (the onfocus= payload)', () => {
  const out = render('See [t](ref:evil) for more.');
  const unexpected = attributeNames(out).filter((name) => !SAFE_ATTRS.has(name));
  assert.deepEqual(unexpected, [], out);
  assert.doesNotMatch(out, /<a\b/);
  assert.ok(out.includes(`data-rel="${EVIL}"`), 'the file reference itself renders');
});

test('a code span inside a link URL cannot break out of the href, and a backticked name links nothing', () => {
  const out = render('See [t](https://x.test/`:40`) and `a.js:40` for more.');
  const unexpected = attributeNames(out).filter((name) => !SAFE_ATTRS.has(name));
  assert.deepEqual(unexpected, [], out);
  assert.doesNotMatch(out, /<a\b/, 'a URL with a code span in it is not made a link');
  assert.doesNotMatch(out, /data-rel/, 'text is not a link: only a ref id links');
  assert.match(out, /<code>a\.js:40<\/code>/);
});

test('a link to a ref the chapter does not have is just its words', () => {
  const out = render('See [the loader](ref:nope).');
  assert.equal(out, '<p>See the loader.</p>');
});

test('only http(s) and relative links become links; others stay text', () => {
  for (const source of [
    '[x](javascript:alert(1))',
    '[x](data:text/html,hi)',
    '[x](//evil.test/a)',
    '[x](https://e.test/a"onmouseover="alert(1))',
    "[x](https://e.test/a'b)",
  ]) {
    const out = render(source);
    assert.doesNotMatch(out, /<a\b/, source);
    assert.deepEqual(
      attributeNames(out).filter((name) => !SAFE_ATTRS.has(name)),
      [],
      source,
    );
  }
  assert.match(
    render('[docs](https://e.test/a?x=1&y=2)'),
    /<a href="https:\/\/e\.test\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">docs<\/a>/,
    'an http(s) link, its href escaped once',
  );
  assert.match(render('[pr](/acme/widgets/pull/7)'), /<a href="\/acme\/widgets\/pull\/7"/);
  assert.match(render('[top](#overview)'), /<a href="#overview"/);
});

test("emphasis doesn't reach into a URL, and still works in the link's text", () => {
  const out = render('[**see** `a.js` _here_](https://e.test/_next_/x_y_)');
  assert.match(out, /<a href="https:\/\/e\.test\/_next_\/x_y_"/);
  assert.match(out, /<strong>see<\/strong> <code>a\.js<\/code> <em>here<\/em><\/a>/);
});
