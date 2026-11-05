import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
/** The type files: the index (types.ts) and each area's (types.ts, and board's agent-types.ts and card-types.ts). */
const typeFiles = [
  'types.ts',
  ...readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'domain')
    .flatMap((entry) =>
      readdirSync(path.join(SRC, entry.name))
        .filter((name) => /(^|-)types\.ts$/.test(name))
        .map((name) => `${entry.name}/${name}`),
    ),
];

test('the wire types are types only: nothing in a types file runs', () => {
  assert.ok(typeFiles.length >= 9, typeFiles.join());
  for (const name of typeFiles) {
    const source = readFileSync(path.join(SRC, name), 'utf8');
    assert.ok(!/^export (const|function|class|enum|let|var)\b/m.test(source), name);
    assert.ok(!/^import\b(?! type)/m.test(source), `${name}: no runtime import`);
    assert.ok(!/^export\b(?! type)[^\n]*\bfrom\b/m.test(source), `${name}: no runtime re-export`);
  }
});
