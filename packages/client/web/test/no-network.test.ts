import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('the local page loads nothing from the network, no CDN', () => {
  const dir = new URL('../public/local/', import.meta.url);
  const sources = (readdirSync(dir, { recursive: true }) as string[]).filter((name) =>
    name.endsWith('.ts'),
  );
  assert.ok(sources.includes('local.ts') && sources.includes('app.ts'));
  for (const name of sources) {
    assert.ok(
      !/https?:\/\//.test(readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '')),
      `${name} loads nothing from the network`,
    );
  }
});
