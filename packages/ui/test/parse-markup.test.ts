import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick } from './preact-env.ts';
const { html, render, h } = await import('/assets/preact.mjs');
const { parseMarkup } = await import('../src/parse-markup.ts');
import type { VNode } from '../src/parse-markup.ts';

const draw = async (nodes: unknown[]) => {
  render(html`<div>${nodes}</div>`, root);
  await tick();
  return root.firstElementChild as HTMLElement;
};

test('markup becomes nodes: elements, text and attributes, with the boolean ones true', async () => {
  const div = await draw(
    parseMarkup('<p class="a">one <b>two</b></p><details open><summary>s</summary></details>'),
  );
  assert.equal(div.innerHTML.includes('<p class="a">one <b>two</b></p>'), true);
  assert.ok(div.querySelector('details')?.hasAttribute('open'));
  assert.deepEqual(parseMarkup(''), []);
  assert.deepEqual(parseMarkup(null), []);
});

test('markup is read, never run: a script or an on-handler in it comes out as inert text or an attribute string', async () => {
  const div = await draw(parseMarkup('<p>&lt;script&gt;x()&lt;/script&gt;</p>'));
  assert.equal(div.querySelector('script'), null);
  assert.equal(div.textContent, '<script>x()</script>');
});

test('the element hook may change an element’s props or answer a node of its own', async () => {
  let clicks = 0;
  const div = await draw(
    parseMarkup('<a href="/x">go</a><button class="mark">m</button>', {
      element(tag, props) {
        if (tag === 'a') {
          props.onClick = () => void clicks++;
        }
        if (tag === 'button') {
          return h('b', { class: 'mine' }, 'replaced') as VNode;
        }
      },
    }),
  );
  assert.equal(div.querySelector('.mine')?.textContent, 'replaced');
  assert.equal(div.querySelector('button'), null);
  (div.querySelector('a') as HTMLElement).click();
  assert.equal(clicks, 1);
});
