import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, mountApp, settle, store } from './local-env.ts';

const { page } = await import('../public/local/page.ts');

type Notes = {
  id: string;
  at: string;
  path: string;
  side: 'R';
  line: number;
  body: string;
  sent?: unknown;
  fixed?: unknown;
}[];
const note = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    at: '2026-11-05T10:00:00Z',
    path: 'a.ts',
    side: 'R' as const,
    line: 1,
    body: 'fix it',
    ...over,
  }) as Notes[number];
let sends = 0;
let current: Awaited<ReturnType<typeof mountApp>> | null = null;

async function draw(notes: Notes, panelOpen = true) {
  current?.unmount();
  page.overlay = panelOpen
    ? ({
        sendFixes: async () => {
          sends++;
        },
      } as never)
    : null;
  current = await mountApp({ notes }, { panelOpen });
  return current.host;
}
const sendButton = () => document.querySelector('.ou-local-send') as HTMLButtonElement;
test.afterEach(() => {
  current?.unmount();
  current = null;
});

test('the top section has a Send button beside the Fix before push toggle and Approve', async () => {
  const host = await draw([note('n1')]);
  const top = host.querySelector('.ou-local-top')!;
  const labels = [...top.querySelectorAll('button')].map((button) => button.className);
  assert.ok(labels.indexOf('ou-local-send') > labels.indexOf('ou-local-notes-toggle'));
  assert.ok(labels.indexOf('ou-local-send') < labels.indexOf('ou-local-approve'));
});

test('Send counts the notes still to send, and is on', async () => {
  await draw([
    note('n1'),
    note('n2'),
    note('n3', { sent: { to: 'a' } }),
    note('n4', { fixed: {} }),
  ]);
  assert.equal(sendButton().textContent, 'Send 2 notes');
  assert.equal(sendButton().hasAttribute('disabled'), false);
});

test('Send is off with nothing to send', async () => {
  await draw([]);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  await draw([note('n1', { sent: { to: 'a' } }), note('n2', { fixed: {} })]);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  assert.equal(sendButton().textContent, 'Send');
});

test('Send is off while the panel that sends is closed, and comes on with it', async () => {
  await draw([note('n1')], false);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  page.overlay = { sendFixes: async () => {} } as never;
  store.set({ panelOpen: true });
  await settle();
  assert.equal(sendButton().hasAttribute('disabled'), false);
});

test("a click runs the panel's own send once, and does nothing with the panel closed", async () => {
  await draw([note('n1')]);
  sends = 0;
  sendButton().click();
  await settle();
  assert.equal(sends, 1);
  page.overlay = null;
  sendButton().click(); // closed panel: nothing to send through
  await settle();
  assert.equal(sends, 1);
});
