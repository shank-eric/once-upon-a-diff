import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmp, githubStory, startBridge, git } from './helpers.mjs';
import os from 'node:os';
import { beat, listeners, cliCommand, listenPrompt } from '../bridge/listeners/listeners.mjs';
import {
  repoOfCheckout,
  repoOfRemote,
  checkoutFor,
  seenCheckout,
} from '../bridge/config/repos.mjs';
import { doctor } from '../bridge/cli/doctor.mjs';

test('a fresh waiting beat counts as listening, a stale one or a dead process does not, and a handling beat lasts longer', () => {
  const home = tmp('home');
  beat(home, 'pr-story', 'waiting');
  assert.equal(listeners(home)[0].live, true);
  assert.equal(
    listeners(home, Date.now() + 16000)[0].live,
    false,
    'a waiting beat goes stale after 15s',
  );
  mkdirSync(path.join(home, 'listeners'), { recursive: true });
  writeFileSync(
    path.join(home, 'listeners', 'gone.json'),
    JSON.stringify({
      consumer: 'gone',
      pid: 999999,
      state: 'waiting',
      at: new Date().toISOString(),
    }),
  );
  assert.equal(
    listeners(home).find((listener) => listener.consumer === 'gone').live,
    false,
    'a dead process is not listening',
  );
  beat(home, 'busy', 'handling', { question: 'q_1' });
  assert.equal(
    listeners(home, Date.now() + 5 * 60000).find((listener) => listener.consumer === 'busy').live,
    true,
    'answering counts for a while',
  );
});

test('/api/status reports the bridge, the story and listening', async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    let status = (await bridge.call('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(status.bridge.ok, true);
    assert.deepEqual(status.story, { ok: true, id: 'acme-widgets-7' });
    assert.equal(status.listening.ok, false);
    assert.match(status.listening.start, /diff-story-listen/);
    assert.equal((await bridge.call('GET', '/api/status?story=nope')).body.story.ok, false);
    beat(home, 'pr-story');
    status = (await bridge.call('GET', '/api/status?repo=acme/widgets&number=7')).body;
    assert.equal(status.listening.ok, true);
    assert.equal(status.story.id, 'acme-widgets-7');
    assert.equal(
      (await bridge.call('GET', '/api/status', undefined, { Authorization: 'Bearer wrong' }))
        .status,
      401,
    );
    await bridge.call('GET', '/api/health', undefined, {
      Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
    assert.ok(
      existsSync(path.join(home, 'extension-seen.json')),
      'the bridge notes when the extension talks to it',
    );
  } finally {
    await bridge.close();
  }
});

test('doctor reports a missing bridge as failing, with the fix', async () => {
  const home = tmp('home');
  const lines = [];
  const ok = await doctor(home, { token: 't', port: 1 }, { out: (line) => lines.push(line) });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /FAIL\s+Bridge: nothing is listening on 127\.0\.0\.1:1/);
  assert.match(text, /fix: Start it: diff-story serve/);
  assert.match(text, /WARN\s+Claude listening/);
});

test('doctor passes the bridge when it is up', async () => {
  const home = tmp('home');
  const bridge = await startBridge({ home });
  try {
    const lines = [];
    await doctor(
      home,
      { token: 'test-token-0123456789abcdef', port: bridge.server.address().port },
      { out: (line) => lines.push(line) },
    );
    assert.match(lines.join('\n'), /PASS\s+Bridge: running on 127\.0\.0\.1:\d+, version/);
  } finally {
    await bridge.close();
  }
});

test('Copy prompt for Claude: one short skill line naming the repo, with the long form behind it', async () => {
  const prompt = listenPrompt(
    { repo: 'octo-org/api-server', checkout: path.join(os.homedir(), 'Development', 'api-server') },
    'diff-story',
  );
  assert.equal(prompt.prompt, '/diff-story-listen octo-org/api-server');
  assert.equal(prompt.command, 'diff-story wait --repo octo-org/api-server');
  assert.equal(prompt.checkout, '~/Development/api-server');
  assert.match(
    prompt.details,
    /^In ~\/Development\/api-server, run `diff-story wait --repo octo-org\/api-server` as a background task/,
  );
  for (const bit of [
    'diff-story answer --question <id>',
    'diff-story builds --start <id>',
    '/pr-story <PR url>',
    'diff-story done <id>',
  ]) {
    assert.ok(prompt.details.includes(bit), bit);
  }
  assert.equal(
    listenPrompt({ story: 'local-x' }, 'diff-story').prompt,
    '/diff-story-listen --story local-x',
    '--story still works, for a story with no GitHub repo',
  );
  assert.match(
    listenPrompt({ repo: 'a/b' }, 'diff-story').details,
    /^In your checkout of a\/b, run/,
  );

  assert.equal(cliCommand(true), 'diff-story');
  const full = cliCommand(false);
  assert.ok(full.startsWith(process.execPath), 'off PATH it names node by full path');
  assert.match(full, /\/bridge\/bin\/diff-story\.mjs$/);

  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    let status = (await bridge.call('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(status.repo, 'acme/widgets', "the page's repo comes from its story");
    assert.equal(status.listening.prompt, '/diff-story-listen acme/widgets');
    beat(home, 'repo-acme-gadgets', 'waiting', { repo: 'acme/gadgets' });
    assert.equal(
      (await bridge.call('GET', '/api/status?story=acme-widgets-7')).body.listening.ok,
      false,
      "another repo's listener doesn't count",
    );
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'ACME/Widgets' });
    status = (await bridge.call('GET', '/api/status?repo=acme/widgets&number=99')).body;
    assert.equal(status.listening.ok, true, 'a PR page with no story, by ?repo=');
    assert.equal(status.listening.consumers[0].repo, 'ACME/Widgets');
  } finally {
    await bridge.close();
  }
});

test('the checkout to work from: one the bridge has seen, else ~/Development/<name> if its origin matches', async () => {
  const home = tmp('home');
  const dev = tmp('dev');
  const repo = path.join(dev, 'api-server');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:octo-org/api-server.git');
  assert.equal(repoOfCheckout(repo), 'octo-org/api-server');
  assert.equal(checkoutFor(home, 'octo-org/api-server', { dev }), repo);
  assert.equal(checkoutFor(home, 'octo-org/nope', { dev }), null);
  const worktree = tmp('wt');
  seenCheckout(home, 'octo-org/api-server', worktree);
  assert.equal(
    checkoutFor(home, 'octo-org/api-server', { dev }),
    worktree,
    'a seen checkout comes first',
  );
  assert.equal(repoOfRemote('https://github.com/octo-org/web-app.git'), 'octo-org/web-app');
  assert.equal(repoOfRemote('https://gitlab.com/a/b'), null);
});
