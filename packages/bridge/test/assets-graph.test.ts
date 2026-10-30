/*
 * Every module the pages load resolves: starting from the two page scripts, each import in each served module (a /assets/
 * URL, or a relative one) is a file the bridge serves, and no served module is left naming a package the browser can't load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetFor, forBrowser } from '../src/server/assets.ts';

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g;

function served(url: string): string {
  const found = assetFor(url);
  assert.ok(found, `${url} is served`);
  return String(found[0]);
}

test('every import in the page scripts and the panel resolves to a served asset, none by package name', () => {
  const seen = new Set<string>();
  const queue = ['/assets/local.ts', '/assets/board.ts'];
  while (queue.length) {
    const url = queue.pop() as string;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    if (!url.endsWith('.ts')) {
      continue;
    }
    for (const [, , specifier] of served(url).matchAll(IMPORT)) {
      assert.ok(
        !specifier.startsWith('@once-upon-a-diff/'),
        `${url} imports ${specifier} by package name`,
      );
      if (specifier.startsWith('/') || specifier.startsWith('.')) {
        queue.push(new URL(specifier, `http://x${url}`).pathname);
      }
    }
  }
  assert.ok(seen.has('/assets/panel/overlay.ts'), 'the panel is in the graph');
  assert.ok(seen.has('/assets/panel/bridge-options.ts'), 'its bridge calls are in the graph');
  assert.ok(seen.has('/assets/host/diff-dom.ts'), 'the host adapter is in the graph');
  assert.ok(seen.has('/assets/protocol/routes.ts'), 'the route table is in the graph');
  assert.ok(seen.has('/assets/util/html.ts'), 'the shared helpers are in the graph');
});

test('forBrowser spells the shared helpers and the protocol as the URLs they are served at', () => {
  assert.equal(
    forBrowser(
      [
        `import { html } from '@once-upon-a-diff/shared/util/html';`,
        `export { x } from "@once-upon-a-diff/shared/util/diff-types";`,
        `const m = await import('@once-upon-a-diff/protocol/routes');`,
        `import './sibling.ts';`,
      ].join('\n'),
    ),
    [
      `import { html } from '/assets/util/html.ts';`,
      `export { x } from "/assets/util/diff-types.ts";`,
      `const m = await import('/assets/protocol/routes.ts');`,
      `import './sibling.ts';`,
    ].join('\n'),
  );
});
