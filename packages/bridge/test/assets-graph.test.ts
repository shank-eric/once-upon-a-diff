/*
 * Every module the pages load resolves: starting from the two page scripts, each import in each served module (a /assets/
 * URL, or a relative one) is a file the bridge serves, and no served module is left naming a package the browser can't load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assetFor, forBrowser } from '../src/server/assets.ts';
import { startBridge, tmp } from './helpers.ts';

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g;

function served(url: string): string {
  const found = assetFor(url);
  assert.ok(found, `${url} is served`);
  return String(found[0]);
}

test('every import in the page scripts and the panel resolves to a served asset, none by package name', () => {
  const seen = new Set<string>();
  const queue = ['/assets/local/local.ts', '/assets/board.ts'];
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
  assert.ok(seen.has('/assets/panel/shell/overlay.ts'), 'the panel is in the graph');
  assert.ok(seen.has('/assets/panel/host/bridge-options.ts'), 'its bridge calls are in the graph');
  assert.ok(seen.has('/assets/host-github/diff-dom.ts'), 'the host adapter is in the graph');
  assert.ok(seen.has('/assets/protocol/routes.ts'), 'the route table is in the graph');
  assert.ok(seen.has('/assets/protocol/route-kit.ts'), 'the route factories are in the graph');
  assert.ok(seen.has('/assets/protocol/story/routes.ts'), 'the story routes are in the graph');
  assert.ok(seen.has('/assets/protocol/board/routes.ts'), 'the board routes are in the graph');
  assert.ok(seen.has('/assets/domain/html.ts'), 'the domain is in the graph');
  assert.ok(seen.has('/assets/api-client/client.ts'), 'the typed client is in the graph');
  assert.ok(seen.has('/assets/api-client/use-poll.ts'), 'the board’s poll hook is in the graph');
  assert.ok(seen.has('/assets/api-client/poll.ts'), 'and the poll under it');
  assert.ok(seen.has('/assets/ui-kit/dom.ts'), 'the shared DOM helpers are in the graph');
  assert.ok(seen.has('/assets/ui-kit/clipboard.ts'), 'the clipboard helper is in the graph');
  assert.ok(
    seen.has('/assets/ui-kit/listen.ts'),
    'the board’s Start listening plan is in the graph',
  );
  assert.ok(
    seen.has('/assets/ui-kit/components/meter.ts'),
    'the components folder is in the graph',
  );
  assert.ok(seen.has('/assets/domain/time.ts'), 'the time text the board shows is in the domain');
});

test('forBrowser spells the panel, the protocol, the domain, the api-client, ui-kit and the host adapter as the URLs they are served at', () => {
  assert.equal(
    forBrowser(
      [
        `import { html } from '@once-upon-a-diff/domain/html';`,
        `export { x } from "@once-upon-a-diff/panel/host/diff-types";`,
        `const m = await import('@once-upon-a-diff/protocol/routes');`,
        `import { createHostPage } from '@once-upon-a-diff/host-github/diff-dom';`,
        `import { createClient } from '@once-upon-a-diff/api-client/client';`,
        `import { writeClipboard } from '@once-upon-a-diff/ui-kit/clipboard';`,
        `import './sibling.ts';`,
      ].join('\n'),
    ),
    [
      `import { html } from '/assets/domain/html.ts';`,
      `export { x } from "/assets/panel/host/diff-types.ts";`,
      `const m = await import('/assets/protocol/routes.ts');`,
      `import { createHostPage } from '/assets/host-github/diff-dom.ts';`,
      `import { createClient } from '/assets/api-client/client.ts';`,
      `import { writeClipboard } from '/assets/ui-kit/clipboard.ts';`,
      `import './sibling.ts';`,
    ].join('\n'),
  );
});

test("the bridge serves ui-kit's stylesheet, and the board and local pages link it before local.css so the pages' own rules win", async () => {
  const found = assetFor('/assets/ui-kit/css/ui.css');
  assert.ok(found, 'ui.css is served');
  assert.match(found[1], /text\/css/);
  assert.match(String(found[0]), /\.ou-ui-chip \{/);
  const { boardPage, localPage } = await import('../src/server/pages.ts');
  for (const page of [String(boardPage()), String(localPage('s', { title: 't' }))]) {
    const first = page.indexOf('/assets/ui-kit/css/ui.css');
    assert.ok(first > 0 && first < page.indexOf('/assets/local/local.css'), 'ui.css comes first');
  }
});

test('the old /assets/ui/ URLs are gone, and the moved time and markdown modules are not in ui-kit', () => {
  for (const old of ['/assets/ui/dom.ts', '/assets/ui/ui.css', '/assets/ui/time.ts']) {
    assert.equal(assetFor(old), null, old);
  }
  for (const gone of [
    '/assets/ui-kit/time.ts',
    '/assets/ui-kit/markdown.ts',
    '/assets/ui-kit/ui.css',
    '/assets/ui-kit/meter.ts',
  ]) {
    assert.throws(() => assetFor(gone), /no such module/, gone);
  }
});

test('every asset the local page and the board page load, and every module under them, is fetched from a running bridge with a 200', async () => {
  const { boardPage, localPage } = await import('../src/server/pages.ts');
  const bridge = await startBridge({ home: tmp('home') });
  try {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const page of [String(localPage('s', { title: 't' })), String(boardPage())]) {
      for (const [, url] of page.matchAll(/\b(?:href|src)="(\/assets\/[^"]+)"/g)) {
        queue.push(url);
      }
    }
    assert.ok(queue.includes('/assets/local/local.ts'), 'the local page loads its entry script');
    assert.ok(queue.includes('/assets/local/local.css'), 'and its stylesheet');
    while (queue.length) {
      const url = queue.pop() as string;
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      const response = await fetch(`${bridge.base}${url}`);
      assert.equal(response.status, 200, url);
      const body = await response.text();
      if (url.endsWith('.ts')) {
        for (const [, , specifier] of body.matchAll(IMPORT)) {
          if (specifier.startsWith('/') || specifier.startsWith('.')) {
            queue.push(new URL(specifier, `http://x${url}`).pathname);
          }
        }
      }
    }
    for (const url of [
      '/assets/local/diff/diff-view.ts',
      '/assets/local/diff/split.ts',
      '/assets/local/diff/narrow.ts',
      '/assets/local/diff/syntax.ts',
      '/assets/local/ship/push.ts',
      '/assets/local/ship/pull-request.ts',
      '/assets/local/ship/approve.ts',
      '/assets/local/page.ts',
    ]) {
      assert.ok(seen.has(url), `${url} is in the local page's graph`);
    }
  } finally {
    await bridge.close();
  }
});

test('a running bridge serves every file of the ui-kit package at /assets/ui-kit/, components and css included', async () => {
  const src = fileURLToPath(new URL('../../ui-kit/src/', import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) =>
    /\.(ts|css)$/.test(name),
  );
  assert.ok(files.includes('components/busy.ts') && files.includes('css/ui.css'));
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const name of files) {
      const response = await fetch(`${bridge.base}/assets/ui-kit/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(
        response.headers.get('content-type') ?? '',
        name.endsWith('.css') ? /text\/css/ : /javascript/,
      );
    }
    assert.equal((await fetch(`${bridge.base}/assets/ui/dom.ts`)).status, 404);
  } finally {
    await bridge.close();
  }
});
