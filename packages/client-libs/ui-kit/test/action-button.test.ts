import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { ActionButton, useBusy } = await import('../src/components/action-button.ts');

const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
};
const button = () => root.querySelector('button') as HTMLButtonElement;

/** A promise to settle by hand. */
function later() {
  let done = () => {};
  const promise = new Promise<void>((resolve) => (done = resolve));
  return { promise, done };
}

test('an ActionButton is off and says its busy label until what the click started is done', async () => {
  const held = later();
  const clicks: number[] = [];
  await draw(
    html`<${ActionButton} class="go" title="Do it" attrs=${{ 'data-go': '1' }} busyLabel="Going…" onClick=${() => {
      clicks.push(1);
      return held.promise;
    }}>Go</${ActionButton}>`,
  );
  assert.equal(button().getAttribute('type'), 'button');
  assert.equal(button().className, 'go');
  assert.equal(button().getAttribute('title'), 'Do it');
  assert.equal(button().getAttribute('data-go'), '1');
  assert.equal(button().textContent, 'Go');
  assert.equal(button().disabled, false);
  fire(button(), 'click');
  await tick();
  assert.equal(button().textContent, 'Going…');
  assert.equal(button().disabled, true);
  fire(button(), 'click');
  assert.equal(clicks.length, 1, 'a second click while it is out starts nothing');
  held.done();
  await tick();
  assert.equal(button().textContent, 'Go');
  assert.equal(button().disabled, false);
});

test('a button with no busy label keeps its text, and one the caller turned off stays off', async () => {
  const held = later();
  await draw(html`<${ActionButton} onClick=${() => held.promise}>Pause</${ActionButton}>`);
  assert.equal(button().hasAttribute('class'), false);
  fire(button(), 'click');
  await tick();
  assert.equal(button().textContent, 'Pause');
  assert.equal(button().disabled, true);
  held.done();
  await tick();
  assert.equal(button().disabled, false);
  await draw(html`<${ActionButton} disabled=${true} onClick=${() => {}}>Off</${ActionButton}>`);
  assert.equal(button().disabled, true);
});

test('a click whose work finishes at once leaves the button on', async () => {
  let calls = 0;
  await draw(
    html`<${ActionButton} busyLabel="…" onClick=${() => void calls++}>Quick</${ActionButton}>`,
  );
  fire(button(), 'click');
  await tick();
  assert.equal(calls, 1);
  assert.equal(button().textContent, 'Quick');
  assert.equal(button().disabled, false);
});

test('useBusy gives the key of the work that is out and ignores a second run meanwhile', async () => {
  const held = later();
  const seen: (string | null)[] = [];
  const started: string[] = [];
  let run: (key: string, work: () => Promise<unknown>) => Promise<void> = async () => {};
  function Probe() {
    const busy = useBusy();
    run = busy.run;
    seen.push(busy.busy);
    return html`<i>${busy.busy ?? 'idle'}</i>`;
  }
  await draw(html`<${Probe} />`);
  const first = run('focus', () => {
    started.push('focus');
    return held.promise;
  });
  void run('other', async () => void started.push('other'));
  await tick();
  assert.equal(root.querySelector('i')?.textContent, 'focus');
  assert.deepEqual(started, ['focus']);
  held.done();
  await first;
  await tick();
  assert.equal(root.querySelector('i')?.textContent, 'idle');
  await run('again', async () => void started.push('again'));
  assert.deepEqual(started, ['focus', 'again']);
  let failure = '';
  await run('boom', () => Promise.reject(new Error('no'))).catch(
    (err: Error) => (failure = err.message),
  );
  assert.equal(failure, 'no', 'a failure is the caller’s: run does not swallow it');
  await tick();
  assert.equal(root.querySelector('i')?.textContent, 'idle', 'and the key is cleared all the same');
  await run('after', async () => void started.push('after'));
  assert.deepEqual(started, ['focus', 'again', 'after']);
});
