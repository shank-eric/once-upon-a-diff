import { test, describe } from 'node:test';
import { forgetMoved } from '@once-upon-a-diff/stories/local-diff';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmp, writeJson, git, startBridge, runCli, localRepo } from './helpers.ts';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import type { Freshness, StoryData } from '@once-upon-a-diff/contracts/types';

const STORY = 'local-update';
const metaOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));

/** Tells the story over the local repo: chapter 1 is one.txt, chapter 2 is lib/two.js and gone.txt. */
function tell(home: string, repo: string, base: string, head = 'HEAD') {
  const chapters = path.join(tmp('chapters'), 'chapters.json');
  writeJson(chapters, {
    title: 'The change',
    chapters: [
      { title: 'Chapter 1: Change one', files: ['one.txt'], refs: [] },
      { title: 'Chapter 2: Add two', files: ['lib/two.js', 'gone.txt'], refs: [] },
    ],
  });
  return createLocalStory({ home, repo, base, head, id: STORY, chapters });
}

const amendTwo = (repo: string, body = 'export const two = 3;\n') => {
  writeFileSync(path.join(repo, 'lib/two.js'), body);
  git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
  forgetMoved(); // where a pinned story's branch is stays known for 2 s
};

const freshnessOf = async (bridge: Awaited<ReturnType<typeof startBridge>>) =>
  (await bridge.call<Freshness>('GET', `/api/stories/${STORY}/freshness`)).body;

describe('freshness of a local story', () => {
  test('an amend that changes a file is stale, with the file and its chapter; a message-only amend is not', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base);
    const told = git(repo, 'rev-parse', 'HEAD');
    assert.equal(metaOf(made.dir).told_head_oid, told);
    assert.equal(metaOf(made.dir).told_base_oid, base);
    const bridge = await startBridge({ home });
    try {
      assert.equal((await freshnessOf(bridge)).state, 'current');
      git(repo, 'commit', '-q', '--amend', '-m', 'add two, reworded');
      const reworded = await freshnessOf(bridge);
      assert.equal(reworded.state, 'current', 'same patch, new message');
      amendTwo(repo);
      const stale = await freshnessOf(bridge);
      assert.equal(stale.state, 'stale');
      assert.equal(stale.rewritten, true);
      assert.equal(stale.story_head, told);
      assert.equal(stale.current_head, git(repo, 'rev-parse', 'HEAD'));
      assert.deepEqual(stale.changed_files, ['lib/two.js']);
      assert.deepEqual(stale.chapters_touched, [2]);
    } finally {
      await bridge.close();
    }
  });

  test('a new commit on top is stale and counted', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    tell(home, repo, base);
    writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
    git(repo, 'commit', '-q', '-am', 'more one');
    const bridge = await startBridge({ home });
    try {
      const fresh = await freshnessOf(bridge);
      assert.equal(fresh.state, 'stale');
      assert.equal(fresh.rewritten, false);
      assert.equal(fresh.newer, 1);
      assert.deepEqual(fresh.changed_files, ['one.txt']);
    } finally {
      await bridge.close();
    }
  });

  test('a rebase onto a moved main with the same patch (its @@ lines shifted) is current', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    git(repo, 'branch', 'main', base);
    tell(home, repo, 'main'); // told over `main`, which is still at the base commit
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(path.join(repo, 'one.txt'), 'top\na\nb\nc\n');
    git(repo, 'commit', '-q', '-am', 'main prepends to one.txt');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');
    const bridge = await startBridge({ home });
    try {
      const fresh = await freshnessOf(bridge);
      assert.equal(fresh.state, 'current', JSON.stringify(fresh));
      assert.deepEqual(fresh.changed_files, []);
    } finally {
      await bridge.close();
    }
  });

  test('a story that landed in its base is current, never stale', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    git(repo, 'branch', 'main', base);
    tell(home, repo, 'main', 'feature'); // pinned to the branch
    amendTwo(repo);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'feature'); // deployed: main is the branch now
    git(repo, 'checkout', '-q', 'feature');
    const bridge = await startBridge({ home });
    try {
      const fresh = await freshnessOf(bridge);
      assert.equal(fresh.state, 'current', JSON.stringify(fresh));
    } finally {
      await bridge.close();
    }
  });

  test('a told commit git cannot read is unknown', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base);
    const meta = metaOf(made.dir);
    writeJson(path.join(made.dir, 'meta.json'), { ...meta, told_head_oid: 'e'.repeat(40) });
    amendTwo(repo);
    const bridge = await startBridge({ home });
    try {
      const fresh = await freshnessOf(bridge);
      assert.equal(fresh.state, 'unknown');
      assert.match(String(fresh.error), /told/);
    } finally {
      await bridge.close();
    }
  });

  test('telling again with no chapters keeps the commit the chapters were told over', () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base);
    const told = metaOf(made.dir).told_head_oid;
    amendTwo(repo);
    createLocalStory({ home, repo, base, id: STORY });
    const meta = metaOf(made.dir);
    assert.equal(meta.told_head_oid, told);
    assert.notEqual(meta.head_oid, told, 'the diff followed the amend');
  });
});

describe('what the agent review found', () => {
  test('a pinned story (--head <branch>) says the same thing in since, the read marks and freshness', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base, 'feature');
    const headA = git(repo, 'rev-parse', 'HEAD');
    const bridge = await startBridge({ home });
    try {
      const story = (await bridge.call<StoryData>('GET', `/api/stories/${STORY}`)).body;
      for (const [i, chapter] of story.chapters.entries()) {
        await bridge.call('POST', `/api/stories/${STORY}/read`, {
          chapter: chapter.key,
          step: i + 1,
          reason: 'time',
        });
      }
      amendTwo(repo);
      const headB = git(repo, 'rev-parse', 'HEAD');
      assert.equal((await freshnessOf(bridge)).state, 'stale');
      const reads = (
        await bridge.call<{ changed: { step: number; files: string[] }[] }>(
          'GET',
          `/api/stories/${STORY}/read`,
        )
      ).body;
      assert.deepEqual(
        reads.changed.map((change) => [change.step, change.files]),
        [[2, ['lib/two.js']]],
      );
      const report = JSON.parse((await runCli(home, ['since', '--story', STORY, '--json'])).stdout);
      assert.equal(report.head, headB, 'since ends at where the branch is now');
      assert.equal(report.since_sha, headA);
      assert.deepEqual(report.changed_files, ['lib/two.js']);

      // the chapter written from `since` is accepted when the story is told again over the branch
      assert.equal((await bridge.call('POST', `/api/stories/${STORY}/update`, {})).status, 200);
      const kept = JSON.parse(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8'));
      const file = path.join(tmp('plan'), 'chapters.json');
      writeJson(file, {
        ...kept,
        chapters: [
          {
            key: `since-${headA.slice(0, 7)}-${headB.slice(0, 7)}`,
            title: 'Since you read it: 1 new commit',
            since: { from: report.since_sha, to: report.head, commits: report.commits },
            narrative: '### Since you read it\n\nTwo is now 3.',
            files: ['lib/two.js'],
            refs: [],
            comments: [],
          },
          ...kept.chapters,
        ],
      });
      const told = await runCli(home, [
        'local',
        '--repo',
        repo,
        '--base',
        base,
        '--head',
        'feature',
        '--id',
        STORY,
        '--chapters',
        file,
        '--no-open',
        '--no-serve',
        '--port',
        '1',
      ]);
      assert.equal(told.code, 0, told.stderr);
      assert.equal((await freshnessOf(bridge)).state, 'current');
    } finally {
      await bridge.close();
    }
  });

  test('a binary file whose bytes change makes the story stale', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add img');
    const chapters = path.join(tmp('chapters'), 'chapters.json');
    writeJson(chapters, {
      title: 'The change',
      chapters: [
        { title: 'Chapter 1: Change', files: ['one.txt', 'img.bin'], refs: [] },
        { title: 'Chapter 2: Add two', files: ['lib/two.js', 'gone.txt'], refs: [] },
      ],
    });
    createLocalStory({ home, repo, base, head: 'HEAD', id: STORY, chapters });
    const bridge = await startBridge({ home });
    try {
      assert.equal((await freshnessOf(bridge)).state, 'current');
      writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 9, 9, 9, 0, 5]));
      git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
      const fresh = await freshnessOf(bridge);
      assert.equal(fresh.state, 'stale', JSON.stringify(fresh));
      assert.deepEqual(fresh.changed_files, ['img.bin']);
    } finally {
      await bridge.close();
    }
  });

  test('a comment on a file renamed since it was read is flagged stale', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const chapters = path.join(tmp('chapters'), 'chapters.json');
    writeJson(chapters, {
      title: 'The change',
      chapters: [
        {
          title: 'Chapter 1: Change one',
          files: ['one.txt'],
          refs: [],
          comments: [{ path: 'one.txt', line: 2, body: 'why B?' }],
        },
        { title: 'Chapter 2: Add two', files: ['lib/two.js', 'gone.txt'], refs: [] },
      ],
    });
    createLocalStory({ home, repo, base, head: 'HEAD', id: STORY, chapters });
    const bridge = await startBridge({ home });
    try {
      const story = (await bridge.call<StoryData>('GET', `/api/stories/${STORY}`)).body;
      await bridge.call('POST', `/api/stories/${STORY}/read`, {
        chapter: story.chapters[0].key,
        step: 1,
        reason: 'time',
      });
      git(repo, 'mv', 'one.txt', 'uno.txt');
      git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
      const reads = (
        await bridge.call<{ stale_comments: { path: string }[] }>(
          'GET',
          `/api/stories/${STORY}/read`,
        )
      ).body;
      assert.deepEqual(
        reads.stale_comments.map((comment) => comment.path),
        ['one.txt'],
      );
    } finally {
      await bridge.close();
    }
  });
});

describe('Update on a local story', () => {
  test('reading at A, amending to B: the update is asked from the read head, handed over, vetted and settled', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base);
    const headA = git(repo, 'rev-parse', 'HEAD');
    const bridge = await startBridge({ home });
    try {
      const story = (await bridge.call<StoryData>('GET', `/api/stories/${STORY}`)).body;
      for (const [i, chapter] of story.chapters.entries()) {
        await bridge.call('POST', `/api/stories/${STORY}/read`, {
          chapter: chapter.key,
          step: i + 1,
          reason: 'time',
        });
      }
      amendTwo(repo);
      const headB = git(repo, 'rev-parse', 'HEAD');
      assert.equal((await freshnessOf(bridge)).state, 'stale');

      // what changed since they read: chapter 2 only
      const reads = (
        await bridge.call<{ changed: { step: number; files: string[] }[] }>(
          'GET',
          `/api/stories/${STORY}/read`,
        )
      ).body;
      assert.deepEqual(
        reads.changed.map((change) => [change.step, change.files]),
        [[2, ['lib/two.js']]],
      );

      const asked = await bridge.call('POST', `/api/stories/${STORY}/update`, {});
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const build = new Builds(home).all()[`story:${STORY}`];
      assert.equal(build.mode, 'update');
      assert.equal(build.kind, 'local');
      assert.equal(build.story, STORY);
      assert.equal(build.base_sha, headA);
      assert.equal(build.since_sha, headA);
      assert.equal(build.since_source, 'read');
      assert.equal(build.reads!.length, 2);
      assert.equal(path.basename(build.local!.repo_path as string), path.basename(repo));

      const handed = new Builds(home).toHand('story-local-update', { story: STORY, live: [] });
      assert.equal(handed.length, 1);
      assert.equal(handed[0].mode, 'update');
      assert.match(handed[0].text, /Update the story for the local story local-update/);
      assert.match(handed[0].text, new RegExp(headA.slice(0, 7)));

      const retell = (plan: object) => {
        const file = path.join(tmp('plan'), 'chapters.json');
        writeJson(file, plan);
        return runCli(home, [
          'local',
          '--repo',
          repo,
          '--base',
          base,
          '--id',
          STORY,
          '--chapters',
          file,
          '--no-open',
          '--no-serve',
          '--port',
          '1',
        ]);
      };
      const old = JSON.parse(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8'));
      const since = {
        key: `since-${headA.slice(0, 7)}-${headB.slice(0, 7)}`,
        title: 'Since you read it: 1 new commit',
        since: { from: headA, to: headB, commits: 1 },
        narrative: '### Since you read it\n\nTwo is now 3.',
        files: ['lib/two.js'],
        refs: [],
        comments: [],
      };
      const before = readFileSync(path.join(made.dir, 'chapters.json'), 'utf8');

      // a kept chapter that changed, and a since chapter that stops short, are refused
      const edited = structuredClone(old);
      edited.chapters[0].summary = 'changed';
      let refused = await retell({ ...old, chapters: [since, ...edited.chapters] });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /changed/);
      refused = await retell({
        ...old,
        chapters: [{ ...since, since: { ...since.since, to: headA } }, ...old.chapters],
      });
      assert.notEqual(refused.code, 0);
      assert.equal(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8'), before);
      assert.equal(new Builds(home).all()[`story:${STORY}`].status, 'pending');
      assert.equal(metaOf(made.dir).told_head_oid, headA);

      const ok = await retell({ ...old, chapters: [since, ...old.chapters] });
      assert.equal(ok.code, 0, ok.stderr);
      assert.match(ok.stderr, /Since you read it/);
      assert.equal(new Builds(home).all()[`story:${STORY}`].status, 'done');
      assert.equal(metaOf(made.dir).told_head_oid, headB);
      assert.equal((await freshnessOf(bridge)).state, 'current');
    } finally {
      await bridge.close();
    }
  });

  test('a plain re-tell replaces a pending Update instead of being blocked by it', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const made = tell(home, repo, base);
    const bridge = await startBridge({ home });
    try {
      amendTwo(repo);
      assert.equal((await bridge.call('POST', `/api/stories/${STORY}/update`, {})).status, 200);
      assert.equal(new Builds(home).all()[`story:${STORY}`].status, 'pending');
      const file = path.join(tmp('plan'), 'chapters.json');
      writeJson(file, JSON.parse(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8')));
      const told = await runCli(home, [
        'local',
        '--repo',
        repo,
        '--base',
        base,
        '--id',
        STORY,
        '--chapters',
        file,
        '--no-open',
        '--no-serve',
        '--port',
        '1',
      ]);
      assert.equal(told.code, 0, told.stderr);
      assert.equal(new Builds(home).all()[`story:${STORY}`].status, 'done');
      assert.equal(metaOf(made.dir).told_head_oid, git(repo, 'rev-parse', 'HEAD'));
      assert.equal((await freshnessOf(bridge)).state, 'current');
    } finally {
      await bridge.close();
    }
  });

  test('with no reads the update starts at the told head, and Re-tell stays a rebuild request', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    tell(home, repo, base);
    amendTwo(repo);
    const bridge = await startBridge({ home });
    try {
      const asked = await bridge.call('POST', `/api/stories/${STORY}/update`, {});
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const build = new Builds(home).all()[`story:${STORY}`];
      assert.equal(build.since_source, 'story', 'no reads: the story told head');
      const rebuilt = await bridge.call('POST', `/api/stories/${STORY}/rebuild`, {
        mode: 'rebuild',
      });
      assert.equal(rebuilt.status, 200);
    } finally {
      await bridge.close();
    }
  });

  test('a read keeps its base, so a rebase onto a moved main with the same patch changes nothing since it', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    git(repo, 'branch', 'main', base);
    tell(home, repo, 'main');
    const bridge = await startBridge({ home });
    try {
      const story = (await bridge.call<StoryData>('GET', `/api/stories/${STORY}`)).body;
      const read = (
        await bridge.call<{ base_sha?: string }>('POST', `/api/stories/${STORY}/read`, {
          chapter: story.chapters[0].key,
          step: 1,
          reason: 'time',
        })
      ).body;
      assert.equal(read.base_sha, base);
      git(repo, 'checkout', '-q', 'main');
      writeFileSync(path.join(repo, 'one.txt'), 'top\na\nb\nc\n');
      git(repo, 'commit', '-q', '-am', 'main prepends to one.txt');
      git(repo, 'checkout', '-q', 'feature');
      git(repo, 'rebase', '-q', 'main');
      const reads = (
        await bridge.call<{ changed: unknown[]; error: string | null }>(
          'GET',
          `/api/stories/${STORY}/read`,
        )
      ).body;
      assert.deepEqual(reads.changed, []);
      assert.equal(reads.error, null);
    } finally {
      await bridge.close();
    }
  });
});
