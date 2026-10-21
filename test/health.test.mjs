import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmp, githubStory, startBridge } from './helpers.mjs';
import { beat, listeners, cliCommand, listenPrompt } from '../bridge/lib/health.mjs';
import { doctor } from '../bridge/lib/doctor.mjs';

test('a fresh waiting beat counts as listening, a stale one or a dead process does not, and a handling beat lasts longer', () => {
  const home = tmp('home');
  beat(home, 'pr-story', 'waiting');
  assert.equal(listeners(home)[0].live, true);
  assert.equal(listeners(home, Date.now() + 16000)[0].live, false, 'a waiting beat goes stale after 15s');
  mkdirSync(path.join(home, 'listeners'), { recursive: true });
  writeFileSync(path.join(home, 'listeners', 'gone.json'), JSON.stringify({ consumer: 'gone', pid: 999999, state: 'waiting', at: new Date().toISOString() }));
  assert.equal(listeners(home).find(l => l.consumer === 'gone').live, false, 'a dead process is not listening');
  beat(home, 'busy', 'handling', { question: 'q_1' });
  assert.equal(listeners(home, Date.now() + 5 * 60000).find(l => l.consumer === 'busy').live, true, 'answering counts for a while');
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
    assert.match(st.listening.start, /diff-story wait/);
    assert.deepEqual(st.autoBuild, { enabled: false });
    assert.deepEqual(st.autoAnswer, { enabled: false });
    assert.equal((await b.call('GET', '/api/status?story=nope')).body.story.ok, false);
    beat(home, 'pr-story');
    st = (await b.call('GET', '/api/status?repo=acme/widgets&number=7')).body;
    assert.equal(st.listening.ok, true);
    assert.equal(st.story.id, 'acme-widgets-7');
    assert.equal((await b.call('GET', '/api/status', undefined, { Authorization: 'Bearer wrong' })).status, 401);
    await b.call('GET', '/api/health', undefined, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    assert.ok(existsSync(path.join(home, 'extension-seen.json')), 'the bridge notes when the extension talks to it');
  } finally { await b.close(); }
});

test('autoAnswer, when on, answers a question from the command\'s stdout with the chapter context', async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const script = `const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write('Chapter: ' + c.chapter.title + '; asked: ' + c.question.text)`;
  const b = await startBridge({ home, autoAnswer: { enabled: true, command: [process.execPath, '-e', script, '{context}'] } });
  try {
    assert.equal((await b.call('GET', '/api/status')).body.autoAnswer.enabled, true);
    const q = (await b.call('POST', '/api/stories/acme-widgets-7/questions', { text: 'why?', step: 1 })).body;
    let answers = [];
    for (let i = 0; i < 60 && !answers.length; i++) {
      await new Promise(r => setTimeout(r, 50));
      answers = (await b.call('GET', '/api/stories/acme-widgets-7/questions')).body.questions.find(x => x.id === q.id).answers;
    }
    assert.equal(answers[0].text, 'Chapter: Chapter 1: Start; asked: why?');
  } finally { await b.close(); }
});

test('doctor reports a missing bridge as failing, with the fix', async () => {
  const home = tmp('home');
  const lines = [];
  const ok = await doctor(home, { token: 't', port: 1 }, { out: l => lines.push(l) });
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
    await doctor(home, { token: 'test-token-0123456789abcdef', port: b.server.address().port }, { out: l => lines.push(l) });
    assert.match(lines.join('\n'), /PASS\s+Bridge: running on 127\.0\.0\.1:\d+, version/);
  } finally { await b.close(); }
});

test('Copy prompt for Claude: one wait for questions and build requests, and how to answer and build', async () => {
  const p = listenPrompt('diff-story');
  assert.equal(p.command, 'diff-story wait --type question,build_request --consumer pr-story');
  assert.match(p.prompt, /^Run `diff-story wait --type question,build_request --consumer pr-story` as a background task, and start it again each time it exits\./);
  assert.match(p.prompt, /`diff-story answer --question <id> --text "<answer>"`/);
  assert.match(p.prompt, /\/pr-story <PR url>/);
  assert.match(p.prompt, /`diff-story done <id>`/);

  assert.equal(cliCommand(true), 'diff-story');
  const full = cliCommand(false);
  assert.ok(full.startsWith(process.execPath), 'off PATH it names node by full path');
  assert.match(full, /\/bridge\/bin\/diff-story\.mjs$/);
  assert.match(listenPrompt(full).prompt, /diff-story\.mjs done <id>/);

  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const b = await startBridge({ home });
  try {
    const l = (await b.call('GET', '/api/status?story=acme-widgets-7')).body.listening;
    assert.match(l.command, /wait --type question,build_request --consumer pr-story$/);
    assert.ok(l.prompt.includes(l.command));
    assert.equal((await b.call('GET', '/api/status')).body.listening.command, l.command, 'the same prompt with no story, for Build story');
    const many = (await b.call('POST', '/api/stories/status-many', { prs: [{ repo: 'acme/widgets', number: 7 }] })).body;
    assert.equal(many.listening.ok, false, 'PR-list badges learn whether anyone is listening');
    assert.equal(many.listening.prompt, l.prompt);
    beat(home, 'pr-story');
    assert.equal((await b.call('POST', '/api/stories/status-many', { prs: [] })).body.listening.ok, true);
  } finally { await b.close(); }
});
