import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

const { document, root, fire, tick, saved } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});

test('installDom sets the globals and a root', () => {
  assert.equal(globalThis.document, document);
  assert.equal(root.id, 'app');
  globalThis.localStorage.setItem('k', 'v');
  assert.equal(saved.get('k'), 'v');
});

test('focus is tracked, and removing the focused node drops it', () => {
  const input = document.createElement('input') as unknown as HTMLElement;
  root.appendChild(input);
  input.focus();
  assert.equal(document.activeElement, input);
  input.blur();
  assert.equal(document.activeElement, document.body);
  input.focus();
  input.remove();
  assert.equal(document.activeElement, document.body);
});

test('a listener runs with this set to the element it is on, and events bubble', async () => {
  const button = document.createElement('button') as unknown as HTMLElement;
  const seen: unknown[] = [];
  root.addEventListener('click', function (this: unknown) {
    seen.push(this);
  });
  root.appendChild(button);
  fire(button, 'click');
  await tick();
  assert.deepEqual(seen, [root]);
});

test('layout is faked: the rect comes from the rect option, items stack 100 apart', () => {
  const first = document.createElement('p') as unknown as HTMLElement;
  const second = document.createElement('p') as unknown as HTMLElement;
  root.append(first, second);
  assert.equal(second.getBoundingClientRect().top - first.getBoundingClientRect().top, 100);
  assert.equal(first.getBoundingClientRect().width, 340);
});

test('a second installDom in the same process is refused', () => {
  assert.throws(
    () => installDom({ html: '<html><body></body></html>', rootId: 'x' }),
    /already called/,
  );
});
