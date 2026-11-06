import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
/** The modules a file loads when it runs: `import type` and `export type` are erased, so they don't count. */
const importsOf = (code: string): string[] =>
  [
    ...code.matchAll(/(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
  ].map((hit) => hit[1]);

/** The domain's own files: it is flat, so every module in src/. */
test('the domain imports nothing: no module, no package, no relative path', () => {
  const domain = files(SRC);
  assert.ok(domain.length > 0);
  for (const file of domain) {
    const code = readFileSync(file, 'utf8');
    assert.deepEqual(importsOf(code), [], `${file} imports at runtime`);
    assert.ok(
      !/^\s*(import|export)\b[^;]*\bfrom\s+['"]/m.test(code),
      `${file} has an import or a re-export`,
    );
  }
});

test('nothing in the domain reaches for the DOM or Node', () => {
  for (const file of files(SRC)) {
    const code = readFileSync(file, 'utf8');
    assert.ok(!/\b(document|window|localStorage|chrome|process|Buffer|require)\./.test(code), file);
    assert.ok(!/\bfetch\(|\bnode:/.test(code), file);
  }
});
