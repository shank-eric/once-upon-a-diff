import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, given } from '../src/cli/options.ts';

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
