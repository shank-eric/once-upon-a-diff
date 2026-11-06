import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
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

/** The files that may import valibot: the schema index, the readers they share, each area's schemas and the files' strict checks. */
const isSchemaFile = (name: string): boolean =>
  /^(schemas|schema-kit|[a-z-]+\/schemas|files\/strict)\.ts$/.test(name);

test('the contracts package imports only itself, the domain and valibot, and only the schema files import valibot', () => {
  for (const file of files(SRC)) {
    const name = path.relative(SRC, file);
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        assert.ok(specifier.endsWith('.ts'), `${name}: ${specifier} names its file`);
        continue;
      }
      if (specifier.startsWith('@once-upon-a-diff/domain/')) {
        continue;
      }
      assert.equal(specifier, 'valibot', `${name} imports ${specifier}`);
      assert.ok(isSchemaFile(name), `${name} imports valibot`);
    }
  }
});

test('what a page loads has no runtime import of valibot or of the schemas', () => {
  for (const file of files(SRC)) {
    const name = path.relative(SRC, file);
    if (isSchemaFile(name)) {
      continue;
    }
    const code = stripTypeScriptTypes(readFileSync(file, 'utf8'));
    for (const specifier of importsOf(code)) {
      if (specifier.startsWith('@once-upon-a-diff/domain/')) {
        continue;
      }
      const target = path.relative(SRC, path.resolve(path.dirname(file), specifier));
      assert.ok(
        specifier.startsWith('.') && !isSchemaFile(target),
        `${name} imports ${specifier} at runtime`,
      );
    }
  }
});

test('nothing in the contracts package reaches for the DOM or Node', () => {
  for (const file of files(SRC)) {
    const code = stripTypeScriptTypes(readFileSync(file, 'utf8'));
    assert.ok(!/\b(document|window|localStorage|chrome|process|Buffer|require)\./.test(code), file);
    assert.ok(!/\bfetch\(|\bnode:/.test(code), file);
  }
});
