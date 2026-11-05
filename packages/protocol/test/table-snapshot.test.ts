import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, type AnyRoute } from '../src/routes.ts';
import { BODIES } from '../src/schemas.ts';
import { snapshotOf } from './table-snapshot-lib.ts';

/** The tables as they were when types, routes and schemas were one file each, taken from main (fixtures/main-tables.json). */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/main-tables.json', import.meta.url), 'utf8'),
) as ReturnType<typeof snapshotOf>;
const NOW = snapshotOf(ROUTES as Record<string, AnyRoute>, BODIES);

test('the route table lists the same routes in the same order as before the split', () => {
  assert.deepEqual(
    NOW.routes.map((route) => route[0]),
    FIXTURE.routes.map((route) => route[0]),
  );
  assert.deepEqual(NOW.routes, FIXTURE.routes);
});

test('the body schemas are the same, in the same order, as before the split', () => {
  assert.deepEqual(
    NOW.bodies.map((body) => body[0]),
    FIXTURE.bodies.map((body) => body[0]),
  );
  for (const [index, [name, schema]] of FIXTURE.bodies.entries()) {
    assert.deepEqual(NOW.bodies[index][1], schema, `the ${name} schema`);
  }
});

test('no file in the protocol is over 400 lines', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    );
  for (const file of walk(SRC)) {
    const name = path.relative(SRC, file);
    const lines = readFileSync(file, 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${name} is ${lines} lines`);
  }
});
