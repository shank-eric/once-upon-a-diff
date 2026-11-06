import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Busy } = await import('../src/components/busy.ts');
const { LinkButton } = await import('../src/components/link-button.ts');
const { Banner } = await import('../src/components/banner.ts');

const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
  return root;
};

test('Busy is a status line with a spinner in front of its text', async () => {
  await draw(html`<${Busy}>Working <i>now</i></${Busy}>`);
  const busy = root.querySelector('.ou-ui-busy') as HTMLElement;
  assert.equal(busy.tagName, 'SPAN');
  assert.equal(busy.getAttribute('role'), 'status');
  assert.equal(busy.firstElementChild?.className, 'ou-ui-spin');
  assert.equal(busy.firstElementChild?.getAttribute('aria-hidden'), 'true');
  assert.equal(busy.textContent, 'Working now');
});

test('LinkButton is a button with its own class, and every other prop goes to it as given', async () => {
  const clicks: string[] = [];
  const extra = { 'data-goto': '3', title: 'Go' };
  await draw(
    html`<${LinkButton} type="button" data-qa-act="read" ...${extra} disabled=${false} onClick=${() => clicks.push('read')}>Mark read</${LinkButton}>`,
  );
  const button = root.querySelector('button') as HTMLButtonElement;
  assert.equal(button.className, 'ou-ui-linkish');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.getAttribute('data-qa-act'), 'read');
  assert.equal(button.getAttribute('data-goto'), '3');
  assert.equal(button.getAttribute('title'), 'Go');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Mark read');
  fire(button, 'click');
  assert.deepEqual(clicks, ['read']);
  await draw(html`<${LinkButton} disabled=${true}>Take back</${LinkButton}>`);
  assert.equal((root.querySelector('button') as HTMLButtonElement).disabled, true);
});

test('Banner carries its tone, adds the host class after its own, and passes other props through', async () => {
  await draw(html`<${Banner} tone="accent">Since <b>you</b> read it</${Banner}>`);
  assert.equal(root.querySelector('div')?.className, 'ou-ui-banner ou-ui-banner-accent');
  assert.equal(root.querySelector('b')?.textContent, 'you');
  await draw(
    html`<${Banner} tone="warn" class="ou-beingchg" role="status">Being changed</${Banner}>`,
  );
  const banner = root.querySelector('div') as HTMLElement;
  assert.equal(banner.className, 'ou-ui-banner ou-ui-banner-warn ou-beingchg');
  assert.equal(banner.getAttribute('role'), 'status');
  assert.equal(document.querySelectorAll('.ou-ui-banner').length, 1);
  await draw(html`<${Banner} tone="muted">Standing</${Banner}>`);
  assert.equal(root.querySelector('div')?.className, 'ou-ui-banner ou-ui-banner-muted');
});
