import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  langOf,
  langOfShebang,
  splitHtmlLines,
  hunkHtml,
  highlightFile,
  LIMITS,
} from '../public/syntax.ts';
import hljs from '../public/vendor/highlight.mjs';

const strip = (html: string) => html.replace(/<[^>]+>/g, '');
const balanced = (html: string) =>
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

test('Python and the rest of the common set by extension or name, and a script with no extension by its #! line', () => {
  assert.equal(langOf('tools/report.py'), 'python');
  assert.equal(langOf('db/query.sql'), 'sql');
  assert.equal(langOf('Dockerfile'), 'dockerfile');
  assert.equal(langOf('Makefile'), 'makefile');
  assert.equal(langOf('pyproject.toml'), 'ini');
  for (const lang of [
    'python',
    'sql',
    'go',
    'java',
    'rust',
    'dockerfile',
    'makefile',
    'ini',
    'diff',
  ]) {
    assert.ok(hljs.getLanguage(lang), `${lang} is vendored`);
  }
  assert.equal(langOfShebang('#!/usr/bin/env python3'), 'python');
  assert.equal(langOfShebang('#!/bin/bash'), 'bash');
  assert.equal(langOfShebang('#!/bin/sh -e'), 'bash');
  assert.equal(langOfShebang('#!/usr/bin/env ruby'), 'ruby');
  assert.equal(langOfShebang('#!/usr/bin/env -S node --no-warnings'), 'javascript');
  assert.equal(langOfShebang('#!/usr/bin/env awk'), null);
  assert.equal(langOfShebang('echo hi'), null);
  assert.equal(langOf('bin/setup', '#!/usr/bin/env ruby'), 'ruby');
  assert.equal(langOf('bin/notes.txt', '#!/usr/bin/env ruby'), null, 'an extension wins');
  // a new script: its first hunk starts at line 1, so its #! line picks the language
  const script = {
    rel: 'bin/sweep',
    hunks: [{ oldStart: 0, newStart: 1, lines: ['+#!/usr/bin/env python3', '+print("hi")'] }],
  };
  assert.ok(highlightFile(script, hljs)?.[0][1]?.includes('<span'), 'highlighted as Python');
  // a change further down shows no #! line: plain
  const deeper = {
    rel: 'bin/sweep',
    hunks: [{ oldStart: 40, newStart: 40, lines: [' print("hi")'] }],
  };
  assert.equal(highlightFile(deeper, hljs), null);
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
    // the lines with code (not the no-newline marker) have their HTML
    assert.match(out[i] as string, /^<span class="hljs-string">/, `line ${i} is inside the string`);
    assert.ok(balanced(out[i] as string));
  }
  assert.equal(strip(out[1] as string), 'two');
  assert.equal(strip(out[2] as string), 'TWO');
  assert.match(out[0] as string, /hljs-keyword">const</);
});

test('escapes code, and leaves big files, minified lines and unknown languages plain', () => {
  const out = highlightFile({ rel: 'a.ts', hunks: [{ lines: ['+const x = "<b>&";'] }] }, hljs);
  assert.ok(!out![0][0]!.includes('<b>'));
  assert.ok(out![0][0]!.includes('&lt;b&gt;&amp;'));
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
