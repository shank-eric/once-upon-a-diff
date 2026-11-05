import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  document,
  askedOn,
  box,
  button,
  commit,
  fire,
  goButton,
  isOn,
  refuse,
  reply,
  requests,
  settle,
  submitGo,
  held,
  story,
  text,
  window,
} from './local-env.ts';

const { page } = await import('../public/local/page.ts');
const { openPushBox } = await import('../public/local/ship/push.ts');

const view = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/widgets',
  branch: 'main',
  approved_sha: 'a1b2c3d4e5'.padEnd(40, '0'),
  approved_at: '2026-11-04T10:00:00Z',
  later: 0,
  remote: { state: 'ahead', sha: 'f'.repeat(40) },
  to_push: [commit('a1b2c3d4e5', 'Fix the thing'), commit('9999999', 'Another')],
  protection: { state: 'open' },
  blocker: null,
  pr_instead: false,
  ...over,
});

const open = async () => {
  openPushBox();
  await settle();
};
const close = () => button('Cancel')?.click();

test.beforeEach(() => {
  requests.length = 0;
  page.story = story({ ship: 'push', approved: { at: 'x', head_oid: 'a'.repeat(40) } });
  reply('GET push', view());
});
test.afterEach(() => {
  // close what a test left open the way a reviewer would, so nothing is left drawn to close later
  (button('Cancel') ?? button('Close'))?.click();
  box()?.parentElement?.remove();
});

test('the box opens as a modal and says where origin stands, then offers Push', async () => {
  openPushBox();
  assert.match(text(), /Checking where GitHub's branch stands/);
  await settle();
  assert.ok(box()?.hasAttribute('open'), 'shown as a modal');
  assert.match(text(), /Push to main/);
  assert.match(text(), /acme\/widgets: the approved commit a1b2c3d goes straight to origin\/main/);
  assert.match(text(), /GitHub's main is behind\. Pushing sends 2 commits/);
  assert.match(text(), /a1b2c3d Fix the thing/);
  assert.ok(isOn(goButton()));
  assert.equal(goButton().textContent, 'Push');
});

test('Push sends the approved commit, says what happened with git’s lines, and becomes a disabled Done', async () => {
  reply('POST push', { output: 'main -> main' });
  let pushed = 0;
  window.addEventListener('ou-pushed', () => pushed++);
  await open();
  submitGo();
  await settle();
  assert.deepEqual(askedOn('POST push')[0].body, {
    action: 'push',
    head_sha: 'a1b2c3d4e5'.padEnd(40, '0'),
  });
  assert.match(text(), /Pushed a1b2c3d to main\./);
  assert.match(text(), /main -> main/);
  assert.equal(goButton().textContent, 'Done');
  assert.ok(!isOn(goButton()), 'a second click has nothing to do');
  assert.equal(page.story.local.approved, null, 'the page no longer holds the approval');
  assert.equal(pushed, 1, 'the page was told');
});

test('a storyless review pushes the head its diff shows', async () => {
  page.story = story({ ship: 'push', storyless: true });
  reply('POST push', { output: '' });
  await open();
  assert.match(text(), /the commit shown/);
  submitGo();
  await settle();
  assert.equal((askedOn('POST push')[0].body as { head_sha: string }).head_sha, 'b'.repeat(40));
});

test('Cancel takes the box away', async () => {
  await open();
  close();
  assert.equal(box(), null);
});

test('a click on the backdrop and Escape close it, a click inside does not', async () => {
  await open();
  fire(box()!.querySelector('h2')!, 'click');
  assert.ok(box(), 'a click inside stays');
  fire(box()!, 'click');
  assert.equal(box(), null, 'the backdrop closes');
  await open();
  (box() as unknown as { close: () => void }).close(); // Escape: the browser closes the dialog and says so
  assert.equal(box(), null);
});

test("when GitHub can't be checked the box says so and offers Close", async () => {
  reply('GET push', refuse('gh is not logged in'));
  await open();
  assert.match(text(), /Couldn't check the branch: gh is not logged in/);
  assert.equal(button('Cancel'), undefined);
  button('Close')!.click();
  assert.equal(box(), null);
});

test('a push that fails shows the reason, turns Push back on, and a retry goes through', async () => {
  const waiting = held();
  reply('POST push', waiting.answer);
  await open();
  submitGo();
  await settle();
  assert.ok(!isOn(goButton()), 'off while it works');
  assert.match(text(), /Pushing to main…/);
  waiting.release(refuse('remote rejected'));
  await settle();
  assert.match(text(), /The push didn't go through\./);
  assert.match(text(), /remote rejected/);
  assert.ok(isOn(goButton()));
  assert.equal(goButton().textContent, 'Push');
  reply('POST push', { output: '' });
  submitGo();
  await settle();
  assert.match(text(), /Pushed a1b2c3d to main\./);
  assert.equal(askedOn('POST push').length, 2);
});

test('a blocker is shown and Push stays off', async () => {
  reply('GET push', view({ blocker: 'main is protected' }));
  await open();
  assert.match(text(), /main is protected/);
  assert.ok(!isOn(goButton()));
  fire(box()!.querySelector('form')!, 'submit');
  await settle();
  assert.equal(askedOn('POST push').length, 0, 'Enter in the form does not push either');
});

test('later commits that stay local are said', async () => {
  reply('GET push', view({ later: 1 }));
  await open();
  assert.match(text(), /1 later commit on your main isn't approved and stay local\./);
});

test('when a pull request goes around the blocker, the box offers Create pull request and hands over to it', async () => {
  reply('GET push', view({ blocker: 'main needs a pull request', pr_instead: true }));
  reply('GET pr', {
    repo: 'acme/widgets',
    branch: 'work',
    base: 'main',
    head_sha: 'c'.repeat(40),
    remote: { state: 'missing', sha: null },
    to_push: [],
    draft: null,
    pull: null,
  });
  await open();
  button('Create pull request')!.click();
  await settle();
  assert.match(text(), /^Create pull request/);
  assert.match(text(), /acme\/widgets: work into/);
  assert.equal(document_boxes(), 1, 'one box at a time');
  assert.equal(button('Push and open on GitHub') !== undefined, true);
});

const document_boxes = () => document.querySelectorAll('#ou-local-pr-box').length;

test('a read-only link is told where to open the story, and nothing is asked of the bridge', async () => {
  page.story = story({ ship: 'push' });
  page.story.read_only = true;
  await open();
  assert.match(text(), /read-only link, which can read the story but not push\./);
  assert.match(text(), /once-upon page --story story-1/);
  assert.equal(askedOn('GET push').length, 0);
  button('Close')!.click();
  assert.equal(box(), null);
});

test('opening a second box closes the first', async () => {
  await open();
  await open();
  assert.equal(document_boxes(), 1);
});

test('closing a box gives focus back to the button that opened it, by Cancel and by the hand-over to the PR box', async () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  await open();
  assert.equal(
    document.activeElement === opener,
    true,
    'the shim keeps focus until the reviewer moves it',
  );
  button('Cancel')!.click();
  assert.equal(document.activeElement, opener);
  reply('GET push', view({ blocker: 'main needs a pull request', pr_instead: true }));
  reply('GET pr', {
    repo: 'acme/widgets',
    branch: 'work',
    base: 'main',
    head_sha: 'c'.repeat(40),
    remote: { state: 'missing', sha: null },
    to_push: [],
    draft: null,
    pull: null,
  });
  await open();
  button('Create pull request')!.click();
  await settle();
  button('Cancel')!.click();
  assert.equal(document.activeElement, opener, 'the PR box returns it too');
  opener.remove();
});
