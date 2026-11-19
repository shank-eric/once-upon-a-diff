import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed } from '../src/request.ts';

const extensions = new Set(['chrome-extension://abc']);
const allowed = (origin: string, host: string | null = null) =>
  originAllowed(origin, 4823, extensions, host);

test('originAllowed: the extension and the bridge own page on its port pass', () => {
  assert.equal(allowed('chrome-extension://abc'), true);
  assert.equal(allowed('http://127.0.0.1:4823'), true);
  assert.equal(allowed('http://localhost:4823'), true);
});

test('originAllowed: another extension, another port or a foreign site does not', () => {
  assert.equal(allowed('chrome-extension://other'), false);
  assert.equal(allowed('http://127.0.0.1:9999'), false);
  assert.equal(allowed('https://example.com'), false);
});

test('originAllowed: the allowed host passes on http and https, and only when one is set', () => {
  assert.equal(allowed('https://board.example', 'board.example'), true);
  assert.equal(allowed('http://board.example', 'board.example'), true);
  assert.equal(allowed('https://board.example', null), false);
  assert.equal(allowed('https://evil.example', 'board.example'), false);
});
