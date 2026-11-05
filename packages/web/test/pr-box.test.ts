import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askedOn,
  box,
  button,
  commit,
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
  window,
} from './local-env.ts';

const { page } = await import('../public/local/page.ts');
const { openPrBox } = await import('../public/local/ship/pull-request.ts');

const view = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/widgets',
  branch: 'feature/x y',
  base: 'main',
  head_sha: 'c'.repeat(40),
  remote: { state: 'missing', sha: null },
  to_push: [commit('c0ffee1', 'Add the thing')],
  draft: { title: 'Add the thing', body: 'Why it is needed' },
  pull: null,
  ...over,
});

/** What window.open was asked for, and the tab it handed back. */
const tabs: { url: string; closed: boolean; opener: unknown; location: { href: string } }[] = [];
let popupsBlocked = false;
Object.assign(window, {
  open: (url: string) => {
    if (popupsBlocked) {
      return null;
    }
    const tab = {
      url,
      closed: false,
      opener: 'x',
      location: { href: url },
      close() {
        tab.closed = true;
      },
    };
    tabs.push(tab);
    return tab;
  },
});

const copied: string[] = [];
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (value: string) => void copied.push(value) },
});

const open = async () => {
  openPrBox();
  await settle();
};
const field = (name: string) => box()!.querySelector(`[name="${name}"]`) as HTMLInputElement;

test.beforeEach(() => {
  requests.length = 0;
  tabs.length = 0;
  copied.length = 0;
  popupsBlocked = false;
  page.story = story();
  reply('GET pr', view());
});
test.afterEach(() => {
  box()?.parentElement?.remove();
});

test('the box opens with the base branch, the handed-over title and body, and what a push sends', async () => {
  openPrBox();
  assert.match(text(), /Checking where work stands on GitHub/);
  await settle();
  assert.match(text(), /Create pull request/);
  assert.equal(field('base').value, 'main');
  assert.equal(field('title').value, 'Add the thing');
  assert.equal(field('body').value, 'Why it is needed');
  assert.match(text(), /feature\/x y isn't on GitHub yet\. Pushing sends 1 commit/);
  assert.match(text(), /Title and body handed over by a session/);
  assert.equal(goButton().textContent, 'Push and open on GitHub');
  assert.ok(isOn(goButton()));
});

test('no draft says GitHub fills the fields in, and a branch already on GitHub just opens it', async () => {
  reply('GET pr', view({ draft: null, remote: { state: 'same', sha: 'c'.repeat(40) } }));
  await open();
  assert.match(text(), /No title and body were handed over/);
  assert.equal(field('title').value, '');
  assert.equal(goButton().textContent, 'Open on GitHub');
});

test('Go pushes, opens GitHub’s compare page in the tab it opened on the click, and becomes a disabled Done', async () => {
  const waiting = held();
  reply('POST pr', waiting.answer);
  await open();
  field('base').value = ' develop ';
  field('title').value = 'A better title';
  submitGo();
  assert.equal(tabs.length, 1, 'the tab opens inside the click, before the push is done');
  assert.equal(tabs[0].url, 'about:blank');
  assert.equal(tabs[0].opener, null);
  await settle();
  assert.match(text(), /Pushing feature\/x y…/);
  assert.ok(!isOn(goButton()));
  waiting.release(() => ({ output: 'new branch', view: view({ remote: { state: 'same' } }) }));
  await settle();
  assert.deepEqual(askedOn('POST pr')[0].body, { action: 'push', head_sha: 'c'.repeat(40) });
  assert.equal(
    tabs[0].location.href,
    'https://github.com/acme/widgets/compare/develop...feature/x%20y?expand=1&title=A%20better%20title&body=Why%20it%20is%20needed',
  );
  assert.match(text(), /GitHub's Create pull request page is open in a new tab/);
  assert.match(text(), /new branch/);
  assert.equal(goButton().textContent, 'Done');
  assert.ok(!isOn(goButton()));
});

test('with nothing to push it says nothing about pushing and asks the bridge nothing', async () => {
  reply('GET pr', view({ remote: { state: 'same', sha: 'c'.repeat(40) } }));
  await open();
  submitGo();
  await settle();
  assert.equal(askedOn('POST pr').length, 0);
  assert.equal(tabs[0].location.href.includes('compare/main...feature/x%20y'), true);
  assert.match(text(), /open in a new tab/);
});

test('a browser that blocks the tab gets a link instead', async () => {
  popupsBlocked = true;
  reply('GET pr', view({ remote: { state: 'same', sha: 'c'.repeat(40) } }));
  await open();
  submitGo();
  await settle();
  const link = box()!.querySelector('.ou-local-pr-ok a')!;
  assert.match(link.getAttribute('href')!, /^https:\/\/github\.com\/acme\/widgets\/compare\//);
  assert.match(text(), /Open GitHub's Create pull request page, check it/);
});

test('a body too long for the link is left out of it, and Copy body copies it', async () => {
  const long = 'x'.repeat(8000);
  reply(
    'GET pr',
    view({ draft: { title: 'T', body: long }, remote: { state: 'same', sha: 'c'.repeat(40) } }),
  );
  await open();
  submitGo();
  await settle();
  assert.ok(!tabs[0].location.href.includes('body='));
  assert.match(text(), /The body is too long for the link/);
  button('Copy body')!.click();
  await settle();
  assert.deepEqual(copied, [long]);
  assert.ok(button('Copied'));
});

test('a push that fails closes the tab, shows the reason, keeps what was typed and turns Go back on', async () => {
  reply('POST pr', refuse('remote rejected'));
  await open();
  field('title').value = 'My edited title';
  submitGo();
  await settle();
  assert.equal(tabs[0].closed, true);
  assert.match(text(), /The push didn't go through\./);
  assert.match(text(), /remote rejected/);
  assert.ok(isOn(goButton()));
  assert.equal(field('title').value, 'My edited title', 'the redraw leaves the form alone');
  reply('POST pr', { output: '', view: view({ remote: { state: 'same' } }) });
  submitGo();
  await settle();
  assert.equal(tabs.length, 2);
  assert.match(tabs[1].location.href, /title=My%20edited%20title/);
  assert.equal(goButton().textContent, 'Done');
});

test('a blocker is shown and Go stays off', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ repo: null }, /isn't a GitHub repo/],
    [
      { pull: { number: 7, url: 'https://github.com/acme/widgets/pull/7' } },
      /already has an open PR/,
    ],
    [{ head_sha: null }, /No branch to open a PR from/],
    [{ remote: { state: 'diverged', sha: null } }, /Nothing to do here until that is sorted/],
    [{ remote: { state: 'unreachable', sha: null, error: 'timeout' } }, /Nothing to do here/],
  ];
  for (const [over, says] of cases) {
    reply('GET pr', view(over));
    await open();
    assert.match(text(), says);
    assert.ok(!isOn(goButton()), JSON.stringify(over));
    submitGo();
    await settle();
    assert.equal(tabs.length, 0, 'no tab for a box that cannot go');
    button('Cancel')!.click();
  }
});

test('a PR already open is linked in the box', async () => {
  reply('GET pr', view({ pull: { number: 7, url: 'https://github.com/acme/widgets/pull/7' } }));
  await open();
  assert.equal(box()!.querySelector('.ou-local-pr-standing a')!.textContent, '#7');
});

test('Cancel, the backdrop and Escape close it', async () => {
  await open();
  button('Cancel')!.click();
  assert.equal(box(), null);
  await open();
  fire(box()!, 'click');
  assert.equal(box(), null);
  await open();
  (box() as unknown as { close: () => void }).close();
  assert.equal(box(), null);
});

test("when the branch can't be checked the box says so and offers Close", async () => {
  reply('GET pr', refuse('gh is not logged in'));
  await open();
  assert.match(text(), /Couldn't check the branch: gh is not logged in/);
  button('Close')!.click();
  assert.equal(box(), null);
});

test('a read-only link is told where to open the story, and nothing is asked of the bridge', async () => {
  page.story.read_only = true;
  await open();
  assert.match(text(), /read-only link, which can read the story but not push its branch\./);
  assert.match(text(), /To push and open the PR, open the story from the agent board/);
  assert.match(text(), /once-upon page --story story-1/);
  assert.equal(askedOn('GET pr').length, 0);
  button('Close')!.click();
  assert.equal(box(), null);
});
