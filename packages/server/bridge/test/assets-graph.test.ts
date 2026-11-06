/*
 * Every module the pages load resolves: starting from the two page scripts, each import in each served module (a /assets/
 * URL, or a relative one) is a file the bridge serves, and no served module is left naming a package the browser can't load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assetFor, forBrowser } from '@once-upon-a-diff/server/assets';
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
  assert.ok(seen.has('/assets/github-page/diff-dom.ts'), 'the host adapter is in the graph');
  assert.ok(seen.has('/assets/contracts/routes.ts'), 'the route table is in the graph');
  assert.ok(seen.has('/assets/contracts/route-kit.ts'), 'the route factories are in the graph');
  assert.ok(seen.has('/assets/contracts/story/routes.ts'), 'the story routes are in the graph');
  assert.ok(seen.has('/assets/contracts/board/routes.ts'), 'the board routes are in the graph');
  assert.ok(seen.has('/assets/terms/html.ts'), 'the terms package is in the graph');
  assert.ok(seen.has('/assets/bridge-client/client.ts'), 'the typed client is in the graph');
  assert.ok(seen.has('/assets/bridge-client/use-poll.ts'), 'the board’s poll hook is in the graph');
  assert.ok(seen.has('/assets/bridge-client/poll.ts'), 'and the poll under it');
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
  assert.ok(
    seen.has('/assets/ui-kit/components/chip-class.ts'),
    'the chip’s class text, which chip.ts imports as a sibling, is in the graph',
  );
  assert.ok(
    seen.has('/assets/terms/time.ts'),
    'the time text the board shows is in the terms package',
  );
});

test('forBrowser spells the panel, the contracts package, the terms package, the bridge-client, ui-kit and the host adapter as the URLs they are served at', () => {
  assert.equal(
    forBrowser(
      [
        `import { html } from '@once-upon-a-diff/terms/html';`,
        `export { x } from "@once-upon-a-diff/panel/host/diff-types";`,
        `const m = await import('@once-upon-a-diff/contracts/routes');`,
        `import { createHostPage } from '@once-upon-a-diff/github-page/diff-dom';`,
        `import { createClient } from '@once-upon-a-diff/bridge-client/client';`,
        `import { writeClipboard } from '@once-upon-a-diff/ui-kit/clipboard';`,
        `import './sibling.ts';`,
      ].join('\n'),
    ),
    [
      `import { html } from '/assets/terms/html.ts';`,
      `export { x } from "/assets/panel/host/diff-types.ts";`,
      `const m = await import('/assets/contracts/routes.ts');`,
      `import { createHostPage } from '/assets/github-page/diff-dom.ts';`,
      `import { createClient } from '/assets/bridge-client/client.ts';`,
      `import { writeClipboard } from '/assets/ui-kit/clipboard.ts';`,
      `import './sibling.ts';`,
    ].join('\n'),
  );
});

test("the bridge serves ui-kit's stylesheet, and the pages link tokens.css, ui.css and page.css first, then their own sheets, every one served", async () => {
  const found = assetFor('/assets/ui-kit/css/ui.css');
  assert.ok(found, 'ui.css is served');
  assert.match(found[1], /text\/css/);
  assert.match(String(found[0]), /\.ou-ui-chip \{/);
  const tokens = assetFor('/assets/ui-kit/css/tokens.css');
  assert.ok(tokens, 'tokens.css is served');
  assert.match(tokens[1], /text\/css/);
  const { boardPage, localPage } = await import('@once-upon-a-diff/server/pages');
  for (const page of [String(boardPage()), String(localPage('s', { title: 't' }))]) {
    const sheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(sheets.slice(0, 3), [
      '/assets/ui-kit/css/tokens.css',
      '/assets/ui-kit/css/ui.css',
      '/assets/page.css',
    ]);
    assert.ok(sheets.length > 3, 'and the page has its own sheets');
    for (const sheet of sheets) {
      const served = assetFor(sheet);
      assert.ok(served && /text\/css/.test(served[1]), `${sheet} is served as CSS`);
    }
  }
});

test('every stylesheet under the web package is linked by a page (a region sheet nobody links never loads)', async () => {
  const { BOARD_SHEETS, LOCAL_SHEETS } = await import('@once-upon-a-diff/server/pages');
  const linked = new Set([...BOARD_SHEETS, ...LOCAL_SHEETS]);
  const publicDir = fileURLToPath(new URL('../../../client/web/public/', import.meta.url));
  for (const name of readdirSync(publicDir, { recursive: true, encoding: 'utf8' })) {
    if (name.endsWith('.css')) {
      const url = name === 'page.css' ? '/assets/page.css' : `/assets/${name}`;
      assert.ok(linked.has(url), `${url} is linked by a page`);
    }
  }
});

test('the old /assets/protocol/ URLs are gone', () => {
  for (const old of [
    '/assets/protocol/routes.ts',
    '/assets/protocol/route-kit.ts',
    '/assets/protocol/story/routes.ts',
  ]) {
    assert.equal(assetFor(old), null, old);
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

test('the old /assets/api-client/ URLs are gone', () => {
  for (const old of [
    '/assets/api-client/client.ts',
    '/assets/api-client/poll.ts',
    '/assets/api-client/use-poll.ts',
    '/assets/api-client/usage.ts',
  ]) {
    assert.equal(assetFor(old), null, old);
  }
});

test('every asset the local page and the board page load, and every module under them, is fetched from a running bridge with a 200', async () => {
  const { boardPage, localPage } = await import('@once-upon-a-diff/server/pages');
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
    assert.ok(queue.includes('/assets/board/board.css'), 'the board loads its own');
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
      '/assets/local/app.ts',
      '/assets/local/store.ts',
      '/assets/local/actions.ts',
      '/assets/local/top.ts',
      '/assets/local/diff/rows.ts',
      '/assets/local/diff/table.ts',
      '/assets/local/diff/files.ts',
      '/assets/local/diff/tree.ts',
      '/assets/local/diff/highlights.ts',
      '/assets/local/ship/dialogs.ts',
      '/assets/preact.mjs',
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
  const src = fileURLToPath(new URL('../../../client-libs/ui-kit/src/', import.meta.url));
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

test('a running bridge serves every file of the github-page package at /assets/github-page/, and the old /assets/host-github/ URLs are 404', async () => {
  const src = fileURLToPath(new URL('../../../client/github-page/src/', import.meta.url));
  const files = readdirSync(src).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('diff-dom.ts') && files.includes('pages.ts'));
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const name of files) {
      const response = await fetch(`${bridge.base}/assets/github-page/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type') ?? '', /javascript/, name);
    }
    for (const old of ['diff-dom.ts', 'pages.ts']) {
      assert.equal((await fetch(`${bridge.base}/assets/host-github/${old}`)).status, 404, old);
    }
  } finally {
    await bridge.close();
  }
});

test('a running bridge serves every file of the bridge-client package at /assets/bridge-client/, and not the old /assets/api-client/', async () => {
  const src = fileURLToPath(new URL('../../../client-libs/bridge-client/src/', import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.ts'),
  );
  assert.ok(files.includes('client.ts') && files.includes('use-poll.ts'));
  const bridge = await startBridge({ home: tmp('home') });
  try {
    for (const name of files) {
      const response = await fetch(`${bridge.base}/assets/bridge-client/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type') ?? '', /javascript/);
    }
    for (const name of files) {
      assert.equal((await fetch(`${bridge.base}/assets/api-client/${name}`)).status, 404, name);
    }
  } finally {
    await bridge.close();
  }
});
