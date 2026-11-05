import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, count, optional, TEXT_MAX } from '../src/services/input.ts';

test('clean: control characters become spaces, the text is trimmed, a long one is refused', () => {
  assert.equal(clean('  a\tb\nc\u007fd  ', 'the name'), 'a b c d');
  assert.equal(clean(undefined, 'the name'), '');
  assert.equal(clean(null, 'the name'), '');
  assert.equal(clean(42, 'the name'), '42');
  assert.equal(clean('x'.repeat(TEXT_MAX), 'the task'), 'x'.repeat(TEXT_MAX));
  assert.throws(() => clean('x'.repeat(TEXT_MAX + 1), 'the task'), {
    message: `the task is longer than ${TEXT_MAX} characters`,
  });
  assert.throws(() => clean('abcdef', 'the name', 5), {
    message: 'the name is longer than 5 characters',
  });
});

test('clean: multiline keeps newlines and still clears other control characters', () => {
  assert.equal(clean('a\nb\tc\u0000d', 'the note', 100, true), 'a\nb c d');
  assert.equal(clean('a\nb', 'the note', 100), 'a b');
});

test('optional: empty is null, a match is the trimmed text, a miss is refused with at most 60 characters shown', () => {
  assert.equal(optional('', 'the sid', /^[0-9a-f]{8}$/), null);
  assert.equal(optional('   ', 'the sid', /^[0-9a-f]{8}$/), null);
  assert.equal(optional(undefined, 'the sid', /^[0-9a-f]{8}$/), null);
  assert.equal(optional(' deadbeef ', 'the sid', /^[0-9a-f]{8}$/), 'deadbeef');
  assert.throws(() => optional('nope', 'the sid', /^[0-9a-f]{8}$/), {
    message: 'the sid "nope" is not valid',
  });
  assert.throws(() => optional('z'.repeat(80), 'the sid', /^[0-9a-f]{8}$/), {
    message: `the sid "${'z'.repeat(60)}" is not valid`,
  });
});

test('count: nothing given is null, a whole number in range passes, anything else is refused', () => {
  assert.equal(count(undefined, 'the slots'), null);
  assert.equal(count(null, 'the slots'), null);
  assert.equal(count('', 'the slots'), null);
  assert.equal(count('7', 'the slots'), 7);
  assert.equal(count(0, 'the slots'), 0);
  assert.equal(count(99, 'the slots', 99), 99);
  for (const bad of [-1, 1.5, 'x', 100, NaN]) {
    assert.throws(() => count(bad, 'the slots', 99), {
      message: 'the slots must be a whole number',
    });
  }
});
