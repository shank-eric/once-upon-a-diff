import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { langOf, splitHtmlLines, hunkHtml, highlightFile, LIMITS } from '../public/syntax.ts';
import hljs from '../public/vendor/highlight.mjs';
import { startBridge, tmp } from './helpers.mjs';

const strip = (html) => html.replace(/<[^>]+>/g, '');
const balanced = (html) =>
  (html.match(/<span /g) || []).length === (html.match(/<\/span>/g) || []).length;

test('picks the language by extension or file name', () => {
  assert.equal(langOf('libs/x/component.tsx'), 'typescript');
  assert.equal(langOf('a/b.mjs'), 'javascript');
  assert.equal(langOf('config/settings.yml'), 'yaml');
  assert.equal(langOf('Gemfile'), 'ruby');
  assert.equal(langOf('app/x.html.erb'), 'erb');
  assert.equal(langOf('styles/a.SCSS'), 'scss');
  assert.equal(langOf('README'), null);
  assert.equal(langOf('.env'), null);
  for (const line of [
    'typescript',
    'javascript',
    'json',
    'ruby',
    'yaml',
    'css',
    'scss',
    'markdown',
    'bash',
    'xml',
    'erb',
  ]) {
    assert.ok(hljs.getLanguage(line), `${line} is vendored`);
  }
});

test('cuts highlighted HTML into lines with balanced spans, reopening a token that runs on', () => {
  const lines = splitHtmlLines('<span class="a">x\n<span class="b">y\nz</span></span> w');
  assert.deepEqual(lines, [
    '<span class="a">x</span>',
    '<span class="a"><span class="b">y</span></span>',
    '<span class="a"><span class="b">z</span></span> w',
  ]);
});

test('a multi-line template string stays a string on every line, on both sides of a hunk', () => {
  const hunk = {
    oldStart: 1,
    newStart: 1,
    lines: [' const a = `one', '-two', '+TWO', ' three`;', '\\ No newline at end of file'],
  };
  const out = hunkHtml(
    hunk,
    (code) => hljs.highlight(code, { language: 'typescript', ignoreIllegals: true }).value,
  );
  assert.equal(out.length, 5);
  assert.equal(out[4], null, 'the no-newline marker is left alone');
  for (const i of [1, 2, 3]) {
    assert.match(out[i], /^<span class="hljs-string">/, `line ${i} is inside the string`);
    assert.ok(balanced(out[i]));
  }
  assert.equal(strip(out[1]), 'two');
  assert.equal(strip(out[2]), 'TWO');
  assert.match(out[0], /hljs-keyword">const</);
});

test('escapes code, and leaves big files, minified lines and unknown languages plain', () => {
  const out = highlightFile({ rel: 'a.ts', hunks: [{ lines: ['+const x = "<b>&";'] }] }, hljs);
  assert.ok(!out[0][0].includes('<b>'));
  assert.ok(out[0][0].includes('&lt;b&gt;&amp;'));
  assert.equal(highlightFile({ rel: 'a.txt', hunks: [{ lines: ['+x'] }] }, hljs), null);
  assert.equal(
    highlightFile({ rel: 'a.ts', hunks: [{ lines: ['+x'] }] }, null),
    null,
    'no highlight.js, plain',
  );
  assert.equal(
    highlightFile(
      { rel: 'a.js', hunks: [{ lines: ['+' + 'x'.repeat(LIMITS.lineLength + 1)] }] },
      hljs,
    ),
    null,
  );
  assert.equal(
    highlightFile(
      { rel: 'a.js', hunks: [{ lines: Array(LIMITS.fileLines + 1).fill('+x;') }] },
      hljs,
    ),
    null,
  );
});

test('the bridge serves highlight.js and the highlighter, with no CDN in the page', async () => {
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const path of ['/assets/highlight.mjs', '/assets/syntax.ts']) {
      const response = await bridge.call('GET', path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
    }
    const local = readFileSync(new URL('../public/local.ts', import.meta.url), 'utf8');
    assert.ok(
      !/https?:\/\//.test(local.replace(/\/\/.*$/gm, '')),
      'local.js loads nothing from the network',
    );
  } finally {
    await bridge.close();
  }
});
