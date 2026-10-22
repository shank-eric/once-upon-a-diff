import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, startBridge, localRepo, writeJson } from './helpers.mjs';
import { createLocalStory } from '../src/bridge/stories/local-story.mjs';
import { relOfDraft } from '../src/bridge/server/index.mjs';
import { draftView } from '../src/shared/overlay.js';

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
  const bridge = await startBridge({ home });
  try {
    const storyPath = `/api/stories/${made.id}`;
    let drafts = (await bridge.call('GET', `${storyPath}/drafts`)).body.drafts;
    assert.equal(drafts[0].fix, null);
    const note = await bridge.call('POST', `${storyPath}/notes`, { chapter: 1, index: 1 });
    assert.equal(note.status, 200);
    assert.deepEqual(
      [
        note.body.path,
        note.body.side,
        note.body.line,
        note.body.body,
        note.body.done,
        note.body.chapter,
      ],
      ['lib/two.js', 'R', 1, 'Name it', false, 1],
      "the draft's name resolves to the diff file",
    );
    assert.equal(
      (await bridge.call('POST', `${storyPath}/notes`, { chapter: 1, index: 1 })).status,
      409,
      'a second add is refused',
    );
    assert.equal(
      (await bridge.call('POST', `${storyPath}/notes`, { chapter: 1, index: 2 })).status,
      400,
      'a general comment has no line to go on',
    );
    assert.equal(
      (await bridge.call('POST', `${storyPath}/notes`, { chapter: 1, index: 9 })).status,
      404,
    );
    const notes = (await bridge.call('GET', storyPath)).body.local.notes;
    assert.deepEqual(
      notes.map((note) => note.body),
      ['Name it'],
      'it is a real note, in the checklist',
    );
    drafts = (await bridge.call('GET', `${storyPath}/drafts`)).body.drafts;
    assert.deepEqual(drafts[1].fix, {
      id: note.body.id,
      done: false,
      path: 'lib/two.js',
      side: 'R',
      line: 1,
      state: 'draft',
      sent_to: null,
      sha: null,
    });
    assert.equal(drafts[0].fix, null);
    await bridge.call('POST', `${storyPath}/notes/${note.body.id}`, { done: true });
    assert.equal(
      (await bridge.call('GET', `${storyPath}/drafts`)).body.drafts[1].fix.done,
      true,
      'ticking the note shows on the draft',
    );
    assert.equal(
      (
        await bridge.call('POST', `${storyPath}/drafts`, {
          chapter: 1,
          index: 0,
          action: 'dismiss',
        })
      ).body.drafts[0].dismissed,
      true,
      'Dismiss works as on GitHub',
    );
  } finally {
    await bridge.close();
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
