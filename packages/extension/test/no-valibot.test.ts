import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * The extension's bundle must not carry Valibot: the route table and the client are all it takes from the protocol
 * package, and the request schemas are the bridge's. This walks the files the extension's entrypoints load (their
 * runtime imports, so `import type` is skipped, since it is erased) and fails if one reaches valibot or schemas.ts.
 */
const ROOT = path.join(import.meta.dirname, '../../..');
const ENTRYPOINTS = ['background.ts', 'content.ts', 'options/main.ts'].map((file) =>
  path.join(ROOT, 'packages/extension/src/entrypoints', file),
);

const IMPORT_RE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolve(from: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(from), specifier);
  }
  const workspace = /^@once-upon-a-diff\/([a-z]+)\/(.+)$/.exec(specifier);
  return workspace ? path.join(ROOT, 'packages', workspace[1], 'src', `${workspace[2]}.ts`) : null;
}

test('no file the extension loads at run time imports valibot or the request schemas', () => {
  const seen = new Set<string>();
  const queue = [...ENTRYPOINTS];
  const bad: string[] = [];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, typeOnly, specifier] of code.matchAll(IMPORT_RE)) {
      if (typeOnly) {
        continue;
      }
      if (specifier === 'valibot' || /(^|\/)schemas(\.ts)?$/.test(specifier)) {
        bad.push(`${path.relative(ROOT, file)} imports ${specifier}`);
        continue;
      }
      const next = resolve(file, specifier);
      if (next && existsSync(next)) {
        queue.push(next);
      }
    }
  }
  assert.ok(seen.size > 15, `the walk reached the extension's code (${seen.size} files)`);
  assert.deepEqual(bad, []);
});
