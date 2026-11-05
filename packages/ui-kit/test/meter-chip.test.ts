import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Meter, ContextMeter } = await import('../src/components/meter.ts');
const { Chip, Chips } = await import('../src/components/chip.ts');

const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
  return root;
};

test('a meter shows its label and its percent, clamped, and warns from 70% and 90%', async () => {
  await draw(html`<${Meter} label="5h" percent=${42.4} title="used" />`);
  const meter = root.querySelector('.ou-ui-meter') as HTMLElement;
  assert.equal(meter.getAttribute('role'), 'meter');
  assert.equal(meter.getAttribute('aria-valuenow'), '42');
  assert.equal(meter.className, 'ou-ui-meter');
  assert.equal(root.querySelector('.ou-ui-meter-num')?.textContent, '42%');
  assert.equal(root.querySelector('.ou-ui-meter-bar span')?.getAttribute('style'), 'width:42%');
  await draw(html`<${Meter} label="5h" percent=${70} title="t" />`);
  assert.equal(root.querySelector('.ou-ui-meter')?.className, 'ou-ui-meter ou-ui-usage-warn');
  await draw(html`<${Meter} label="5h" percent=${240} title="t">${html`<i>more</i>`}</${Meter}>`);
  assert.equal(root.querySelector('.ou-ui-meter')?.className, 'ou-ui-meter ou-ui-usage-high');
  assert.equal(root.querySelector('.ou-ui-meter-num')?.textContent, '100%');
  assert.equal(root.querySelector('.ou-ui-meter i')?.textContent, 'more');
});

test('a context meter draws only when the context is a number', async () => {
  await draw(html`<${ContextMeter} context=${null} />`);
  assert.equal(root.querySelector('.ou-ui-meter'), null);
  await draw(html`<${ContextMeter} context=${63} />`);
  assert.equal(root.querySelector('.ou-ui-meter')?.getAttribute('aria-label'), 'ctx');
  assert.match(root.querySelector('.ou-ui-meter')?.getAttribute('title') ?? '', /63% full/);
});

test('a chip carries its mark in front of its tone, and a row of chips takes a class of its own', async () => {
  await draw(
    html`<${Chips} class="ou-board-gates" items=${['plain one', { text: 'passing', tone: 'ok' }, { text: 'failing', tone: 'bad' }, { text: 'careful', tone: 'warn' }, { text: 'quiet', tone: 'plain' }]} />`,
  );
  const row = root.querySelector('.ou-ui-chips') as HTMLElement;
  assert.equal(row.className, 'ou-ui-chips ou-board-gates');
  assert.deepEqual(
    [...row.querySelectorAll('.ou-ui-chip')].map((chip) => chip.textContent),
    ['plain one', '✓ passing', '! failing', '! careful', 'quiet'],
  );
  await draw(html`<${Chips} items=${['x']} />`);
  assert.equal(root.querySelector('.ou-ui-chips')?.className, 'ou-ui-chips');
  await draw(html`<${Chip}>alone</${Chip}>`);
  assert.equal(document.querySelectorAll('.ou-ui-chip').length, 1);
});
