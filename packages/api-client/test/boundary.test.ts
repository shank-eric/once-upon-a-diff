import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('what a page loads from the api-client imports only the route table, the protocol’s error codes and its own files, and only the hook imports the vendored Preact', () => {
  const names = readdirSync(SRC);
  assert.ok(names.length > 0);
  for (const name of names) {
    const code = stripTypeScriptTypes(readFileSync(`${SRC}${name}`, 'utf8'));
    const loads = [
      ...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((hit) => hit[1]);
    for (const specifier of loads) {
      assert.ok(
        specifier === '@once-upon-a-diff/protocol/routes' ||
          specifier === '@once-upon-a-diff/protocol/domain/error-code' ||
          (specifier === '/assets/preact.mjs' && name === 'use-poll.ts') ||
          /^\.\/[a-z-]+\.ts$/.test(specifier),
        `${name} imports ${specifier} at runtime`,
      );
    }
  }
});
