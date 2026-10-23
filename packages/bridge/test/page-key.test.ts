import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  tmp,
  githubStory,
  startBridge,
  runCli,
  localRepo,
  writeJson,
  TOKEN,
  type TestBridge,
} from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { Inbox } from '../src/inbox/inbox.ts';
import { pageKey } from '../src/server/page-key.ts';
import type { Printable } from '../src/cli/output.ts';

/** A local story with one drafted comment, a PR story beside it, and a bridge serving both. */
async function twoStories() {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      {
        title: 'Chapter 1: One',
        files: ['one.txt', 'gone.txt', 'lib/two.js'],
        comments: [{ path: 'one.txt', line: 2, body: 'Fix the capital B' }],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const other = createLocalStory({ home, repo, base, head: 'HEAD', chapters, id: 'other-local' });
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  return { home, id, other: other.id, bridge };
}

/** A call with the page's key in place of the bridge's token. */
const withKey = (bridge: TestBridge, key: string, method: string, url: string, body?: unknown) =>
  bridge.call<{ error?: string }>(method, url, body, { Authorization: `Bearer ${key}` });

test("the local page carries no token: its key comes in the link's fragment", async () => {
  const { home, id, bridge } = await twoStories();
  try {
    const page = await bridge.call('GET', `/local/${id}/`, undefined, { Authorization: '' });
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes(TOKEN), 'not the bridge token');
    assert.ok(!page.text.includes(pageKey(TOKEN, id)), 'not the page key either');

    writeJson(path.join(home, 'config.json'), { port: 1, token: TOKEN });
    const printed = await runCli(home, ['page', '--story', id, '--no-open']);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(
      printed.stdout.trim(),
      `http://127.0.0.1:1/local/${encodeURIComponent(id)}/#key=${pageKey(TOKEN, id)}`,
    );
    const github = await runCli(home, ['page', '--story', 'acme-widgets-7', '--no-open']);
    assert.notEqual(github.code, 0, 'only a local story has a page');
  } finally {
    await bridge.close();
  }
});

test("a story listener gets the page's question, rebuild and fix request; the key reaches nothing else", async () => {
  const { home, id, other, bridge } = await twoStories();
  const key = pageKey(TOKEN, id);
  const story = `/api/stories/${encodeURIComponent(id)}`;
  try {
    const inbox = new Inbox(home);
    writeFileSync(inbox.file, '');
    inbox.setCursor(`story-${id}`, 0); // it has waited before, so it reads from the top

    const asked = await withKey(bridge, key, 'POST', `${story}/questions`, {
      text: 'Why one.txt?',
      step: 1,
    });
    assert.equal(asked.status, 200, asked.text);
    const rebuild = await withKey(bridge, key, 'POST', `${story}/rebuild`, {
      mode: 'rebuild',
      guidance: 'Shorter',
    });
    assert.equal(rebuild.status, 200, rebuild.text);
    const note = await withKey(bridge, key, 'POST', `${story}/notes`, {
      path: 'one.txt',
      line: 1,
      body: 'Rename it',
    });
    assert.equal(note.status, 200, note.text);
    const sent = await withKey(bridge, key, 'POST', `${story}/fixes`, { action: 'send' });
    assert.equal(sent.status, 200, sent.text);
    for (const what of ['', '/status', '/prefs', '/pulse', '/drafts', '/fixes']) {
      assert.equal((await withKey(bridge, key, 'GET', `${story}${what}`)).status, 200, what);
    }

    const waited = await runCli(home, [
      'wait',
      '--story',
      id,
      '--type',
      'question,build_request,fix_request',
      '--consumer',
      `story-${id}`,
      '--timeout',
      '1',
      '--json',
    ]);
    const handed = waited.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Printable);
    assert.deepEqual(handed.map((entry) => entry.type).sort(), [
      'build_request',
      'fix_request',
      'question',
    ]);

    // never another story, a PR story, a bridge-wide route or GitHub
    const refused: [string, string, unknown?][] = [
      ['GET', `/api/stories/${other}`],
      ['POST', `/api/stories/${other}/questions`, { text: 'x' }],
      ['GET', '/api/stories/acme-widgets-7'],
      ['GET', '/api/stories'],
      ['POST', '/api/stories/status-many', { prs: [] }],
      ['GET', `/api/status?story=${id}`],
      ['POST', '/api/prefs', { hideWhitespace: true }],
      ['POST', '/api/builds', { repo: 'acme/widgets', number: 7 }],
      ['GET', '/api/health'],
    ];
    for (const [method, url, body] of refused) {
      assert.equal((await withKey(bridge, key, method, url, body)).status, 403, `${method} ${url}`);
    }
    const otherKey = pageKey(TOKEN, 'acme-widgets-7');
    assert.equal(
      (await withKey(bridge, otherKey, 'GET', '/api/stories/acme-widgets-7')).status,
      403,
      'a page key is for a local story only',
    );
    const review = await withKey(bridge, key, 'POST', `${story}/drafts`, {
      chapter: 1,
      index: 0,
      action: 'review',
    });
    assert.equal(review.status, 403, 'never Add to my review');
    assert.equal(
      (await withKey(bridge, `${key}x`, 'GET', story)).status,
      403,
      'a wrong key is refused',
    );
    assert.equal(
      (await bridge.call('GET', '/api/stories')).status,
      200,
      'the bridge token still reaches everything',
    );
  } finally {
    await bridge.close();
  }
});
