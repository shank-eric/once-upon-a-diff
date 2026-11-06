import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './panel-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Section } = await import('../src/components/section.ts');

const { root, tick } = dom;
const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
};
const box = () => root.querySelector('details') as HTMLDetailsElement;

test('a Section is a details with its class, a summary holding the heading, and its children after it', async () => {
  const view = (open: boolean) =>
    html`<${Section} class="ou-filesbox" open=${open} onToggle=${() => {}} summary=${html`<h2 class="ou-h">Files</h2>`}><ul class="ou-files"><li>a.ts</li></ul></${Section}>`;
  await draw(view(false));
  assert.equal(
    root.innerHTML,
    '<details class="ou-filesbox"><summary><h2 class="ou-h">Files</h2></summary><ul class="ou-files"><li>a.ts</li></ul></details>',
  );
  assert.equal(box().hasAttribute('open'), false);
  await draw(view(true));
  assert.equal(box().hasAttribute('open'), true);
  assert.equal(box().querySelector('summary')?.nextElementSibling?.className, 'ou-files');
});

test('a Section opens and closes, and tells onToggle each time', async () => {
  const seen: boolean[] = [];
  await draw(
    html`<${Section} class="ou-drafts ou-allc" open=${false} onToggle=${(event: Event) => seen.push((event.currentTarget as Element).hasAttribute('open'))} summary="All"><p>body</p></${Section}>`,
  );
  assert.equal(box().className, 'ou-drafts ou-allc');
  box().setAttribute('open', '');
  box().dispatchEvent(new dom.window.Event('toggle'));
  box().removeAttribute('open');
  box().dispatchEvent(new dom.window.Event('toggle'));
  assert.deepEqual(seen, [true, false]);
});
