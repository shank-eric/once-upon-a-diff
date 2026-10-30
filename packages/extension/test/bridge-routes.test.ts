import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { matchRoute } from '@once-upon-a-diff/protocol/client';
import { EXTENSION_ROUTES } from '../src/bridge-routes.ts';

// the extension's own code, and the panel it bundles (whose bridge-options.ts names the routes the panel calls)
const SOURCES = [
  path.join(import.meta.dirname, '../src'),
  path.join(import.meta.dirname, '../../panel/src'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** The route names the extension's code writes as ROUTES.<name>, outside comments. */
function namedRoutes(): Set<string> {
  const names = new Set<string>();
  for (const file of SOURCES.flatMap(sourceFiles)) {
    if (file.endsWith('bridge-routes.ts')) {
      continue;
    }
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const [, name] of code.matchAll(/\bROUTES\.([A-Za-z]+)/g)) {
      names.add(name);
    }
  }
  return names;
}

test('the service worker forwards the routes the extension calls: each one named in its code, and no others', () => {
  const named = namedRoutes();
  assert.ok(named.size > 20, 'the scan found the extension’s calls');
  const listed = new Set(
    Object.entries(ROUTES)
      .filter(([, route]) => (EXTENSION_ROUTES as readonly unknown[]).includes(route))
      .map(([name]) => name),
  );
  assert.equal(listed.size, EXTENSION_ROUTES.length, 'every listed route is in the table, once');
  assert.deepEqual([...listed].sort(), [...named].sort());
});

test('the worker refuses a table route the extension never calls, and a path that is not one', () => {
  assert.ok(matchRoute('GET', '/api/health', EXTENSION_ROUTES));
  assert.ok(matchRoute('POST', '/api/stories/acme-widgets-7/questions', EXTENSION_ROUTES));
  assert.ok(!matchRoute('POST', '/api/stories/acme-widgets-7/approve', EXTENSION_ROUTES));
  assert.ok(!matchRoute('POST', '/api/stories/acme-widgets-7/pr', EXTENSION_ROUTES));
  assert.ok(!matchRoute('POST', '/api/board/worktree/clean', EXTENSION_ROUTES));
  assert.ok(!matchRoute('POST', '/api/board/voice/pause', EXTENSION_ROUTES));
  assert.ok(!matchRoute('GET', '/api/stories/%2e%2e/status', EXTENSION_ROUTES));
});
