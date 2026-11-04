import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { Elapsed } = await import('../src/elapsed.ts');

const NOW = Date.parse('2026-11-04T12:00:00Z');
const realNow = Date.now;
const wait = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay));

test('Elapsed counts up when its clock ticks, in the class it is given', async () => {
  let now = NOW;
  Date.now = () => now;
  const listeners = new Set<() => void>();
  const clock = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  try {
    const since = new Date(NOW - 42_000).toISOString();
    render(html`<${Elapsed} since=${since} clock=${clock} class="ou-elapsed" />`, root);
    const span = root.querySelector('span') as HTMLElement;
    assert.equal(span.className, 'ou-elapsed');
    assert.equal(span.getAttribute('data-since'), since);
    assert.equal(span.textContent, '0:42');
    await wait(150); // Preact runs a component's effects (where it subscribes) after the paint
    now += 3_000;
    listeners.forEach((listener) => listener());
    await tick();
    assert.equal(root.querySelector('span')?.textContent, '0:45');
    render(html`<${Elapsed} since=${since} clock=${clock} />`, root);
    assert.equal(root.querySelector('span')?.className, 'ou-ui-elapsed');
    render(null, root);
    await wait(150);
    assert.equal(listeners.size, 0, 'it stops listening when it goes');
  } finally {
    Date.now = realNow;
  }
});
