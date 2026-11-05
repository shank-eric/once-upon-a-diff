import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Disclosure } = await import('../src/components/disclosure.ts');

const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
};
const button = () => root.querySelector('button') as HTMLButtonElement;

test('a Disclosure says whether it is open by its glyph and aria-expanded, in a span of its own in front of its text', async () => {
  const toggles: number[] = [];
  const view = (open: boolean) =>
    html`<${Disclosure} open=${open} class="lane" arrowClass="arrow" label="Show a cards" title="Show the a cards" attrs=${{ 'data-lane-toggle': 'x/a' }} onToggle=${() => toggles.push(1)}> a <b>3</b></${Disclosure}>`;
  await draw(view(false));
  assert.equal(button().getAttribute('type'), 'button');
  assert.equal(button().className, 'lane');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.equal(button().getAttribute('aria-label'), 'Show a cards');
  assert.equal(button().getAttribute('title'), 'Show the a cards');
  assert.equal(button().getAttribute('data-lane-toggle'), 'x/a');
  const arrow = button().firstElementChild as HTMLElement;
  assert.equal(arrow.tagName, 'SPAN');
  assert.equal(arrow.className, 'arrow');
  assert.equal(arrow.getAttribute('aria-hidden'), 'true');
  assert.equal(arrow.textContent, '▸');
  assert.equal(button().querySelector('b')?.textContent, '3');
  fire(button(), 'click');
  assert.equal(toggles.length, 1);
  await draw(view(true));
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(button().firstElementChild?.textContent, '▾');
});

test('a bare Disclosure is its glyph and nothing else, and leaves out the attributes it was not given', async () => {
  await draw(
    html`<${Disclosure} bare open=${true} class="ou-qtoggle" title="Collapse" onToggle=${() => {}} />`,
  );
  assert.equal(button().textContent, '▾');
  assert.equal(button().children.length, 0);
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(button().hasAttribute('aria-label'), false);
  await draw(html`<${Disclosure} open=${false} onToggle=${() => {}}>Label</${Disclosure}>`);
  assert.equal(button().hasAttribute('class'), false);
  assert.equal(button().firstElementChild?.hasAttribute('class'), false);
  assert.equal(button().textContent, '▸Label');
});
