import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Meter, ContextMeter } = await import('../src/components/meter.ts');
const { Chip, Chips } = await import('../src/components/chip.ts');
const { chipClass } = await import('../src/components/chip-class.ts');

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

test('a chip carries its mark in front of its text, and a row of chips takes a class of its own', async () => {
  await draw(
    html`<${Chips} class="ou-board-gates" items=${['plain one', { text: 'passing', mark: 'ok' }, { text: 'failing', mark: 'bad' }, { text: 'careful', mark: 'warn' }, { text: 'quiet', mark: 'plain' }]} />`,
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

test('chipClass names the look: size, tone, tint (only where a tone has one), weight, then the host class', () => {
  assert.equal(chipClass(), 'ou-ui-chip');
  assert.equal(chipClass({ size: 'md' }), 'ou-ui-chip');
  assert.equal(
    chipClass({ tone: 'attention', tint: true, strong: true, size: 'lg', class: 'mine' }),
    'ou-ui-chip ou-ui-chip-lg ou-ui-tone-attention ou-ui-tint-attention ou-ui-chip-strong mine',
  );
  assert.equal(chipClass({ tone: 'success', tint: true }), 'ou-ui-chip ou-ui-tone-success');
  assert.equal(chipClass({ tint: true }), 'ou-ui-chip');
  assert.equal(
    chipClass({ tone: 'inherit', size: 'sm' }),
    'ou-ui-chip ou-ui-chip-sm ou-ui-tone-inherit',
  );
});

test('a chip is a span or a button, wears its look, and passes the rest to its element', async () => {
  await draw(
    html`<${Chip} tone="accent" tint strong size="sm" class="ou-new" title="t">New</${Chip}>`,
  );
  const span = root.querySelector('span') as HTMLElement;
  assert.equal(
    span.className,
    'ou-ui-chip ou-ui-chip-sm ou-ui-tone-accent ou-ui-tint-accent ou-ui-chip-strong ou-new',
  );
  assert.equal(span.getAttribute('title'), 't');
  await draw(html`<${Chip} mark="ok">done</${Chip}>`);
  assert.equal((root.querySelector('span') as HTMLElement).textContent, '✓ done');
  let clicked = 0;
  await draw(
    html`<${Chip} as="button" tone="inherit" data-mark-for="a.ts" onClick=${() => clicked++}>go</${Chip}>`,
  );
  const button = root.querySelector('button') as HTMLElement;
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.getAttribute('data-mark-for'), 'a.ts');
  button.click();
  assert.equal(clicked, 1);
  assert.equal(button.className, 'ou-ui-chip ou-ui-tone-inherit');
});
