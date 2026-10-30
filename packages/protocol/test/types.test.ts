import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the wire types are types only: nothing in types.ts runs', () => {
  const source = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  assert.ok(!/^export (const|function|class|enum|let|var)\b/m.test(source));
  assert.ok(!/^import\b(?! type)/m.test(source), 'no runtime import');
});
