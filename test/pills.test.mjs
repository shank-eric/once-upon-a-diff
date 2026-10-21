import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePills, pillMarker } from '../src/js/shared/overlay.js';

test('a file\'s status pill goes on its last mention in the chapter, and its first says "more below"', () => {
  // the shape of a chapter that names its task file in bullet 2, twice more in sub-bullets, and in its closing file list
  const marks = ['plugins/index.js', 'tasks/login.js', 'tasks/login.js', 'tasks/login.js', 'cli/index.ts', 'plugins/index.js', 'tasks/login.js', 'cli/index.ts'];
  const html = marks.map((rel, i) => `<code>${rel}</code>${pillMarker(i)}`).join(' ');
  const out = placePills(html, marks, (rel, earlier) => `[${earlier ? 'more' : 'pill'} ${rel}]`);
  assert.equal(out, [
    '<code>plugins/index.js</code>[more plugins/index.js]',
    '<code>tasks/login.js</code>[more tasks/login.js]',
    '<code>tasks/login.js</code>',
    '<code>tasks/login.js</code>',
    '<code>cli/index.ts</code>[more cli/index.ts]',
    '<code>plugins/index.js</code>[pill plugins/index.js]',
    '<code>tasks/login.js</code>[pill tasks/login.js]',
    '<code>cli/index.ts</code>[pill cli/index.ts]',
  ].join(' '));
  assert.equal(placePills(`<code>a.js</code>${pillMarker(0)}`, ['a.js'], (rel, earlier) => (earlier ? 'more' : 'pill')), '<code>a.js</code>pill', 'one mention gets the pill');
});
