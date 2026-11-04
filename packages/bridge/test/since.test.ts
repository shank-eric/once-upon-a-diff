import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, githubStory, startBridge, writeJson, runCli } from './helpers.ts';
import { Builds, buildText } from '../src/services/inbox/builds.ts';
import { noteRead } from '../src/services/stories/reads.ts';
import { clearFreshness } from '../src/services/review/freshness.ts';
import type { Build } from '../src/services/inbox/builds.ts';
import type { StoryData, StoryStatus } from '@once-upon-a-diff/protocol/types';
import type { Plan } from '../src/services/stories/chapters.ts';

/** What POST /api/builds answers. */
type BuildAnswer = { state: string; request: Build };
/** What status-many answers. */
type StatusMany = { results: StoryStatus[] };

process.env.ONCE_UPON_GH = fileURLToPath(import.meta.resolve('./fixtures/fake-gh.ts'));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function story(home: string, head = SHA_A): string {
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir, { meta: { head_oid: head } });
  return dir;
}

test('an update asks for a "Since you read it" chapter from where the reading stopped', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  const SHA_C = 'c'.repeat(40);
  noteRead(home, 'pr-acme-widgets-7', 'finish', {
    head_sha: SHA_C,
    story_head: SHA_C,
    title: 'Chapter 2: Finish',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  noteRead(home, 'pr-acme-widgets-7', 'start', {
    head_sha: SHA_A,
    story_head: SHA_A,
    title: 'Chapter 1: Start',
  });
  const bridge = await startBridge({ home });
  try {
    const result = (
      await bridge.call<BuildAnswer>('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: SHA_A,
      })
    ).body.request;
    assert.deepEqual(
      [result.mode, result.since_sha, result.since_source, result.story, !!result.retell],
      ['update', SHA_C, 'read', 'acme-widgets-7', false],
      'the earliest read was chapter 2, at C',
    );
    assert.deepEqual(result.reads!.map((read) => read.chapter).sort(), ['finish', 'start']);
    const line = new Builds(home).get('acme/widgets', 7)!;
    assert.equal(line.since_sha, SHA_C);
    assert.match(
      buildText(line),
      /"Since you read it" chapter first for ccccccc\.\.the PR's head, where the reviewer's reading stopped/,
    );
    // the wait hands it over with the same fields
    const waited = await runCli(home, [
      'wait',
      '--timeout',
      '1',
      '--json',
      '--repo',
      'acme/widgets',
    ]);
    const e = JSON.parse(waited.stdout.trim().split('\n')[0]);
    assert.deepEqual(
      [e.mode, e.since_sha, e.retell, e.story],
      ['update', SHA_C, false, 'acme-widgets-7'],
    );
    const listed = await runCli(home, ['builds']);
    assert.match(
      listed.stdout,
      /update: "Since you read it" from ccccccc \(where the reviewer's reading stopped; 2 chapters read\)/,
    );
    // display_name in config.json names the reviewer
    writeJson(path.join(home, 'config.json'), {
      ...JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')),
      display_name: 'Sam',
    });
    assert.match(
      (await runCli(home, ['builds'])).stdout,
      /\(where Sam's reading stopped; 2 chapters read\)/,
    );
    assert.equal(JSON.parse((await runCli(home, ['builds', '--json'])).stdout)[0].since_sha, SHA_C);
  } finally {
    await bridge.close();
  }
});

test('with nothing read, an update starts from the story head; Re-tell asks for a new story', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  const bridge = await startBridge({ home });
  try {
    const result = (
      await bridge.call<BuildAnswer>('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: SHA_A,
      })
    ).body.request;
    assert.deepEqual(
      [result.since_sha, result.since_source, result.reads!.length],
      [SHA_A, 'story', 0],
    );
    // still queued: Re-tell from scratch replaces it, and Update (new commits) puts it back
    const retold = (
      await bridge.call<BuildAnswer>('POST', '/api/builds', {
        repo: 'acme/widgets',
        number: 7,
        mode: 'update',
        base_sha: SHA_A,
        retell: true,
      })
    ).body.request;
    assert.equal(retold.id, result.id, 'the same request');
    assert.equal(retold.retell, true);
    assert.match(
      buildText(new Builds(home).get('acme/widgets', 7)!),
      /^Re-tell the story for acme\/widgets#7 from scratch/,
    );
    assert.equal(
      (
        await bridge.call<BuildAnswer>('POST', '/api/builds', {
          repo: 'acme/widgets',
          number: 7,
          mode: 'update',
          base_sha: SHA_A,
        })
      ).body.request.retell,
      undefined,
    );
  } finally {
    await bridge.close();
  }
});

test('once a session has claimed an update, a second click does not change it', () => {
  const home = tmp('home');
  const builds = new Builds(home);
  const request = builds.request({
    repo: 'acme/widgets',
    number: 7,
    mode: 'update',
    base_sha: SHA_A,
    since: { since_sha: SHA_A, source: 'story', read: [] },
  });
  builds.claim(request.id, 'repo-acme-widgets');
  assert.equal(
    builds.request({
      repo: 'acme/widgets',
      number: 7,
      mode: 'update',
      base_sha: SHA_A,
      retell: true,
    }).retell,
    undefined,
  );
  assert.equal(
    buildText({ repo: 'acme/widgets', number: 7, url: 'u' } as Build),
    'Build a story for acme/widgets#7: u',
  );
});

test("the stories carry a chapter's since range through to the panel", async () => {
  const home = tmp('home');
  const dir = story(home, SHA_B);
  const plan: Plan & { chapters: NonNullable<Plan['chapters']> } = JSON.parse(
    readFileSync(path.join(dir, 'chapters.json'), 'utf8'),
  );
  plan.chapters.unshift({
    key: 'since-aaaaaaa-bbbbbbb',
    title: 'Since you read it: 2 new commits',
    since: { from: SHA_A, to: SHA_B, commits: 2 },
    files: ['src/b.js'],
  });
  plan.chapters.push({
    title: 'Chapter 3: Bad range',
    since: { from: 'nope', to: SHA_B },
    files: ['README.md'],
  });
  writeJson(path.join(dir, 'chapters.json'), plan);
  const bridge = await startBridge({ home });
  try {
    const story = (await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7')).body;
    assert.deepEqual(story.chapters[0].since, { from: SHA_A, to: SHA_B, commits: 2 });
    assert.equal(story.chapters[0].key, 'since-aaaaaaa-bbbbbbb');
    assert.equal(story.chapters[1].since, undefined);
    assert.equal(story.chapters[3].since, undefined, 'a range that is not two commits is dropped');
  } finally {
    await bridge.close();
  }
});

test('status-many reports reads and, when the PR moved on, how many new commits', async () => {
  clearFreshness();
  const home = tmp('home');
  story(home);
  noteRead(home, 'pr-acme-widgets-7', 'start', { story_head: SHA_A });
  const bridge = await startBridge({ home });
  try {
    let result = (
      await bridge.call<StatusMany>('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.deepEqual(result.reads, { read: 1, total: 3, next: 2 });
    assert.deepEqual(
      [result.stale, result.newer],
      [true, 2],
      'the fake PR is at B, two commits on',
    );
    noteRead(home, 'pr-acme-widgets-7', 'finish', { story_head: SHA_A });
    noteRead(home, 'pr-acme-widgets-7', 'not in a chapter yet', { story_head: SHA_A });
    await new Promise((resolve) => setTimeout(resolve, 5100)); // status-many caches 5s
    result = (
      await bridge.call<StatusMany>('POST', '/api/stories/status-many', {
        prs: [{ repo: 'acme/widgets', number: 7 }],
      })
    ).body.results[0];
    assert.deepEqual(result.reads, { read: 3, total: 3, next: null });
    assert.deepEqual([result.stale, result.newer], [true, 2]);
  } finally {
    await bridge.close();
  }
});
