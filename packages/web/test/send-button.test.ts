import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document } from './dom-env.ts';

// the page module reads the address and the boot block when it loads
Object.assign(globalThis, { location: { hash: '#key=k', href: 'http://localhost/#key=k' } });
const boot = document.createElement('script');
boot.id = 'ou-local-boot';
boot.textContent = JSON.stringify({ story: 'story-1' });
document.body.appendChild(boot);

const { page } = await import('../public/local/page.ts');
const { headerHtml } = await import('../public/local/diff-view.ts');
const { redrawSend, sendNotes } = await import('../public/local/send.ts');
const { setHtml } = await import('@once-upon-a-diff/ui/dom');

type Notes = { id: string; sent?: unknown; fixed?: unknown }[];
let sends = 0;

function draw(notes: Notes, panelOpen = true) {
  page.story = {
    title: 'A story',
    read_only: false,
    local: {
      repo: 'acme/widgets',
      base: 'main',
      head: 'work',
      base_oid: 'a'.repeat(40),
      head_oid: 'b'.repeat(40),
      branch: 'work',
      ship: 'pr',
      commits: [],
      files: [],
      notes,
      moved: null,
      approved: null,
      hide_whitespace: false,
      diff_view: 'unified',
    },
    chapters: [],
  } as never;
  page.overlay = panelOpen
    ? ({
        sendFixes: async () => {
          sends++;
        },
      } as never)
    : null;
  const host = document.createElement('div');
  setHtml(host, headerHtml());
  document.body.replaceChildren(boot, host);
  return host;
}
const sendButton = () => document.querySelector('.ou-local-send') as HTMLButtonElement;

test('the top section has a Send button beside the Fix before push toggle and Approve', () => {
  const host = draw([{ id: 'n1' }]);
  const top = host.querySelector('.ou-local-top')!;
  const labels = [...top.querySelectorAll('button')].map((button) => button.className);
  assert.ok(labels.indexOf('ou-local-send') > labels.indexOf('ou-local-notes-toggle'));
  assert.ok(labels.indexOf('ou-local-send') < labels.indexOf('ou-local-approve'));
});

test('Send counts the notes still to send, and is on', () => {
  draw([{ id: 'n1' }, { id: 'n2' }, { id: 'n3', sent: { to: 'a' } }, { id: 'n4', fixed: {} }]);
  assert.equal(sendButton().textContent, 'Send 2 notes');
  assert.equal(sendButton().hasAttribute('disabled'), false);
});

test('Send is off with nothing to send', () => {
  draw([]);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  draw([
    { id: 'n1', sent: { to: 'a' } },
    { id: 'n2', fixed: {} },
  ]);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  assert.equal(sendButton().textContent, 'Send');
});

test('Send is off while the panel that sends is closed, and comes on with it', () => {
  draw([{ id: 'n1' }], false);
  assert.equal(sendButton().hasAttribute('disabled'), true);
  page.overlay = { sendFixes: async () => {} } as never;
  redrawSend();
  assert.equal(sendButton().hasAttribute('disabled'), false);
});

test("a click runs the panel's own send once", async () => {
  draw([{ id: 'n1' }]);
  sends = 0;
  await sendNotes();
  assert.equal(sends, 1);
  page.overlay = null;
  await sendNotes(); // closed panel: nothing to send through
  assert.equal(sends, 1);
});
