import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.ts';
import { similarity, bestMatch, clearCache } from '../src/github/drafts.ts';
import type { DraftsAnswer } from '@once-upon-a-diff/shared/types';

/** GET or POST .../drafts: each draft's state, and the gh user it was checked as. */
type DraftsBody = DraftsAnswer & { login: string | null };

process.env.ONCE_UPON_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh.ts',
);

test('an edited draft still matches what was posted; an unrelated one does not', () => {
  assert.ok(
    similarity(
      'Could you confirm what happens with an empty list here?',
      'Could you confirm what happens with an empty list here? I think it throws.',
    ) >= 0.8,
  );
  assert.ok(
    similarity(
      'could you confirm what happens with an empty list',
      'Could you confirm what happens with an **empty** list?',
    ) >= 0.8,
  );
  assert.ok(
    similarity(
      'Could you confirm what happens with an empty list here?',
      'Optional: rename this helper',
    ) < 0.5,
  );
  const posted = [
    {
      path: 'apps/x/src/a.js',
      line: 12,
      body: 'Could you confirm what happens with an empty list here?',
    },
  ];
  assert.ok(
    bestMatch(
      {
        path: 'src/a.js',
        line: 10,
        body: 'Could you confirm what happens with an empty list here?',
      },
      posted,
    ),
    'a path suffix and a line 2 away match',
  );
  assert.equal(
    bestMatch(
      {
        path: 'src/a.js',
        line: 30,
        body: 'Could you confirm what happens with an empty list here?',
      },
      posted,
    ),
    null,
    'too far from the line',
  );
});

test('posted, pending (his unsubmitted review), dismissed and draft are separate things', async () => {
  clearCache();
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const file = path.join(home, 'acme-widgets-7', 'chapters.json');
  writeJson(file, {
    title: 'Widgets',
    chapters: [
      {
        title: 'Chapter 1: Start',
        files: ['src/a.js', 'src/b.js', 'README.md'],
        comments: [
          {
            path: 'src/a.js',
            line: 2,
            body: 'Could you confirm what happens with an empty list here?',
          }, // posted (edited, 1 line off)
          {
            path: 'src/b.js',
            line: 10,
            body: 'Optional: this name reads oddly next to the other helpers.',
          }, // pending
          { path: 'src/b.js', line: 1, body: 'Nice tidy-up of the old code.' }, // posted by someone else: still a draft
          { path: 'README.md', line: 4, body: 'Typo: "teh".' }, // a draft
        ],
      },
    ],
  });
  const bridge = await startBridge({ home });
  try {
    const state = (await bridge.call<DraftsBody>('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.equal(state.error, null);
    assert.equal(state.login, 'octocat');
    assert.deepEqual(
      state.drafts.map((draft) => draft.status),
      ['posted', 'pending', 'draft', 'draft'],
    );
    assert.equal(state.drafts[0].url, 'https://github.com/acme/widgets/pull/7#discussion_r1');

    let result = (
      await bridge.call<DraftsBody>('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 3,
        action: 'dismiss',
      })
    ).body;
    assert.equal(result.drafts[3].dismissed, true);
    assert.equal(result.drafts[0].status, 'posted', 'a dismiss leaves the others as gh found them');
    assert.equal(
      (
        await bridge.call<DraftsBody>('POST', '/api/stories/acme-widgets-7/drafts', {
          chapter: 1,
          index: 2,
          action: 'posted',
        })
      ).status,
      400,
      'there is no manual Mark posted',
    );

    // a regenerated story, comments reordered and the dismissed one reworded a little, keeps the calls (they're kept per PR)
    writeJson(file, {
      title: 'Widgets',
      chapters: [
        {
          title: 'Chapter 1: Again',
          files: ['README.md', 'src/a.js'],
          comments: [
            { path: 'README.md', line: 5, body: 'Typo: "teh"' },
            {
              path: 'src/a.js',
              line: 2,
              body: 'Could you confirm what happens with an empty list here?',
            },
          ],
        },
      ],
    });
    result = (await bridge.call<DraftsBody>('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.equal(
      result.drafts[0].dismissed,
      true,
      'a regenerated story does not suggest a dismissed comment again',
    );
    assert.equal(result.drafts[1].status, 'posted', 'gh still matches the reordered one');
    result = (
      await bridge.call<DraftsBody>('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'restore',
      })
    ).body;
    assert.equal(result.drafts[0].dismissed, false);
    assert.equal(
      (
        await bridge.call<DraftsBody>('POST', '/api/stories/acme-widgets-7/drafts', {
          chapter: 1,
          index: 0,
          action: 'post-it',
        })
      ).status,
      400,
    );
  } finally {
    await bridge.close();
  }
});

test('without gh, posted detection says why and Dismiss still works', async () => {
  clearCache();
  const saved = process.env.ONCE_UPON_GH;
  process.env.ONCE_UPON_GH = '/nonexistent/gh';
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    const state = (await bridge.call<DraftsBody>('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.match(state.error as string, /couldn't read the PR's comments/);
    const result = (
      await bridge.call<DraftsBody>('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'dismiss',
      })
    ).body;
    assert.equal(result.drafts[0].status, 'draft');
    assert.equal(result.drafts[0].dismissed, true);
  } finally {
    await bridge.close();
    process.env.ONCE_UPON_GH = saved;
  }
});
