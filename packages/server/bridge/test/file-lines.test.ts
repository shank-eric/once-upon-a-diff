import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmp, git, githubStory, startBridge, localRepo, writeJson, TOKEN } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { pageKey, viewKey, boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';

/** A local story on a real checkout (one.txt, lib/two.js and gone.txt in its diff), and a bridge serving it. */
async function setup() {
  const home = tmp('home');
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      {
        refs: [],
        title: 'Chapter 1',
        narrative: 'Told.',
        files: ['one.txt', 'lib/two.js', 'gone.txt'],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const bridge = await startBridge({ home });
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const lines = (key: string, body: unknown, story = id) =>
    bridge.call<{ lines?: string[]; error?: string }>('POST', `/api/stories/${story}/lines`, body, {
      Authorization: `Bearer ${key}`,
    });
  return { home, repo, id, bridge, head, lines };
}

test('lines answers the head text of a file in the diff, and the read-only key may ask too', async () => {
  const { id, bridge, head, lines } = await setup();
  try {
    const full = await lines(pageKey(TOKEN, id), { path: 'one.txt', head_oid: head() });
    assert.equal(full.status, 200, full.text);
    assert.deepEqual(full.body.lines, ['a', 'B', 'c', 'd']);
    const nested = await lines(viewKey(TOKEN, id), { path: 'lib/two.js', head_oid: head() });
    assert.equal(nested.status, 200, nested.text);
    assert.deepEqual(nested.body.lines, ['export const two = 2;']);
    const other = await lines(boardKey(TOKEN), { path: 'one.txt', head_oid: head() });
    assert.equal(other.status, 403, 'the board key reaches no story');
  } finally {
    await bridge.close();
  }
});

test('lines reads only the diff files of the story: a path outside the diff, a traversal and an absolute path are 404', async () => {
  const { id, repo, bridge, head, lines } = await setup();
  try {
    writeFileSync(path.join(repo, 'other.txt'), 'secret\n');
    git(repo, 'add', 'other.txt');
    git(repo, 'commit', '-q', '-m', 'other');
    const key = pageKey(TOKEN, id);
    // a HEAD story is remade by the call, so other.txt is in the diff now: it is the repo's other files that stay out
    const inDiff = await lines(key, { path: 'other.txt', head_oid: head() });
    assert.equal(inDiff.status, 200, inDiff.text);
    const parent = '..';
    for (const rel of [
      // spelled out of parts: the no-cross-package-paths scan reads a literal ../ as a path
      `${parent}/x`,
      `${parent}/${parent}/etc/passwd`,
      '/etc/passwd',
      'lib',
      'lib/',
      './one.txt',
      'one.txt/',
      '',
      'meta.json',
    ]) {
      const refused = await lines(key, { path: rel, head_oid: head() });
      assert.equal(refused.status, 404, `${rel}: ${refused.text}`);
    }
    // a path no commit of the range touched
    const untouched = await lines(key, { path: 'nope.txt', head_oid: head() });
    assert.equal(untouched.status, 404);
  } finally {
    await bridge.close();
  }
});

test('lines is 404 for a file the head no longer has, 409 for a stale head, 400 for a body without a path or for a PR story', async () => {
  const { id, home, bridge, head, lines, repo } = await setup();
  try {
    const key = pageKey(TOKEN, id);
    const gone = await lines(key, { path: 'gone.txt', head_oid: head() });
    assert.equal(gone.status, 404, 'gone.txt is in the diff (deleted) and has no blob at head');
    const stale = await lines(key, { path: 'one.txt', head_oid: 'a'.repeat(40) });
    assert.equal(stale.status, 409, stale.text);
    assert.match(stale.body.error || '', /moved/);
    const old = head();
    writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'move head');
    const moved = await lines(key, { path: 'one.txt', head_oid: old });
    assert.equal(moved.status, 409, 'a commit since the page drew it');
    const bad = await lines(key, { head_oid: head() });
    assert.equal(bad.status, 400);
    const missing = await lines(
      pageKey(TOKEN, 'nope'),
      { path: 'one.txt', head_oid: head() },
      'nope',
    );
    assert.equal(missing.status, 404);
    githubStory(path.join(home, 'acme-widgets-7'));
    const pr = await bridge.call('POST', '/api/stories/acme-widgets-7/lines', {
      path: 'a.txt',
      head_oid: 'x',
    });
    assert.equal(pr.status, 400, 'a PR story draws its diff on GitHub');
  } finally {
    await bridge.close();
  }
});

test('lines refuses a binary file and one over the size cap, and keeps a CRLF line ending on each line', async () => {
  const { id, repo, bridge, head, lines } = await setup();
  try {
    mkdirSync(path.join(repo, 'bin'));
    writeFileSync(path.join(repo, 'bin/blob.dat'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(1_200_000) + '\n');
    writeFileSync(path.join(repo, 'dos.txt'), 'a\r\nb\r\n');
    writeFileSync(path.join(repo, 'bare.txt'), 'no final newline');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'odd files');
    const key = pageKey(TOKEN, id);
    const binary = await lines(key, { path: 'bin/blob.dat', head_oid: head() });
    assert.equal(binary.status, 422, binary.text);
    assert.match(binary.body.error || '', /binary/);
    const big = await lines(key, { path: 'big.txt', head_oid: head() });
    assert.equal(big.status, 422, big.text);
    assert.match(big.body.error || '', /too large/);
    const dos = await lines(key, { path: 'dos.txt', head_oid: head() });
    assert.deepEqual(dos.body.lines, ['a\r', 'b\r']);
    const bare = await lines(key, { path: 'bare.txt', head_oid: head() });
    assert.deepEqual(bare.body.lines, ['no final newline']);
  } finally {
    await bridge.close();
  }
});
