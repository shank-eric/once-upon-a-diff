import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, given, resolveLongText } from '../src/options.ts';

test('given: a value is its text; empty, missing and a bare flag are null', () => {
  assert.equal(given('x'), 'x');
  assert.equal(given(5), '5');
  assert.equal(given(''), null);
  assert.equal(given(undefined), null);
  assert.equal(given(true), null);
});

test('bodyText: the file first, `-` is stdin, then --body, else null', () => {
  const reads: (string | 0)[] = [];
  const read = (file: string | 0) => {
    reads.push(file);
    return `from ${file}`;
  };
  assert.equal(bodyText({ 'body-file': 'a.md', body: 'text' }, read), 'from a.md');
  assert.equal(bodyText({ 'body-file': '-' }, read), 'from 0');
  assert.deepEqual(reads, ['a.md', 0]);
  assert.equal(bodyText({ body: 'text' }, read), 'text');
  assert.equal(bodyText({ 'body-file': true, body: 'text' }, read), 'text');
  assert.equal(bodyText({ body: true }, read), null);
  assert.equal(bodyText({}, read), null);
  assert.equal(reads.length, 2);
});

test('resolveLongText: --<flag>-file and --<flag> - fill the flag, inline values stay, mistakes are named', () => {
  const reads: (string | 0)[] = [];
  const read = (file: string | 0) => {
    reads.push(file);
    if (file === 'gone.md') {
      throw new Error('ENOENT');
    }
    return `from ${file}\n`;
  };
  assert.deepEqual(resolveLongText({ note: 'short', repo: 'a/b' }, read), {
    note: 'short',
    repo: 'a/b',
  });
  assert.deepEqual(resolveLongText({ 'note-file': 'n.md', repo: 'a/b' }, read), {
    note: 'from n.md',
    repo: 'a/b',
  });
  assert.deepEqual(resolveLongText({ outcome: '-', 'task-file': 't.md' }, read), {
    outcome: 'from 0',
    task: 'from t.md',
  });
  // an empty file is an empty value (a backlog note it clears)
  assert.equal(resolveLongText({ 'title-file': 'e' }, () => '').title, '');
  assert.deepEqual(reads, ['n.md', 0, 't.md']);
  assert.throws(() => resolveLongText({ note: 'x', 'note-file': 'n.md' }, read), /not both/);
  assert.throws(() => resolveLongText({ 'note-file': true }, read), /needs a path/);
  assert.throws(
    () => resolveLongText({ note: '-', outcome: '-' }, read),
    /stdin can feed one flag/,
  );
  assert.throws(
    () => resolveLongText({ 'text-file': 'gone.md' }, read),
    /cannot read gone.md for --text/,
  );
});

test('resolveLongText: CRLF reads as LF, and empty stdin is refused while an empty file clears', () => {
  const crlf = resolveLongText({ 'note-file': 'n' }, () => 'one\r\ntwo\r\n');
  assert.equal(crlf.note, 'one\ntwo');
  assert.throws(() => resolveLongText({ note: '-' }, () => ''), /stdin for --note was empty/);
  assert.throws(
    () => resolveLongText({ outcome: '-' }, () => ' \n'),
    /stdin for --outcome was empty/,
  );
  assert.equal(resolveLongText({ 'note-file': 'e' }, () => '').note, '');
});
