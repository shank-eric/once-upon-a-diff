import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { createDrag } = await import('../src/drag.ts');
const { ResizeGrip } = await import('../src/components/resize-grip.ts');

/** A drag on a grip drawn with its handlers, and what it said. */
async function grip(options: { primary?: boolean; refuse?: boolean } = {}) {
  const said: string[] = [];
  const drag = createDrag({
    primary: options.primary,
    onStart: () => (options.refuse ? false : void said.push('start')),
    onMove: (event) => said.push(`move ${event.clientX}`),
    onEnd: () => said.push('end'),
  });
  render(html`<div class="grip" ...${drag.handlers}></div>`, root);
  await tick();
  return { drag, said, element: root.querySelector('.grip') as HTMLElement };
}

test('a press starts a drag (and is not left to select text), moves report the pointer, and a release ends it once', async () => {
  const { drag, said, element } = await grip();
  fire(element, 'pointermove', { clientX: 5 });
  assert.deepEqual(said, [], 'a move before a press does nothing');
  const down = fire(element, 'pointerdown');
  assert.equal(down.defaultPrevented, true);
  assert.equal(drag.active(), true);
  fire(element, 'pointermove', { clientX: 40 });
  fire(element, 'pointermove', { clientX: 50, buttons: 1 });
  fire(element, 'pointerup');
  fire(element, 'lostpointercapture');
  assert.deepEqual(said, ['start', 'move 40', 'move 50', 'end']);
  assert.equal(drag.active(), false);
  fire(element, 'pointermove', { clientX: 60 });
  assert.equal(said.length, 4, 'a move after the end does nothing');
});

test('a drag also ends on a cancel, on lost capture and on a move that says no button is down', async () => {
  for (const [type, fields] of [
    ['pointercancel', {}],
    ['lostpointercapture', {}],
    ['pointermove', { buttons: 0, clientX: 9 }],
  ] as const) {
    const { said, element } = await grip();
    fire(element, 'pointerdown');
    fire(element, type, fields);
    assert.deepEqual(said, ['start', 'end'], type);
  }
});

test('end() ends a drag from outside (the grip went away), and only a drag that is on', async () => {
  const { drag, said, element } = await grip();
  drag.end();
  assert.deepEqual(said, [], 'nothing to end');
  fire(element, 'pointerdown');
  drag.end();
  drag.end();
  assert.deepEqual(said, ['start', 'end']);
});

test('onStart can refuse a drag, and a drag that asks for the primary button ignores the others', async () => {
  const refused = await grip({ refuse: true });
  const down = fire(refused.element, 'pointerdown');
  assert.equal(down.defaultPrevented, false);
  fire(refused.element, 'pointermove', { clientX: 1, buttons: 1 });
  assert.deepEqual(refused.said, []);
  const primary = await grip({ primary: true });
  fire(primary.element, 'pointerdown', { button: 2 });
  assert.equal(primary.drag.active(), false);
  fire(primary.element, 'pointerdown', { button: 0 });
  assert.equal(primary.drag.active(), true);
});

test('a capture that throws still ends the drag, so what onStart marked is cleared', async () => {
  const { said, element, drag } = await grip();
  element.setPointerCapture = () => {
    throw new Error('no such pointer');
  };
  try {
    fire(element, 'pointerdown');
  } catch {
    // the throw may reach the caller or be swallowed by the event system: either way the drag must be over
  }
  assert.deepEqual(said, ['start', 'end']);
  assert.equal(drag.active(), false);
});

test('a ResizeGrip is a keyboard-reachable separator with the drag on it and the caller’s keys', async () => {
  const said: string[] = [];
  const keys: string[] = [];
  const drag = createDrag({ onMove: () => {}, onEnd: () => said.push('end') });
  const ref: { current: HTMLElement | null } = { current: null };
  render(
    html`<${ResizeGrip} class="ou-grip" gripRef=${ref} orientation="vertical" label="Resize the panel" min=${260} title="Drag" drag=${drag} onKeyDown=${(event: KeyboardEvent) => keys.push(event.key)} />`,
    root,
  );
  await tick();
  const element = root.querySelector('div') as HTMLElement;
  assert.equal(ref.current, element);
  assert.equal(element.className, 'ou-grip');
  assert.equal(element.getAttribute('role'), 'separator');
  assert.equal(element.getAttribute('aria-orientation'), 'vertical');
  assert.equal(element.getAttribute('aria-label'), 'Resize the panel');
  assert.equal(element.getAttribute('aria-valuemin'), '260');
  assert.equal(element.getAttribute('tabindex'), '0');
  assert.equal(element.getAttribute('title'), 'Drag');
  fire(element, 'keydown', { key: 'ArrowLeft' });
  assert.deepEqual(keys, ['ArrowLeft']);
  fire(element, 'pointerdown');
  fire(element, 'pointerup');
  assert.deepEqual(said, ['end']);
});
