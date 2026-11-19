import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOptionalOid, isStoredLapseChange } from '../src/review-record.ts';

const change = { kind: 'edited', sha: 'abc', subject: 'fix it' };

test('isStoredLapseChange: a known kind with a sha and a subject passes, an extra field too', () => {
  assert.equal(isStoredLapseChange(change), true);
  assert.equal(isStoredLapseChange({ ...change, kind: 'reordered', was: 'def' }), true);
});

test('isStoredLapseChange: a non-object, an unknown kind or a missing part does not', () => {
  assert.equal(isStoredLapseChange(null), false);
  assert.equal(isStoredLapseChange('edited'), false);
  assert.equal(isStoredLapseChange({ ...change, kind: 'renamed' }), false);
  assert.equal(isStoredLapseChange({ ...change, sha: 7 }), false);
  assert.equal(isStoredLapseChange({ kind: 'added', sha: 'abc' }), false);
});

test('isOptionalOid: a string, null or nothing is, anything else is not', () => {
  assert.equal(isOptionalOid('abc'), true);
  assert.equal(isOptionalOid(null), true);
  assert.equal(isOptionalOid(undefined), true);
  assert.equal(isOptionalOid(7), false);
  assert.equal(isOptionalOid({}), false);
});
