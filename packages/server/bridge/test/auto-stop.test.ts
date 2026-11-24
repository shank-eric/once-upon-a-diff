import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmp, githubStory, startBridge, runCli, writeJson, TOKEN } from './helpers.ts';
import { listeners } from '@once-upon-a-diff/state/records/listeners/listeners';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import type { Pulse } from '@once-upon-a-diff/contracts/types';

const STORY = 'acme-widgets-7';
const CONSUMER = `story-${STORY}`;

/**
 * A home with the story. `oldStoryWindow` (seconds) writes the retired story_listener_idle_minutes, which main stopped a
 * story wait by; `repoWindow` (seconds) is the repo wait's idle window.
 */
function homeWith({
  oldStoryWindow,
  repoWindow,
}: { oldStoryWindow?: number; repoWindow?: number } = {}): string {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), {
    port: 0,
    token: TOKEN,
    ...(oldStoryWindow !== undefined && { story_listener_idle_minutes: oldStoryWindow / 60 }),
    ...(repoWindow !== undefined && { listen_idle_minutes: repoWindow / 60 }),
  });
  githubStory(path.join(home, STORY));
  return home;
}

const storyWait = (home: string, ...extra: string[]) =>
  runCli(home, [
    'wait',
    '--story',
    STORY,
    '--type',
    'question,build_request,fix_request,approved',
    '--consumer',
    CONSUMER,
    ...extra,
  ]);

const seenFile = (home: string) => path.join(home, 'state', STORY, 'seen.json');
const markSeen = (home: string) => writeJson(seenFile(home), { at: new Date().toISOString() });
const repoWait = (home: string, ...extra: string[]) =>
  runCli(home, ['wait', '--repo', 'acme/widgets', ...extra]);

describe('a story listener has no idle stop', { concurrency: 6 }, () => {
  test('a story wait that no page shows keeps waiting until it is handed an approval', async () => {
    // the old window is 1 second: main stopped this wait that long after its start, with no page showing the story
    const home = homeWith({ oldStoryWindow: 1 });
    const waiting = storyWait(home, '--timeout', '30');
    // no page ever shows the story (no seen.json): the wait is still there well after its first look, then hears the approval
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(existsSync(seenFile(home)), false);
    assert.equal(
      listeners(home).filter((entry) => entry.live).length,
      1,
      'the story listener is still listening',
    );
    new Inbox(home).append({
      type: 'approved',
      id: 'ap_while_waiting',
      at: new Date().toISOString(),
      story: STORY,
      repo: 'acme/widgets',
      branch: 'ou-cache',
      checkout: '/work/widgets-worktrees/ou-cache',
      base: 'main',
      head_sha: 'c'.repeat(40),
    });
    const result = await waiting;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /approved acme-widgets-7: ready to ship/);
  });

  test('a story wait stops itself only when its story is deleted', async () => {
    const home = homeWith();
    const waiting = storyWait(home, '--timeout', '30');
    while (!existsSync(path.join(home, 'listeners', `${CONSUMER}.json`))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    rmSync(path.join(home, STORY), { recursive: true });
    const result = await waiting;
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Stopped listening for acme-widgets-7: the story is no longer there/,
    );
  });
});

describe(
  'a story wait ends once the story is approved, and a flag keeps it',
  { concurrency: 6 },
  () => {
    test('a story wait on an approved story stops with that reason', async () => {
      const home = homeWith();
      writeJson(path.join(home, STORY, 'meta.json'), {
        kind: 'local',
        repo: 'acme/widgets',
        head_oid: 'c'.repeat(40),
      });
      writeJson(path.join(home, 'state', STORY, 'review.json'), {
        approval: { at: new Date().toISOString(), head_oid: 'c'.repeat(40), base_oid: null },
      });
      const result = await storyWait(home, '--timeout', '20');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Stopped listening for acme-widgets-7: the story is approved/);
    });

    for (const flag of ['--keep', '--no-auto-stop']) {
      test(`${flag} keeps a story wait going after its story is deleted`, async () => {
        const home = homeWith();
        const waiting = storyWait(home, flag, '--timeout', '4');
        while (!existsSync(path.join(home, 'listeners', `${CONSUMER}.json`))) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        rmSync(path.join(home, STORY), { recursive: true });
        const result = await waiting;
        assert.equal(result.code, 2, result.stdout); // ran into --timeout, didn't stop itself
      });
    }
  },
);

describe("the pages' signal that a story is shown", { concurrency: 6 }, () => {
  test("the panel's pulse notes that a page shows the story", async () => {
    const home = homeWith();
    githubStory(path.join(home, 'other')); // another story that exists, so its key is a good key out of place
    const bridge = await startBridge({ home });
    try {
      assert.equal(existsSync(seenFile(home)), false);
      const pulse = await bridge.call<Pulse>('GET', `/api/stories/${STORY}/pulse`);
      assert.equal(pulse.status, 200);
      assert.equal(existsSync(seenFile(home)), true);
    } finally {
      await bridge.close();
    }
  });

  test("a hidden tab's still-open signal notes the story as seen, and nothing else", async () => {
    const home = homeWith();
    githubStory(path.join(home, 'other')); // another story that exists, so its key is a good key out of place
    const bridge = await startBridge({ home });
    try {
      assert.equal(existsSync(seenFile(home)), false);
      const first = await bridge.call('POST', `/api/stories/${STORY}/seen`, {});
      assert.equal(first.status, 200, first.text);
      const seenAt = (): number => Date.parse(JSON.parse(readFileSync(seenFile(home), 'utf8')).at);
      const before = seenAt();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await bridge.call('POST', `/api/stories/${STORY}/seen`, {})).status, 200);
      assert.ok(seenAt() > before, 'every signal refreshes seen.json');
      // nothing else moved: no position, no reads, and the story's own files are as they were
      assert.deepEqual(readdirSync(path.join(home, 'state', STORY)).sort(), ['seen.json']);
      // it is a story route: another story's key can't send it, a read-only key can
      assert.equal(
        (
          await bridge.call(
            'POST',
            `/api/stories/${STORY}/seen`,
            {},
            {
              Authorization: `Bearer ${pageKey(TOKEN, 'other')}`,
            },
          )
        ).status,
        403,
      );
    } finally {
      await bridge.close();
    }
  });

  test('a page showing a story keeps the repo listener listening', async () => {
    const home = homeWith({ repoWindow: 2 });
    markSeen(home);
    const keepSeen = setInterval(() => markSeen(home), 500);
    try {
      const result = await repoWait(home, '--timeout', '5');
      assert.equal(result.code, 2, result.stdout); // ran into --timeout, didn't stop itself
    } finally {
      clearInterval(keepSeen);
    }
  });

  test("a repo wait doesn't stop while a hidden tab keeps sending still-open signals, and stops once they end", async () => {
    const home = homeWith({ repoWindow: 2 });
    const bridge = await startBridge({ home });
    const signal = () => bridge.call('POST', `/api/stories/${STORY}/seen`, {});
    await signal();
    const keepOpen = setInterval(signal, 500);
    try {
      const running = await repoWait(home, '--timeout', '5');
      assert.equal(running.code, 2, running.stdout); // ran into --timeout, didn't stop itself
    } finally {
      clearInterval(keepOpen);
    }
    try {
      // the tab closed: the signals end and the window runs out
      const stopped = await repoWait(home, '--timeout', '20');
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.match(stopped.stdout, /Stopped listening for acme\/widgets/);
    } finally {
      await bridge.close();
    }
  });
});
