import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmp, githubStory, startBridge, runCli, writeJson, TOKEN } from './helpers.ts';
import { pageKey } from '../src/server/page-key.ts';
import type { Pulse } from '@once-upon-a-diff/shared/types';

const STORY = 'acme-widgets-7';
const CONSUMER = `story-${STORY}`;

/** A home with the story, and a story listener idle window of `seconds`. */
function homeWith(seconds: number): string {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), {
    port: 0,
    token: TOKEN,
    story_listener_idle_minutes: seconds / 60,
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
    'question,build_request,fix_request',
    '--consumer',
    CONSUMER,
    ...extra,
  ]);

const seenFile = (home: string) => path.join(home, 'state', STORY, 'seen.json');
const markSeen = (home: string) => writeJson(seenFile(home), { at: new Date().toISOString() });

describe("a story listener's natural end", () => {
  test('a story wait stops itself once no page has shown the story for the idle window', async () => {
    const home = homeWith(1);
    const started = Date.now();
    const result = await storyWait(home, '--timeout', '20');
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Stopped listening for acme-widgets-7: no page has shown the story for 1 second/,
    );
    assert.match(result.stdout, /Don't start this wait again/);
    assert.ok(Date.now() - started < 15000);
  });

  test('--json prints a listen_stopped event', async () => {
    const home = homeWith(1);
    const result = await storyWait(home, '--timeout', '20', '--json');
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.type, 'listen_stopped');
    assert.equal(event.story, STORY);
  });

  test('a page showing the story keeps it listening', async () => {
    const home = homeWith(2);
    markSeen(home);
    const keepSeen = setInterval(() => markSeen(home), 500);
    try {
      const result = await storyWait(home, '--timeout', '5');
      assert.equal(result.code, 2, result.stdout); // ran into --timeout, didn't stop itself
    } finally {
      clearInterval(keepSeen);
    }
  });

  test("it doesn't stop with a fix request in hand, or with --no-auto-stop", async () => {
    const home = homeWith(1);
    writeJson(path.join(home, 'fixes.json'), {
      f_held: {
        id: 'f_held',
        story: STORY,
        repo: 'acme/widgets',
        kind: 'github',
        notes: [],
        to: CONSUMER,
        claimed_by: CONSUMER,
        requested_at: new Date().toISOString(),
        status: 'pending',
      },
    });
    const held = await storyWait(home, '--timeout', '4');
    assert.equal(held.code, 2, held.stdout);

    const optedOut = await storyWait(homeWith(1), '--timeout', '4', '--no-auto-stop');
    assert.equal(optedOut.code, 2, optedOut.stdout);
  });

  test("a repo wait doesn't stop on its own", async () => {
    const home = homeWith(1);
    const result = await runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '4']);
    assert.equal(result.code, 2, result.stdout);
  });

  test("the panel's pulse notes that a page shows the story", async () => {
    const home = homeWith(60);
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
    const home = homeWith(60);
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

  test("a story wait doesn't stop while a hidden tab keeps sending still-open signals, and stops once they end", async () => {
    const home = homeWith(2);
    const bridge = await startBridge({ home });
    const signal = () => bridge.call('POST', `/api/stories/${STORY}/seen`, {});
    await signal();
    const keepOpen = setInterval(signal, 500);
    try {
      const running = await storyWait(home, '--timeout', '5');
      assert.equal(running.code, 2, running.stdout); // ran into --timeout, didn't stop itself
    } finally {
      clearInterval(keepOpen);
    }
    try {
      // the tab closed: the signals end and the window runs out
      const stopped = await storyWait(home, '--timeout', '20');
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.match(stopped.stdout, /Stopped listening for acme-widgets-7/);
    } finally {
      await bridge.close();
    }
  });
});
