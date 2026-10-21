import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, startBridge, localRepo, writeJson } from './helpers.mjs';
import { createLocalStory } from '../bridge/stories/local-story.mjs';
import { relOfDraft } from '../bridge/server/index.mjs';
import { draftView } from '../src/js/shared/overlay.js';

test('Add to fix before push makes a local draft a note, once, and the draft says so', async () => {
  const { repo, base } = localRepo();
  const home = tmp('fix-home');
  const chapters = path.join(tmp('fix-ch'), 'chapters.json');
  writeJson(chapters, {
    chapters: [
      {
        title: 'Chapter 1: One',
        files: ['one.txt', 'lib/two.js'],
        comments: [
          { path: 'one.txt', line: 2, body: 'Lower-case B' },
          { path: 'two.js', line: 1, body: 'Name it' },
          { path: '(general)', line: 0, body: 'Overall' },
        ],
      },
    ],
  });
  const made = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const b = await startBridge({ home });
  try {
    const S = `/api/stories/${made.id}`;
    let drafts = (await b.call('GET', `${S}/drafts`)).body.drafts;
    assert.equal(drafts[0].fix, null);
    const n = await b.call('POST', `${S}/notes`, { chapter: 1, index: 1 });
    assert.equal(n.status, 200);
    assert.deepEqual(
      [n.body.path, n.body.side, n.body.line, n.body.body, n.body.done, n.body.chapter],
      ['lib/two.js', 'R', 1, 'Name it', false, 1],
      "the draft's name resolves to the diff file",
    );
    assert.equal(
      (await b.call('POST', `${S}/notes`, { chapter: 1, index: 1 })).status,
      409,
      'a second add is refused',
    );
    assert.equal(
      (await b.call('POST', `${S}/notes`, { chapter: 1, index: 2 })).status,
      400,
      'a general comment has no line to go on',
    );
    assert.equal((await b.call('POST', `${S}/notes`, { chapter: 1, index: 9 })).status, 404);
    const notes = (await b.call('GET', S)).body.local.notes;
    assert.deepEqual(
      notes.map((x) => x.body),
      ['Name it'],
      'it is a real note, in the checklist',
    );
    drafts = (await b.call('GET', `${S}/drafts`)).body.drafts;
    assert.deepEqual(drafts[1].fix, {
      id: n.body.id,
      done: false,
      path: 'lib/two.js',
      side: 'R',
      line: 1,
    });
    assert.equal(drafts[0].fix, null);
    await b.call('POST', `${S}/notes/${n.body.id}`, { done: true });
    assert.equal(
      (await b.call('GET', `${S}/drafts`)).body.drafts[1].fix.done,
      true,
      'ticking the note shows on the draft',
    );
    assert.equal(
      (await b.call('POST', `${S}/drafts`, { chapter: 1, index: 0, action: 'dismiss' })).body
        .drafts[0].dismissed,
      true,
      'Dismiss works as on GitHub',
    );
  } finally {
    await b.close();
  }
});

test('a draft in fix before push shows as such, and a dismissed one stays dismissed', () => {
  assert.equal(
    draftView({ status: 'draft', dismissed: false, fix: { id: 'n1', done: false } }).show,
    'fix',
  );
  assert.equal(
    draftView({ status: 'draft', dismissed: true, fix: { id: 'n1', done: false } }).show,
    'dismissed',
  );
  assert.equal(relOfDraft('two.js', ['lib/two.js', 'one.txt']), 'lib/two.js');
  assert.equal(
    relOfDraft('index.ts', ['a/index.ts', 'b/index.ts']),
    null,
    'an ambiguous name resolves to nothing',
  );
});
