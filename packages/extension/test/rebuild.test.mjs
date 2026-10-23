import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  tmp,
  writeJson,
  githubStory,
  startBridge,
  runCli,
  localRepo,
} from 'once-upon-a-diff/test/helpers';
import { Builds } from 'once-upon-a-diff/inbox/builds';
import { Inbox } from 'once-upon-a-diff/inbox/inbox';
import { withMarks } from 'once-upon-a-diff/inbox/conversation';
import { parseUnifiedDiff } from 'once-upon-a-diff/util/diff';
import { noteRead, readReads } from 'once-upon-a-diff/stories/reads';
import { createLocalStory } from 'once-upon-a-diff/stories/local-story';
import {
  rebuildProblems,
  carryDrafts,
  questionMoves,
  readsToRetire,
} from 'once-upon-a-diff/stories/rebuild';
import { rebuildAsk, rebuildLine } from '@once-upon-a-diff/shared/panel/rebuild';
import { tagFor } from '../src/content/ui/story-tag.ts';

const STORY_ID = 'acme-widgets-7';
const added = (count, word) =>
  Array.from({ length: count }, (_, i) => `+${word} ${i + 1}`).join('\n');

/**
 * The PR's diff: src/a.js and src/b.js are small, src/big.js has two hunks of 25 added lines (new lines 1-27 and
 * 125-151), so it needs a chapter pointing at each.
 */
const PR_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
  'diff --git a/src/b.js b/src/b.js',
  '--- a/src/b.js',
  '+++ b/src/b.js',
  '@@ -10,2 +10,3 @@',
  ' ten',
  '+ten and a half',
  ' eleven',
  'diff --git a/src/big.js b/src/big.js',
  '--- a/src/big.js',
  '+++ b/src/big.js',
  '@@ -1,2 +1,27 @@',
  ' top',
  added(25, 'first'),
  ' top2',
  '@@ -100,2 +125,27 @@',
  ' mid',
  added(25, 'second'),
  ' mid2',
  '',
].join('\n');
const diff = parseUnifiedDiff(PR_DIFF);

/** The story as published before the rebuild: chapter 1 tells a.js, 2 tells b.js and big.js. */
const published = () => ({
  title: 'Widgets',
  overview: 'Story map',
  chapters: [
    {
      title: 'Chapter 1: Start',
      key: 'start',
      files: ['src/a.js'],
      comments: [{ path: 'src/a.js', line: 2, body: 'Could you confirm?' }],
    },
    {
      title: 'Chapter 2: Finish',
      files: [
        'src/b.js',
        {
          rel: 'src/big.js',
          lines: [
            { side: 'R', start: 2, end: 20, label: 'first' },
            { side: 'R', start: 130, end: 140, label: 'second' },
          ],
        },
      ],
      comments: [
        { path: 'src/b.js', line: 11, body: 'Is this needed?' },
        { path: 'src/big.js', line: 300, body: 'This line is long gone' },
        { path: '(general)', line: 0, body: 'Nice work overall' },
      ],
    },
  ],
});

/** A rebuild from chapter 2: chapter 1 copied as is, chapter 2 split in two, with none of the old drafts. */
const retoldFromTwo = () => {
  const plan = published();
  plan.chapters = [
    plan.chapters[0],
    { title: 'Chapter 2: The b side', files: ['src/b.js'] },
    {
      title: 'Chapter 3: The big file',
      files: [
        {
          rel: 'src/big.js',
          lines: [
            { side: 'R', start: 1, end: 27, label: 'first' },
            { side: 'R', start: 125, end: 151, label: 'second' },
          ],
        },
      ],
    },
  ];
  return plan;
};

describe('the rebuild rules', () => {
  const fromTwo = { mode: 'rebuild_from', from_step: 2 };

  test('chapters before the rebuild point must stay exactly as published (key order aside)', () => {
    assert.deepEqual(rebuildProblems(fromTwo, published(), retoldFromTwo(), diff), []);
    const reordered = retoldFromTwo();
    const [first] = reordered.chapters;
    reordered.chapters[0] = {
      comments: first.comments,
      files: first.files,
      key: first.key,
      title: first.title,
    };
    assert.deepEqual(
      rebuildProblems(fromTwo, published(), reordered, diff),
      [],
      'the same chapter with its keys in another order',
    );
    const edited = retoldFromTwo();
    edited.chapters[0].narrative = 'A better telling';
    assert.match(
      rebuildProblems(fromTwo, published(), edited, diff).join('\n'),
      /chapter 1 .*changed/,
    );
    const dropped = retoldFromTwo();
    dropped.chapters[0].comments = [];
    assert.equal(
      rebuildProblems(fromTwo, published(), dropped, diff).length,
      1,
      "a kept chapter's drafts are part of it",
    );
    const none = published();
    none.chapters = [none.chapters[0]];
    assert.match(
      rebuildProblems(fromTwo, published(), none, diff).join('\n'),
      /there's no chapter 2/,
    );
  });

  test('a whole rebuild may change every chapter', () => {
    const plan = retoldFromTwo();
    plan.chapters[0] = { title: 'Chapter 1: Begin again', files: ['src/a.js'] };
    assert.deepEqual(rebuildProblems({ mode: 'rebuild' }, published(), plan, diff), []);
  });

  test('every file and hunk of the diff is told somewhere in the whole story', () => {
    const unplaced = retoldFromTwo();
    unplaced.chapters.splice(1, 1); // b.js was only in the old chapter 2
    assert.match(
      rebuildProblems(fromTwo, published(), unplaced, diff).join('\n'),
      /1 files are in no chapter: src\/b.js/,
    );
    const half = retoldFromTwo();
    half.chapters[2].files[0].lines = [{ side: 'R', start: 1, end: 27 }];
    const problems = rebuildProblems(fromTwo, published(), half, diff);
    assert.match(problems.join('\n'), /hunks not covered: src\/big.js:125-151/);
    assert.deepEqual(
      rebuildProblems(fromTwo, published(), half, diff, { allowUncovered: true }),
      [],
    );
    const stray = retoldFromTwo();
    stray.chapters[1].files.push('src/nope.js');
    assert.match(
      rebuildProblems(fromTwo, published(), stray, diff).join('\n'),
      /chapter 2 names src\/nope.js, which is not in the diff/,
    );
  });

  test('drafts the re-told chapters dropped come back: kept where their line still is, flagged where it is not', () => {
    const after = retoldFromTwo();
    const counts = carryDrafts(published(), after, diff, 2);
    assert.deepEqual(counts, { carried: 2, unmapped: 1 });
    assert.deepEqual(after.chapters[0], published().chapters[0], 'kept chapter untouched');
    assert.deepEqual(after.chapters[1].comments, [
      { path: 'src/b.js', line: 11, body: 'Is this needed?', carried: true },
      { path: '(general)', line: 0, body: 'Nice work overall', carried: true },
    ]);
    assert.deepEqual(
      after.chapters[2].comments,
      [{ path: 'src/big.js', line: 300, body: 'This line is long gone', unmapped: true }],
      'line 300 is in no hunk now, so it is kept and flagged with its file',
    );
    const again = retoldFromTwo();
    again.chapters[1].comments = [{ path: 'src/b.js', line: 11, body: 'Is this needed?' }];
    carryDrafts(published(), again, diff, 2);
    assert.equal(
      again.chapters[1].comments.filter((comment) => comment.body === 'Is this needed?').length,
      1,
      'a draft the new chapters kept is not doubled',
    );
  });

  test('questions on re-told chapters follow their file, and reads of chapters re-told over other files are set aside', () => {
    const questions = [
      { id: 'q1', step: 1, file: 'src/a.js' },
      { id: 'q2', step: 2, file: 'src/big.js' },
      { id: 'q3', step: 2, file: null },
      { id: 'q4', step: 0, file: null },
    ];
    assert.deepEqual(questionMoves(questions, published(), retoldFromTwo(), 2), {
      q2: 3,
      q3: 0,
    });
    const reads = { start: { at: 'x' }, finish: { at: 'y' } };
    const after = retoldFromTwo();
    after.chapters[1].title = 'Chapter 2: Finish';
    assert.deepEqual(readsToRetire(reads, published(), after), ['finish']);
    const same = published();
    assert.deepEqual(readsToRetire(reads, published(), same), [], 'same files keep their reads');
  });
});

describe('asking for a rebuild', () => {
  const scratchFor = () => {
    const src = tmp('scratch');
    githubStory(src, { meta: { head_oid: 'a'.repeat(40) } });
    writeFileSync(path.join(src, 'pr.diff'), PR_DIFF);
    writeJson(path.join(src, 'chapters.json'), published());
    return src;
  };

  test('Rebuild story and Rebuild from here queue requests the panel and the PR tags can follow', async () => {
    const home = tmp('home');
    const src = scratchFor();
    assert.equal((await runCli(home, ['publish', '--dir', src])).code, 0);
    const bridge = await startBridge({ home });
    const rebuildPath = `/api/stories/${STORY_ID}/rebuild`;
    try {
      const whole = await bridge.call('POST', rebuildPath, {
        mode: 'rebuild',
        guidance: '  The overview undersells the big file  ',
      });
      assert.equal(whole.status, 200);
      assert.equal(whole.body.rebuild.state, 'queued');
      assert.equal(whole.body.rebuild.mode, 'rebuild');
      const stored = new Builds(home).get('acme/widgets', 7);
      assert.equal(stored.story, STORY_ID);
      assert.equal(stored.kind, 'github');
      assert.equal(stored.guidance, 'The overview undersells the big file');
      assert.equal(stored.url, 'https://github.com/acme/widgets/pull/7');
      assert.ok(stored.story_dir.endsWith(STORY_ID));

      // the later click wins while no session has it, under the same id
      const fromTwo = await bridge.call('POST', rebuildPath, {
        mode: 'rebuild_from',
        from_step: 2,
      });
      assert.equal(fromTwo.body.rebuild.id, whole.body.rebuild.id);
      assert.equal(fromTwo.body.rebuild.mode, 'rebuild_from');
      assert.equal(fromTwo.body.rebuild.from_step, 2);
      assert.equal(new Builds(home).get('acme/widgets', 7).guidance, undefined);
      assert.equal(
        (await bridge.call('POST', rebuildPath, { mode: 'rebuild_from', from_step: 1 })).body
          .rebuild.mode,
        'rebuild',
        'from chapter 1 is a whole rebuild',
      );
      assert.equal(
        (await bridge.call('POST', rebuildPath, { mode: 'rebuild_from', from_step: 3 })).status,
        400,
      );
      assert.equal((await bridge.call('POST', rebuildPath, { mode: 'retell' })).status, 400);

      const pulse = (await bridge.call('GET', `/api/stories/${STORY_ID}/pulse`)).body;
      assert.equal(pulse.rebuild.state, 'queued');
      const status = (
        await bridge.call('POST', '/api/stories/status-many', {
          prs: [{ repo: 'acme/widgets', number: 7 }],
        })
      ).body.results[0];
      assert.equal(status.state, 'ready');
      assert.equal(status.updating, true);
      assert.equal(status.update_mode, 'rebuild');
      assert.equal(
        new Builds(home).get('acme/widgets', 7).status,
        'pending',
        'the story being there does not finish a rebuild',
      );
      assert.equal(tagFor(status, { repo: 'acme/widgets', number: 7 }).label, 'Rebuild queued');

      // a request a session is building stands
      new Builds(home).claim(whole.body.rebuild.id, 'story-acme-widgets-7');
      const later = await bridge.call('POST', rebuildPath, { mode: 'rebuild_from', from_step: 2 });
      assert.equal(later.body.rebuild.state, 'building');
      assert.equal(later.body.rebuild.mode, 'rebuild');
      assert.equal(later.body.rebuild.claimed_by, 'story-acme-widgets-7');
    } finally {
      await bridge.close();
    }
  });

  test('publishing the rebuild finishes it, keeps the dropped drafts, moves questions and sets aside stale reads', async () => {
    const home = tmp('home');
    const src = scratchFor();
    await runCli(home, ['publish', '--dir', src]);
    const inbox = new Inbox(home);
    inbox.append({
      type: 'question',
      id: 'q_big',
      story: STORY_ID,
      step: 2,
      file: 'src/big.js',
      text: 'Why?',
    });
    noteRead(home, 'pr-acme-widgets-7', 'start', { title: 'Chapter 1: Start', step: 1 });
    noteRead(home, 'pr-acme-widgets-7', 'finish', { title: 'Chapter 2: Finish', step: 2 });
    const builds = new Builds(home);
    const meta = { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: 'a'.repeat(40) };
    const request = builds.requestRebuild({
      story: STORY_ID,
      meta,
      mode: 'rebuild_from',
      from_step: 2,
      chapters: 2,
    });

    // a rebuild that touches a kept chapter is refused, and the published story stays as it was
    const bad = retoldFromTwo();
    bad.chapters[0].title = 'Chapter 1: Started';
    writeJson(path.join(src, 'chapters.json'), bad);
    const refused = await runCli(home, ['publish', '--dir', src]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /chapter 1 .*changed/);
    const served = path.join(home, STORY_ID, 'chapters.json');
    assert.deepEqual(JSON.parse(readFileSync(served, 'utf8')), published());
    assert.equal(builds.get('acme/widgets', 7).status, 'pending');

    const retold = retoldFromTwo();
    retold.chapters[1].title = 'Chapter 2: Finish'; // the same key, re-told over b.js alone
    writeJson(path.join(src, 'chapters.json'), retold);
    const ok = await runCli(home, ['publish', '--dir', src]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stderr, /Re-told from chapter 2: kept 2 drafts, flagged 1 draft/);
    const done = builds.get('acme/widgets', 7);
    assert.equal(done.id, request.id);
    assert.equal(done.status, 'done');
    assert.match(done.note, /moved 1 question/);
    const now = JSON.parse(readFileSync(served, 'utf8'));
    assert.deepEqual(now.chapters[0], published().chapters[0]);
    assert.equal(now.chapters.length, 3);
    assert.deepEqual(
      now.chapters.flatMap((chapter) => (chapter.comments || []).map((comment) => comment.body)),
      ['Could you confirm?', 'Is this needed?', 'Nice work overall', 'This line is long gone'],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(src, 'chapters.json'), 'utf8')),
      now,
      'the once-upon folder keeps them too, for the next build',
    );
    const [question] = withMarks(home, STORY_ID, inbox.questions(STORY_ID));
    assert.equal(question.step, 3, 'the question follows big.js to chapter 3');
    assert.equal(question.asked_on, 2);
    const reads = readReads(home, 'pr-acme-widgets-7');
    assert.ok(reads.start, 'a kept chapter keeps its read');
    assert.equal(reads.finish, undefined);
    assert.ok(reads['finish (before the rebuild)']);
  });
});

describe('a local story', () => {
  test('rebuilds from the local page, and `once-upon local --chapters` finishes it', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = createLocalStory({ home, repo, base, id: 'local-rebuild' });
    const bridge = await startBridge({ home });
    try {
      const asked = await bridge.call('POST', `/api/stories/${made.id}/rebuild`, {
        mode: 'rebuild',
        guidance: 'Tell it by commit',
      });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const stored = new Builds(home).all()['story:local-rebuild'];
      assert.equal(stored.kind, 'local');
      assert.equal(stored.number, null);
      assert.equal(path.basename(stored.local.repo_path), path.basename(repo));
      assert.equal(stored.local.base, base);
      assert.equal(stored.local.head, 'HEAD');

      // the story's own listener takes it while it's live; the catch-all wait leaves it
      const live = [
        { consumer: 'story-local-rebuild', story: 'local-rebuild', live: true, builds: true },
      ];
      assert.deepEqual(new Builds(home).toHand('everything', { live }), []);
      const handed = new Builds(home).toHand('story-local-rebuild', {
        story: 'local-rebuild',
        live,
      });
      assert.equal(handed.length, 1);
      assert.equal(handed[0].type, 'build_request');
      assert.equal(handed[0].mode, 'rebuild');
      assert.equal(handed[0].guidance, 'Tell it by commit');
      assert.match(
        handed[0].text,
        /Rebuild the story for the local story local-rebuild .* from scratch/,
      );

      const chapters = tmp('chapters');
      writeJson(path.join(chapters, 'chapters.json'), {
        title: 'By commit',
        chapters: [
          { title: 'Chapter 1: Change one', files: ['one.txt'] },
          { title: 'Chapter 2: Add two', files: ['lib/two.js', 'gone.txt'] },
        ],
      });
      const result = await runCli(home, [
        'local',
        '--repo',
        repo,
        '--base',
        base,
        '--id',
        'local-rebuild',
        '--chapters',
        path.join(chapters, 'chapters.json'),
        '--no-open',
        '--no-serve',
        '--port',
        '1',
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /Re-told the whole story/);
      assert.equal(new Builds(home).all()['story:local-rebuild'].status, 'done');
      const pulse = (await bridge.call('GET', `/api/stories/${made.id}/pulse`)).body;
      assert.equal(pulse.rebuild.state, 'done');
    } finally {
      await bridge.close();
    }
  });
});

describe('routing a rebuild', () => {
  test("goes to the story's own listener while one that takes build requests is live, else to the repo's", () => {
    const home = tmp('home');
    const builds = new Builds(home);
    const meta = { kind: 'github', repo: 'acme/widgets', number: 7 };
    builds.requestRebuild({ story: STORY_ID, meta, mode: 'rebuild', chapters: 2 });
    const plain = builds.request({ repo: 'acme/widgets', number: 8 });
    const storyListener = { consumer: 'story-x', story: STORY_ID, live: true, builds: true };
    const repoWait = (live) =>
      builds.toHand('repo-acme-widgets', { repo: 'acme/widgets', live }).map((entry) => entry.id);

    assert.deepEqual(repoWait([storyListener]), [plain.id], 'the repo wait leaves the rebuild');
    const questionsOnly = { ...storyListener, builds: false };
    const all = builds.all();
    delete all['acme/widgets#8'];
    builds.save(all);
    assert.equal(
      repoWait([questionsOnly]).length,
      1,
      'a story listener that takes only questions leaves it to the repo',
    );
  });

  test('`wait --story` takes the story rebuilds and beats that it does', async () => {
    const home = tmp('home');
    const builds = new Builds(home);
    const meta = { kind: 'github', repo: 'acme/widgets', number: 7 };
    const rebuild = builds.requestRebuild({
      story: STORY_ID,
      meta,
      mode: 'rebuild_from',
      from_step: 2,
      chapters: 2,
    });
    builds.request({ repo: 'acme/widgets', number: 8 });
    const result = await runCli(home, [
      'wait',
      '--story',
      STORY_ID,
      '--type',
      'question,build_request',
      '--timeout',
      '1',
      '--json',
    ]);
    const entries = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.mode, entry.from_step]),
      [[rebuild.id, 'rebuild_from', 2]],
      'only its own rebuild, not the PR next door',
    );
    const heartbeat = JSON.parse(
      readFileSync(path.join(home, 'listeners', `story-${STORY_ID}.json`), 'utf8'),
    );
    assert.equal(heartbeat.builds, true);
  });
});

test("the panel's request and status line", () => {
  assert.deepEqual(
    { ...rebuildAsk(0, '  '), requested_at: null },
    { mode: 'rebuild', requested_at: null },
  );
  const fromThree = rebuildAsk(3, ' Chapter 3 reads backwards ');
  assert.equal(fromThree.mode, 'rebuild_from');
  assert.equal(fromThree.from_step, 3);
  assert.equal(fromThree.guidance, 'Chapter 3 reads backwards');
  assert.equal(rebuildAsk(1).mode, 'rebuild');

  assert.equal(rebuildLine(null), '');
  assert.match(rebuildLine({ state: 'queued', from_step: 3 }), /^Rebuild from chapter 3 queued/);
  assert.equal(
    rebuildLine({ state: 'building', claimed_by: 'story-x' }),
    'Rebuilding the whole story… (story-x)',
  );
  const now = Date.parse('2026-10-22T20:00:00Z');
  const done = { state: 'done', done_at: '2026-10-22T19:50:00Z', note: 'Re-told the whole story.' };
  assert.match(rebuildLine(done, now), /^Rebuilt the whole story at .*Re-told the whole story\.$/);
  assert.equal(rebuildLine(done, now + 60 * 60 * 1000), '', 'an old one says nothing');
  assert.match(
    rebuildLine({ state: 'failed', done_at: '2026-10-22T19:55:00Z', note: 'the PR moved' }, now),
    /failed.*: the PR moved$/,
  );
});
