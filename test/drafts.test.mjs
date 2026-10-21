import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson } from './helpers.mjs';
import { similarity, bestMatch, clearCache } from '../bridge/lib/drafts.mjs';

process.env.DIFF_STORY_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-gh.mjs',
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

test('posted, pending (his unsubmitted review), dismissed and manual marks are four separate things', async () => {
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
  const b = await startBridge({ home });
  try {
    const st = (await b.call('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.equal(st.error, null);
    assert.equal(st.login, 'octocat');
    assert.deepEqual(
      st.drafts.map((d) => d.status),
      ['posted', 'pending', 'draft', 'draft'],
    );
    assert.equal(st.drafts[0].url, 'https://github.com/acme/widgets/pull/7#discussion_r1');

    let r = (
      await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 3,
        action: 'dismiss',
      })
    ).body;
    assert.equal(r.drafts[3].dismissed, true);
    r = (
      await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 2,
        action: 'posted',
      })
    ).body;
    assert.equal(r.drafts[2].status, 'posted');
    assert.equal(r.drafts[2].source, 'manual');
    r = (
      await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'unposted',
      })
    ).body;
    assert.equal(r.drafts[0].status, 'draft', 'Unmark wins over a wrong match');

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
    r = (await b.call('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.equal(
      r.drafts[0].dismissed,
      true,
      'a regenerated story does not suggest a dismissed comment again',
    );
    assert.equal(r.drafts[1].status, 'draft');
    r = (
      await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'restore',
      })
    ).body;
    assert.equal(r.drafts[0].dismissed, false);
    assert.equal(
      (
        await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
          chapter: 1,
          index: 0,
          action: 'post-it',
        })
      ).status,
      400,
    );
  } finally {
    await b.close();
  }
});

test('without gh, posted detection says why and manual marks still work', async () => {
  clearCache();
  const saved = process.env.DIFF_STORY_GH;
  process.env.DIFF_STORY_GH = '/nonexistent/gh';
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const b = await startBridge({ home });
  try {
    const st = (await b.call('GET', '/api/stories/acme-widgets-7/drafts')).body;
    assert.match(st.error, /couldn't read the PR's comments/);
    const r = (
      await b.call('POST', '/api/stories/acme-widgets-7/drafts', {
        chapter: 1,
        index: 0,
        action: 'posted',
      })
    ).body;
    assert.equal(r.drafts[0].status, 'posted');
  } finally {
    await b.close();
    process.env.DIFF_STORY_GH = saved;
  }
});
