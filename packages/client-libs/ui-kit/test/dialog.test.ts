import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick, fire } from './preact-env.ts';
// Preact runs effects after the next frame, or after 100 ms where there is no requestAnimationFrame
Object.assign(globalThis, {
  requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const { html, render, useState } = await import('/assets/preact.mjs');
const { Dialog } = await import('../src/components/dialog.ts');

/** Waits for a dialog the effect has opened (it runs after the next frame, which a loaded machine delays). */
const shown = async () => {
  for (let tries = 0; tries < 200 && !dialog()?.hasAttribute('open'); tries++) {
    await tick();
  }
};
const dialog = () => root.querySelector('dialog') as HTMLElement | null;

test('a Dialog opens as a modal when it is drawn, with the host’s id and class and its children', async () => {
  render(
    html`<${Dialog} id="the-box" class="wide" onClose=${() => {}}><p>Hello</p></${Dialog}>`,
    root,
  );
  await shown();
  assert.ok(dialog()!.hasAttribute('open'));
  assert.equal(dialog()!.id, 'the-box');
  assert.equal(dialog()!.className, 'wide');
  assert.equal(dialog()!.textContent, 'Hello');
  render(null, root);
  assert.equal(dialog(), null, 'not drawn, not there');
});

test('a click on the backdrop says onClose; a click on what is inside does not', async () => {
  let closed = 0;
  render(html`<${Dialog} onClose=${() => closed++}><button>Inside</button></${Dialog}>`, root);
  await shown();
  fire(root.querySelector('button')!, 'click');
  assert.equal(closed, 0);
  fire(dialog()!, 'click');
  assert.equal(closed, 1);
  render(null, root);
});

test('Escape (the dialog’s own close event) says onClose', async () => {
  let closed = 0;
  render(html`<${Dialog} onClose=${() => closed++}>x</${Dialog}>`, root);
  await shown();
  (dialog() as unknown as { close: () => void }).close();
  assert.equal(closed, 1);
  render(null, root);
});

test('the caller stops drawing it on onClose, and drawing it again starts fresh', async () => {
  function Host() {
    const [open, setOpen] = useState(true);
    const [count, setCount] = useState(0);
    return html`<button id="again" onClick=${() => setOpen(true)}>Again</button>${open && html`<${Dialog} onClose=${() => setOpen(false)}><span>${count}</span><button id="bump" onClick=${() => setCount(count + 1)}>+</button></${Dialog}>`}`;
  }
  render(html`<${Host} />`, root);
  await shown();
  fire(document.getElementById('bump')!, 'click');
  await tick();
  assert.equal(dialog()!.querySelector('span')!.textContent, '1');
  fire(dialog()!, 'click');
  await tick();
  assert.equal(dialog(), null);
  fire(document.getElementById('again')!, 'click');
  await shown();
  assert.ok(dialog()!.hasAttribute('open'));
  render(null, root);
});

test('focus goes back to what had it when the dialog opened, however it is closed', async () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return html`<button id="opener" onClick=${() => setOpen(true)}>Open</button>${open && html`<${Dialog} onClose=${() => setOpen(false)}><button id="cancel" onClick=${() => setOpen(false)}>Cancel</button></${Dialog}>`}`;
  }
  render(html`<${Host} />`, root);
  const opener = document.getElementById('opener') as HTMLElement;
  const ways: [string, () => void][] = [
    ['its own button', () => fire(document.getElementById('cancel')!, 'click')],
    ['the backdrop', () => fire(dialog()!, 'click')],
    ['Escape', () => (dialog() as unknown as { close: () => void }).close()],
  ];
  for (const [way, close] of ways) {
    opener.focus();
    fire(opener, 'click');
    await shown();
    document.getElementById('cancel')!.focus();
    assert.equal(
      document.activeElement,
      document.getElementById('cancel'),
      `focus is in the dialog (${way})`,
    );
    close();
    await tick();
    assert.equal(dialog(), null, way);
    assert.equal(document.activeElement, opener, `focus is back on the opener (${way})`);
  }
  render(null, root);
});
