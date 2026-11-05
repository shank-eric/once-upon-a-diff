import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askedOn,
  box,
  button,
  commit,
  document,
  openBox,
  closeBox,
  current,
  setStory,
  fire,
  goButton,
  held,
  isOn,
  refuse,
  reply,
  requests,
  settle,
  story,
  submitGo,
  text,
} from './local-env.ts';

const view = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/widgets',
  branch: 'work',
  base: 'main',
  head_sha: 'c'.repeat(40),
  remote: { state: 'ahead', sha: 'd'.repeat(40) },
  to_push: [commit('c0ffee1', 'A fix after review')],
  draft: null,
  pull: { number: 42, url: 'https://github.com/acme/widgets/pull/42' },
  ...over,
});

const open = async () => {
  openBox('push-ahead');
  await settle();
};

test.beforeEach(() => {
  requests.length = 0;
  setStory(story());
  reply('GET pr', view());
});
test.afterEach(() => {
  closeBox();
});

test('the box opens, lists the commits GitHub lacks and links the open PR', async () => {
  openBox('push-ahead');
  assert.match(text(), /Checking where GitHub's branch stands/);
  await settle();
  assert.match(text(), /Push work/);
  assert.match(text(), /work goes to origin\/work as a fast-forward/);
  assert.match(text(), /GitHub's work is behind\. Pushing sends 1 commit/);
  assert.match(text(), /c0ffee1 A fix after review/);
  const link = box()!.querySelector('a')!;
  assert.equal(link.getAttribute('href'), 'https://github.com/acme/widgets/pull/42');
  assert.equal(link.textContent, '#42');
  assert.ok(isOn(goButton()));
});

test('Push fast-forwards the branch, says so with git’s lines, and becomes a disabled Done', async () => {
  const waiting = held();
  reply('POST pr', waiting.answer);
  await open();
  submitGo();
  await settle();
  assert.match(text(), /Pushing work…/);
  assert.ok(!isOn(goButton()));
  waiting.release(() => ({ output: 'work -> work', view: view({ remote: { state: 'same' } }) }));
  await settle();
  assert.deepEqual(askedOn('POST pr')[0].body, { action: 'push-ahead', head_sha: 'c'.repeat(40) });
  assert.match(text(), /Pushed work\./);
  assert.match(text(), /work -> work/);
  assert.equal(goButton().textContent, 'Done');
  assert.ok(!isOn(goButton()));
});

test('Cancel, the backdrop and Escape close it', async () => {
  await open();
  button('Cancel')!.click();
  await settle();
  assert.ok(box() === null);
  await open();
  fire(box()!, 'click');
  await settle();
  assert.ok(box() === null);
  await open();
  (box() as unknown as { close: () => void }).close();
  await settle();
  assert.ok(box() === null);
});

test("when the branch can't be checked the box says so and offers Close", async () => {
  reply('GET pr', refuse('origin unreachable'));
  await open();
  assert.match(text(), /Couldn't check the branch: origin unreachable/);
  button('Close')!.click();
  await settle();
  assert.ok(box() === null);
});

test('a push that fails shows the reason and turns Push back on', async () => {
  reply('POST pr', refuse('rejected: not a fast-forward'));
  await open();
  submitGo();
  await settle();
  assert.match(text(), /The push didn't go through\./);
  assert.match(text(), /rejected: not a fast-forward/);
  assert.ok(isOn(goButton()));
});

test('each state that cannot push says why and keeps Push off', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ repo: null }, /isn't a GitHub repo/],
    [{ pull: null }, /has no open PR here: use Create pull request/],
    [{ head_sha: null }, /No branch to push/],
    [{ remote: { state: 'diverged', sha: null } }, /has commits this checkout doesn't/],
    [{ remote: { state: 'unreachable', sha: null, error: 'timeout' } }, /timeout/],
    [{ remote: { state: 'missing', sha: null } }, /origin has no work/],
    [{ remote: { state: 'same', sha: 'c'.repeat(40) } }, /up to date: nothing to push/],
  ];
  for (const [over, says] of cases) {
    reply('GET pr', view(over));
    await open();
    assert.match(text(), says);
    assert.ok(!isOn(goButton()), JSON.stringify(over));
    fire(box()!.querySelector('form')!, 'submit');
    await settle();
    assert.equal(askedOn('POST pr').length, 0);
    button('Cancel')!.click();
    await settle();
  }
});

test('a read-only link is told where to open the story, and nothing is asked of the bridge', async () => {
  (current() as { read_only: boolean }).read_only = true;
  await open();
  assert.match(text(), /read-only link, which can read the story but not push\./);
  assert.match(text(), /once-upon page --story story-1/);
  assert.equal(askedOn('GET pr').length, 0);
  button('Close')!.click();
  await settle();
  assert.equal(document.getElementById('ou-local-pr-box'), null);
});
