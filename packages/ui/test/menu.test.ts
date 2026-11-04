import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, fire } from './preact-env.ts';
const { openMenu, closeMenu } = await import('../src/menu.ts');

const items = [
  { value: 'a', label: 'Alpha', detail: 'idle 5m' },
  { value: 'b', label: 'Beta', checked: true },
];
const anchor = document.createElement('button');
document.body.appendChild(anchor);
const menu = () => document.querySelector('.ou-menu') as HTMLElement | null;
const labels = () =>
  [...document.querySelectorAll('.ou-menu-item')].map((item) =>
    item.textContent?.replace(/\s+/g, ' ').trim(),
  );

test('a menu lists the items with their details and the checked one ticked, and opens under its button', () => {
  openMenu(anchor, items, () => {}, { label: 'Sessions' });
  assert.equal(menu()?.getAttribute('aria-label'), 'Sessions');
  assert.deepEqual(labels(), ['Alphaidle 5m', '✓ Beta']);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  closeMenu();
  assert.equal(menu(), null);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
});

test('a click on an item picks its value and closes the menu', () => {
  const picked: string[] = [];
  openMenu(anchor, items, (value) => picked.push(value));
  fire(document.querySelectorAll('.ou-menu-item')[1], 'click');
  assert.deepEqual(picked, ['b']);
  assert.equal(menu(), null);
});

test('a second click on the button closes it, and Escape closes it too', () => {
  openMenu(anchor, items, () => {});
  openMenu(anchor, items, () => {});
  assert.equal(menu(), null, 'the button that opened it closes it');
  openMenu(anchor, items, () => {});
  const escape = new (document.defaultView as Window & typeof globalThis).Event('keydown', {
    bubbles: true,
  });
  Object.assign(escape, { key: 'Escape' });
  document.dispatchEvent(escape);
  assert.equal(menu(), null);
});
