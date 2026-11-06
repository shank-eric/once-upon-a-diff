import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askedOn,
  box,
  commit,
  document,
  mountApp,
  refuse,
  reply,
  requests,
  settle,
  store,
  window,
} from './local-env.ts';

const { page, usage } = await import('../public/local/page.ts');
// the bridge says the usage capture is off, so the counter's timer doesn't keep the process up
reply('POST usage', { on: false });
test.after(() => usage.flush());
reply('GET version', () => ({ version: 'v1' }));

let app: Awaited<ReturnType<typeof mountApp>> | null = null;
async function open(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  page.overlay = { sendFixes: async () => {}, refreshFixes: () => {} } as never;
  // hidden: a redraw does not mount the real panel again
  app = await mountApp(over, { panelOpen: false, hidden: true, ...extra });
  await settle();
}
const one = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const approved = { at: '2026-11-05T10:00:00Z', head_oid: 'a'.repeat(40) };
const pr = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/widgets',
  branch: 'work',
  base: 'main',
  head_sha: 'c'.repeat(40),
  remote: { state: 'same', sha: 'c'.repeat(40) },
  to_push: [],
  draft: null,
  pull: null,
  ...over,
});

test.beforeEach(() => {
  requests.length = 0;
  reply('GET pr', pr());
  store.set({
    ship: { dialog: null, approveFailure: '', hasPull: false, pushedAt: null, prView: null },
  });
});
test.afterEach(() => {
  app?.unmount();
  app = null;
});

test('Approve is off on a read-only link and says why, and a storyless review has none', async () => {
  await open();
  assert.ok(one('.ou-local-approve')!.hasAttribute('disabled') === false);
  app!.unmount();
  const copy = { read_only: true };
  page.overlay = null;
  app = await mountApp({}, { hidden: true });
  store.set({ story: { ...(store.get().story as object), ...copy } as never });
  await settle();
  assert.ok(one('.ou-local-approve')!.hasAttribute('disabled'));
  assert.match(one('.ou-local-approve')!.getAttribute('title')!, /read-only/);
  store.set({
    story: {
      ...(store.get().story as { local: object }),
      local: { ...(store.get().story as { local: object }).local, storyless: true },
    } as never,
  });
  await settle();
  assert.ok(one('.ou-local-approve') === null);
});

test('Approve sends the head the page shows, then shows when and where, with Unapprove', async () => {
  await open();
  reply('POST approve', { approved });
  one('.ou-local-approve')!.click();
  await settle();
  assert.deepEqual(askedOn('POST approve')[0].body, { approved: true, head_sha: 'b'.repeat(40) });
  assert.match(one('.ou-local-approved')!.textContent!, /^Approved at aaaaaaa/);
  reply('POST approve', { approved: null });
  one('.ou-local-unapprove')!.click();
  await settle();
  assert.deepEqual(askedOn('POST approve')[1].body, { approved: false, head_sha: 'b'.repeat(40) });
  assert.ok(one('.ou-local-approve'));
});

test('an Approve the bridge refuses says why beside the button, and the next try clears it', async () => {
  await open();
  reply('POST approve', refuse('the branch moved'));
  one('.ou-local-approve')!.click();
  await settle();
  assert.match(one('.ou-local-top')!.textContent!, /the branch moved/);
  reply('POST approve', { approved });
  one('.ou-local-approve')!.click();
  await settle();
  assert.doesNotMatch(one('.ou-local-top')!.textContent!, /the branch moved/);
});

test('Approve goes once the branch has a PR or the commit is pushed, and stays gone across a reload of the story', async () => {
  await open();
  store.set((state) => ({ ship: { ...state.ship, hasPull: true } }));
  await settle();
  assert.ok(one('.ou-local-approve') === null);
  const { loadStory } = await import('../public/local/actions.ts');
  loadStory(store.get().story as never);
  await settle();
  assert.ok(one('.ou-local-approve') === null, 'a reload does not bring it back');
});

test('Push is off until the story is approved, opens its box when it is, and the header says "Pushed" after', async () => {
  await open({ ship: 'push', branch: 'main' });
  const push = () => one('.ou-local-push')!;
  assert.ok(push().hasAttribute('disabled'));
  assert.match(push().getAttribute('title')!, /Approve the story first/);
  reply('POST approve', { approved });
  one('.ou-local-approve')!.click();
  await settle();
  assert.ok(!push().hasAttribute('disabled'), 'the approval turns it on');
  reply('GET push', {
    repo: 'acme/widgets',
    branch: 'main',
    approved_sha: 'a'.repeat(40),
    approved_at: null,
    later: 0,
    remote: { state: 'ahead', sha: 'f'.repeat(40) },
    to_push: [commit('a1b2c3d', 'x')],
    protection: { state: 'open' },
    blocker: null,
    pr_instead: false,
  });
  reply('POST push', { output: '' });
  push().click();
  await settle();
  assert.ok(box());
  (box()!.querySelector('form') as HTMLElement).dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await settle();
  assert.match(one('.ou-local-push-holder')!.textContent!, /^Pushed aaaaaaa$/);
  assert.ok(one('.ou-local-approve') === null, 'and Approve is gone');
});

test('Create pull request shows on a branch that ships by PR, and opens the box', async () => {
  await open();
  assert.ok(one('.ou-local-pr'));
  assert.ok(one('.ou-local-push') === null);
  one('.ou-local-pr')!.click();
  await settle();
  assert.match(box()!.textContent!, /Create pull request/);
});

test('no Create pull request where Push ships it, or on a detached head', async () => {
  await open({ ship: 'push' });
  assert.ok(one('.ou-local-pr') === null && one('.ou-local-pr-link') === null);
  app!.unmount();
  await open({ branch: null });
  assert.ok(one('.ou-local-pr') === null);
});

test('the look for a PR at start turns the button into Open PR #N and takes Approve away', async () => {
  reply('GET pr', pr({ pull: { number: 7, url: 'https://github.com/acme/widgets/pull/7' } }));
  await open();
  const link = one('.ou-local-pr-link') as HTMLAnchorElement;
  assert.equal(link.textContent, 'Open PR #7');
  assert.equal(link.getAttribute('href'), 'https://github.com/acme/widgets/pull/7');
  assert.ok(one('.ou-local-approve') === null);
  assert.ok(one('.ou-local-pr') === null);
});

test('a branch that is ahead of its PR shows how far and a Push for it, which opens its box', async () => {
  reply(
    'GET pr',
    pr({
      pull: { number: 7, url: 'u' },
      remote: { state: 'ahead', sha: 'f'.repeat(40) },
      to_push: [commit('a1', 'one'), commit('b2', 'two')],
    }),
  );
  await open();
  assert.equal(one('.ou-local-ahead')!.textContent, '2 commits ahead');
  one('.ou-local-push-ahead')!.click();
  await settle();
  assert.match(box()!.textContent!, /Push work/);
});

test('the page follows the story while the panel is closed, and stops when it is taken away', async () => {
  await open();
  const looks = () => askedOn('GET version').length;
  assert.ok(looks() >= 1, 'a closed panel looks for a new version at once');
  app!.unmount();
  app = null;
  const before = looks();
  window.dispatchEvent(new window.Event('focus'));
  await settle();
  assert.equal(looks(), before, 'no look after the page is gone');
});

test('Show story is there while the reviewer has the panel closed', async () => {
  await open();
  assert.ok(one('.ou-local-reopen'));
  app!.unmount();
  page.overlay = null;
  app = await mountApp({}, { hidden: false, panelOpen: true });
  assert.ok(one('.ou-local-reopen') === null, 'not before the panel mounts, nor while it is open');
});
