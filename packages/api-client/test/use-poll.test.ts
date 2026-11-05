import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, window } from './preact-env.ts';
import { html, render } from '../../web/public/vendor/preact.mjs';

// after the DOM and the resolver are in place (a static import would be resolved before them)
const { usePoll } = await import('../src/use-poll.ts');

// the test kit's tick waits on a real setTimeout, which is faked here
const tick = () => new Promise((resolve) => setImmediate(resolve));
let visible = 'visible';
Object.defineProperty(document, 'visibilityState', { get: () => visible });
mock.timers.enable({ apis: ['setTimeout'] });

let loads = 0;
let answer: () => string = () => `board ${loads}`;
let load = async () => {
  loads++;
  return answer();
};
let refresh: () => Promise<void> = async () => {};

function Board(props: { every: number }) {
  const view = usePoll(() => load(), { everyMs: props.every });
  refresh = view.refresh;
  return html`<p>${view.data ?? 'loading'}|${view.error?.message ?? 'ok'}|${view.failed}</p>`;
}
const shown = () => root.querySelector('p')?.textContent;
const settle = async () => {
  await tick();
  await tick();
};

test('it loads on mount, and the data comes back as the hook’s value', async () => {
  render(html`<${Board} every=${3000} />`, root);
  assert.equal(shown(), 'loading|ok|0');
  await settle();
  assert.equal(shown(), 'board 1|ok|0');
});

test('it polls each interval while visible, and not while hidden', async () => {
  mock.timers.tick(3000);
  await settle();
  assert.equal(shown(), 'board 2|ok|0');
  visible = 'hidden';
  mock.timers.tick(3000);
  await settle();
  assert.equal(loads, 2);
  visible = 'visible';
});

test('a new load function on a redraw does not restart the timer', async () => {
  const before = loads;
  load = async () => {
    loads++;
    return `again ${loads}`;
  };
  render(html`<${Board} every=${3000} />`, root);
  await settle();
  assert.equal(loads, before, 'a redraw does not load');
  mock.timers.tick(3000);
  await settle();
  assert.equal(shown(), `again ${before + 1}|ok|0`, 'the next poll calls the new function');
});

test('a failed poll keeps the data and counts; refresh loads now and the next good one resets', async () => {
  load = async () => {
    loads++;
    return answer();
  };
  render(html`<${Board} every=${3000} />`, root);
  answer = () => {
    throw new Error('down');
  };
  mock.timers.tick(3000);
  await settle();
  assert.match(shown() as string, /^again \d+\|down\|1$/);
  mock.timers.tick(3000);
  await settle();
  assert.match(shown() as string, /^again \d+\|down\|2$/);
  answer = () => 'fine';
  await refresh();
  await settle();
  assert.equal(shown(), 'fine|ok|0');
});

test('the window’s focus polls', async () => {
  const before = loads;
  window.dispatchEvent(new window.Event('focus'));
  await settle();
  assert.equal(loads, before + 1);
});

test('unmounting stops the poll', async () => {
  render(null, root);
  const before = loads;
  mock.timers.tick(9000);
  window.dispatchEvent(new window.Event('focus'));
  await settle();
  assert.equal(loads, before);
});
