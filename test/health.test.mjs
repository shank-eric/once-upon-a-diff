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
import { doctor } from '../bridge/lib/doctor.mjs';

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
    listeners(home).find((l) => l.consumer === 'gone').live,
    false,
    'a dead process is not listening',
  );
  beat(home, 'busy', 'handling', { question: 'q_1' });
  assert.equal(
    listeners(home, Date.now() + 5 * 60000).find((l) => l.consumer === 'busy').live,
    true,
    'answering counts for a while',
  );
});

test('/api/status reports the bridge, the story, listening, and autoBuild/autoAnswer off', async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const b = await startBridge({ home });
  try {
    let st = (await b.call('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(st.bridge.ok, true);
    assert.deepEqual(st.story, { ok: true, id: 'acme-widgets-7' });
    assert.equal(st.listening.ok, false);
    assert.match(st.listening.start, /diff-story-listen/);
    assert.deepEqual(st.autoBuild, { enabled: false });
    assert.deepEqual(st.autoAnswer, { enabled: false });
    assert.equal((await b.call('GET', '/api/status?story=nope')).body.story.ok, false);
    beat(home, 'pr-story');
    st = (await b.call('GET', '/api/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.listening.ok, true);
    assert.equal(st.story.id, 'acme-widgets-7');
    assert.equal(
      (await b.call('GET', '/api/status', undefined, { Authorization: 'Bearer wrong' })).status,
      401,
    );
    await b.call('GET', '/api/health', undefined, {
      Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
    assert.ok(
      existsSync(path.join(home, 'extension-seen.json')),
      'the bridge notes when the extension talks to it',
    );
  } finally {
    await b.close();
  }
});

test("autoAnswer, when on, answers a question from the command's stdout with the chapter context", async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const script = `const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write('Chapter: ' + c.chapter.title + '; asked: ' + c.question.text)`;
  const b = await startBridge({
    home,
    autoAnswer: { enabled: true, command: [process.execPath, '-e', script, '{context}'] },
  });
  try {
    assert.equal((await b.call('GET', '/api/status')).body.autoAnswer.enabled, true);
    const q = (
      await b.call('POST', '/api/stories/acme-widgets-7/questions', { text: 'why?', step: 1 })
    ).body;
    let answers = [];
    for (let i = 0; i < 60 && !answers.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      answers = (await b.call('GET', '/api/stories/acme-widgets-7/questions')).body.questions.find(
        (x) => x.id === q.id,
      ).answers;
    }
    assert.equal(answers[0].text, 'Chapter: Chapter 1: Start; asked: why?');
  } finally {
    await b.close();
  }
});

test('doctor reports a missing bridge as failing, with the fix', async () => {
  const home = tmp('home');
  const lines = [];
  const ok = await doctor(home, { token: 't', port: 1 }, { out: (l) => lines.push(l) });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /FAIL\s+Bridge: nothing is listening on 127\.0\.0\.1:1/);
  assert.match(text, /fix: Start it: diff-story serve/);
  assert.match(text, /WARN\s+Claude listening/);
  assert.match(text, /PASS\s+autoBuild: off/);
});

test('doctor passes the bridge when it is up', async () => {
  const home = tmp('home');
  const b = await startBridge({ home });
  try {
    const lines = [];
    await doctor(
      home,
      { token: 'test-token-0123456789abcdef', port: b.server.address().port },
      { out: (l) => lines.push(l) },
    );
    assert.match(lines.join('\n'), /PASS\s+Bridge: running on 127\.0\.0\.1:\d+, version/);
  } finally {
    await b.close();
  }
});

test('Copy prompt for Claude: one short skill line naming the repo, with the long form behind it', async () => {
  const p = listenPrompt(
    { repo: 'octo-org/api-server', checkout: path.join(os.homedir(), 'Development', 'api-server') },
    'diff-story',
  );
  assert.equal(p.prompt, '/diff-story-listen octo-org/api-server');
  assert.equal(p.command, 'diff-story wait --repo octo-org/api-server');
  assert.equal(p.checkout, '~/Development/api-server');
  assert.match(
    p.details,
    /^In ~\/Development\/api-server, run `diff-story wait --repo octo-org\/api-server` as a background task/,
  );
  for (const bit of [
    'diff-story answer --question <id>',
    'diff-story builds --start <id>',
    '/pr-story <PR url>',
    'diff-story done <id>',
  ]) {
    assert.ok(p.details.includes(bit), bit);
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
  const b = await startBridge({ home });
  try {
    let st = (await b.call('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(st.repo, 'acme/widgets', "the page's repo comes from its story");
    assert.equal(st.listening.prompt, '/diff-story-listen acme/widgets');
    beat(home, 'repo-acme-gadgets', 'waiting', { repo: 'acme/gadgets' });
    assert.equal(
      (await b.call('GET', '/api/status?story=acme-widgets-7')).body.listening.ok,
      false,
      "another repo's listener doesn't count",
    );
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'ACME/Widgets' });
    st = (await b.call('GET', '/api/status?repo=acme/widgets&number=99')).body;
    assert.equal(st.listening.ok, true, 'a PR page with no story, by ?repo=');
    assert.equal(st.listening.consumers[0].repo, 'ACME/Widgets');
  } finally {
    await b.close();
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
  const wt = tmp('wt');
  seenCheckout(home, 'octo-org/api-server', wt);
  assert.equal(
    checkoutFor(home, 'octo-org/api-server', { dev }),
    wt,
    'a seen checkout comes first',
  );
  assert.equal(repoOfRemote('https://github.com/octo-org/web-app.git'), 'octo-org/web-app');
  assert.equal(repoOfRemote('https://gitlab.com/a/b'), null);
});
