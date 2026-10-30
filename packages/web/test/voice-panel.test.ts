import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, saved, tick, fire } from './dom-env.ts';
import type { BoardVoice } from '@once-upon-a-diff/shared/types';

const { mountVoice, nearBottom, clampWidth, lineKeys, MIN_WIDTH } =
  await import('../public/board/voice/voice-panel.ts');

const base: BoardVoice = {
  name: 'clarifi-f9',
  title: 'ClariFi f9',
  repo: 'acme/widgets',
  lane: 'widgets',
  branch: 'main',
  status: 'listening',
  since: null,
  agents: { running: 2, waiting: 1, review: 0 },
  session: 'sess-1',
  can_focus: true,
  context: 42,
  lines: [
    { who: 'you', text: 'hello', at: 1 },
    { who: 'voice', text: 'hi there', at: 2 },
  ],
};
const calls: { paused: boolean }[] = [];
let changed = 0;
let focused: string[] = [];
const props = (voice: BoardVoice | null) => ({
  voice,
  root,
  pause: async (paused: boolean) => {
    calls.push({ paused });
  },
  onChanged: () => {
    changed++;
  },
  onFocus: async (session: string) => {
    focused.push(session);
  },
});
let host = document.createElement('div');
/** A new panel on a clean board, as the page loads it: open or closed as remembered, at the width remembered. */
function fresh(remembered: Record<string, string> = {}) {
  host.remove();
  host = document.createElement('div');
  root.append(host);
  root.className = '';
  root.removeAttribute('style');
  saved.clear();
  for (const [key, value] of Object.entries(remembered)) {
    saved.set(key, value);
  }
}
fresh();
const show = async (voice: BoardVoice | null) => {
  mountVoice(host as unknown as HTMLElement, props(voice));
  await tick();
};
const $ = (selector: string) => host.querySelector(selector) as HTMLElement;

test('the tab shows with the status, and the panel only once it is opened (and the choice is remembered)', async () => {
  fresh();
  await show(base);
  assert.equal($('.ou-board-voice-word').textContent, 'Listening');
  assert.equal($('.ou-board-voice-tab').getAttribute('aria-expanded'), 'false');
  assert.ok($('.ou-board-voice-panel') === null);
  assert.ok(root.classList.contains('ou-board-has-voice'));
  assert.ok(!root.classList.contains('ou-board-pushed'));

  fire($('.ou-board-voice-tab'), 'click');
  await tick();
  assert.equal($('.ou-board-voice-tab').getAttribute('aria-expanded'), 'true');
  assert.ok($('.ou-board-voice-panel'));
  assert.ok(root.classList.contains('ou-board-pushed'));
  assert.equal(saved.get('ou-board-voice-open'), 'true');
  assert.equal($('.ou-board-voice-name').textContent, 'clarifi-f9');
  assert.match(host.textContent as string, /widgets · main/);
  assert.match(host.textContent as string, /agents: 2 running, 1 waiting/);
  assert.equal($('.ou-board-meter').getAttribute('aria-valuenow'), '42');

  fire($('.ou-board-voice-close'), 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel') === null);
  assert.equal(saved.get('ou-board-voice-open'), 'false');
});

test('a poll with a new line keeps the same elements, so focus and scroll stay with them', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show(base);
  const grip = $('.ou-board-voice-grip');
  const list = $('.ou-board-voice-lines');
  const firstLine = list.children[0];
  await show({ ...base, lines: [...base.lines, { who: 'voice', text: 'and more', at: 3 }] });
  assert.ok($('.ou-board-voice-grip') === grip);
  assert.ok($('.ou-board-voice-lines') === list);
  assert.equal(list.children.length, 3);
  assert.ok(list.children[0] === firstLine);
  assert.equal(list.children[2].textContent, 'Voice and more');
});

test('the conversation follows new lines while it is at the bottom and stays put when scrolled up', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show(base);
  const list = $('.ou-board-voice-lines');
  // linkedom has no layout: say how tall the conversation is and how much shows
  Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
  const more = (count: number) => ({
    ...base,
    lines: Array.from({ length: count }, (_, index) => ({
      who: 'voice' as const,
      text: `line ${index}`,
      at: index,
    })),
  });
  Object.assign(list, { scrollTop: 0 });
  fire(list, 'scroll');
  await show(more(3));
  assert.equal(list.scrollTop, 0, 'scrolled up: a new line leaves you where you were');
  Object.assign(list, { scrollTop: 400 });
  fire(list, 'scroll');
  await show(more(4));
  assert.equal(list.scrollTop, 500, 'at the bottom: a new line scrolls into view');
});

test('once the conversation is full, a new line keeps every other line’s element and still scrolls, even with the same words', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  const window20 = (from: number, text = (index: number) => `line ${index}`): BoardVoice => ({
    ...base,
    lines: Array.from({ length: 20 }, (_, offset) => ({
      who: 'voice' as const,
      text: text(from + offset),
      at: 1000 + from + offset,
    })),
  });
  await show(window20(0));
  const list = $('.ou-board-voice-lines');
  Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
  const before = [...list.children];
  assert.equal(before.length, 20);
  await show(window20(1));
  const after = [...list.children];
  assert.equal(after.length, 20);
  assert.ok(
    after.slice(0, 19).every((item, index) => item === before[index + 1]),
    'the 19 lines still there are the same elements, so a selection in them survives',
  );
  assert.equal(after[19].textContent, 'Voice line 20');
  // at the bottom, and the next line says the same words as the last: it still scrolls
  Object.assign(list, { scrollTop: 400 });
  fire(list, 'scroll');
  Object.assign(list, { scrollTop: 123 });
  await show(window20(2, () => 'Okay.'));
  assert.equal(list.scrollTop, 500);
  assert.deepEqual(
    lineKeys([base.lines[0], base.lines[0]]),
    ['1-you', '1-you#1'],
    'a repeat of both still has its own key',
  );
});

test('a drag ends when the grip loses the pointer, when the panel goes away mid-drag, or when the button is up', async () => {
  fresh({ 'ou-board-voice-open': 'true', 'ou-board-voice-width': '340' });
  await show(base);
  let grip = $('.ou-board-voice-grip');
  const width = () => root.style.getPropertyValue('--ou-voice-width');
  // the pointer is taken away (capture lost): saved, and a later move does nothing
  fire(grip, 'pointerdown');
  fire(grip, 'pointermove', { clientX: 650 });
  await tick();
  assert.equal(width(), '350px');
  fire(grip, 'lostpointercapture');
  assert.equal(saved.get('ou-board-voice-width'), '350');
  fire(grip, 'pointermove', { clientX: 500 });
  await tick();
  assert.equal(width(), '350px');

  // a poll turns the session to paused mid-drag: the grip goes, the width is saved, the drag is over
  fire(grip, 'pointerdown');
  fire(grip, 'pointermove', { clientX: 600 });
  await tick();
  assert.equal(width(), '400px');
  await show({ ...base, status: 'paused' });
  assert.equal(saved.get('ou-board-voice-width'), '400');
  fire($('.ou-board-voice-tab'), 'click');
  await tick();
  grip = $('.ou-board-voice-grip');
  fire(grip, 'pointermove', { clientX: 300 });
  await tick();
  assert.equal(width(), '400px', 'a move with no press after that does not resize');

  // a move that says no button is down ends the drag
  fire(grip, 'pointerdown');
  fire(grip, 'pointermove', { clientX: 500, buttons: 0 });
  fire(grip, 'pointermove', { clientX: 300, buttons: 1 });
  await tick();
  assert.equal(width(), '400px');
});

test('a line is text, not markup', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show({ ...base, lines: [{ who: 'voice', text: '<img src=x onerror=alert(1)>', at: 1 }] });
  assert.ok($('.ou-board-voice-lines img') === null);
  assert.match($('.ou-board-voice-lines').textContent as string, /<img src=x/);
});

test('a paused panel is collapsed: the tab peeks it open without remembering, and live again drops the peek', async () => {
  fresh({ 'ou-board-voice-open': 'false' });
  await show({ ...base, status: 'paused' });
  assert.ok(root.classList.contains('ou-board-has-voice'));
  assert.ok($('.ou-board-voice').classList.contains('ou-board-voice-collapsed'));
  assert.match($('.ou-board-voice-tab').getAttribute('title') as string, /^Peek at/);
  fire($('.ou-board-voice-tab'), 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel'));
  assert.equal(saved.get('ou-board-voice-open'), 'false', 'a peek is not remembered');
  assert.equal($('.ou-board-voice-pause').textContent, 'Resume');
  await show(base);
  assert.ok($('.ou-board-voice-panel') === null, 'live again, and the remembered choice is closed');
  await show({ ...base, status: 'paused' });
  assert.ok($('.ou-board-voice-panel') === null, 'the old peek is gone');
});

test('Pause asks the bridge, waits disabled until the poll is back, then enables; Resume asks for the opposite; ended has neither', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show(base);
  calls.length = 0;
  changed = 0;
  fire($('.ou-board-voice-pause'), 'click');
  await tick();
  assert.deepEqual(calls, [{ paused: true }]);
  assert.equal(changed, 1);
  assert.ok(!$('.ou-board-voice-pause').hasAttribute('disabled'), 'enabled again after the poll');

  // a slow bridge: the button waits disabled, so a second click cannot send a second request
  let release = () => {};
  const slow = { ...props(base), pause: () => new Promise<void>((resolve) => (release = resolve)) };
  mountVoice(host as unknown as HTMLElement, slow);
  await tick();
  fire($('.ou-board-voice-pause'), 'click');
  await tick();
  assert.ok($('.ou-board-voice-pause').hasAttribute('disabled'));
  release();
  await tick();
  assert.ok(!$('.ou-board-voice-pause').hasAttribute('disabled'));

  // paused: the panel is collapsed to its tab, so peek, then Resume
  await show({ ...base, status: 'paused' });
  fire($('.ou-board-voice-tab'), 'click');
  await tick();
  fire($('.ou-board-voice-pause'), 'click');
  await tick();
  assert.deepEqual(calls.at(-1), { paused: false });
  await show({ ...base, status: 'ended' });
  assert.ok($('.ou-board-voice-pause') === null);
});

test('Open in iTerm names the voice session, and is disabled when no tab is known', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show(base);
  focused = [];
  fire($('.ou-board-focus'), 'click');
  await tick();
  assert.deepEqual(focused, ['sess-1']);
  assert.equal($('.ou-board-focus').textContent, 'Open in iTerm');
  await show({ ...base, can_focus: false });
  assert.ok($('.ou-board-focus').hasAttribute('disabled'));
});

test('the arrow keys resize the panel and the width is remembered; the root carries it for the stylesheet', async () => {
  fresh({ 'ou-board-voice-open': 'true' });
  await show(base);
  const grip = $('.ou-board-voice-grip');
  assert.equal(grip.getAttribute('aria-valuemin'), String(MIN_WIDTH));
  assert.equal(grip.getAttribute('aria-valuenow'), '340');
  const left = fire(grip, 'keydown', { key: 'ArrowLeft' });
  assert.ok(left.defaultPrevented);
  await tick();
  assert.equal(root.style.getPropertyValue('--ou-voice-width'), '356px');
  assert.equal(saved.get('ou-board-voice-width'), '356');
  assert.ok($('.ou-board-voice-grip') === grip, 'the grip is the same element after the redraw');
  assert.equal($('.ou-board-voice-grip').getAttribute('aria-valuenow'), '356');
  fire(grip, 'keydown', { key: 'ArrowRight' });
  fire(grip, 'keydown', { key: 'ArrowRight' });
  await tick();
  assert.equal(root.style.getPropertyValue('--ou-voice-width'), '324px');
  const other = fire(grip, 'keydown', { key: 'a' });
  assert.ok(!other.defaultPrevented);
});

test('a drag on the grip sets the width from the pointer, clamped, and saves it when let go', async () => {
  fresh({ 'ou-board-voice-open': 'true', 'ou-board-voice-width': '324' });
  await show(base);
  const grip = $('.ou-board-voice-grip');
  fire(grip, 'pointermove', { clientX: 100 });
  await tick();
  assert.equal(
    root.style.getPropertyValue('--ou-voice-width'),
    '324px',
    'a move before a press does nothing',
  );
  const down = fire(grip, 'pointerdown');
  assert.ok(down.defaultPrevented);
  fire(grip, 'pointermove', { clientX: 700 });
  await tick();
  assert.equal(root.style.getPropertyValue('--ou-voice-width'), '300px');
  fire(grip, 'pointermove', { clientX: 100 });
  await tick();
  assert.equal(
    root.style.getPropertyValue('--ou-voice-width'),
    '600px',
    'no wider than 60% of the window',
  );
  assert.equal(saved.get('ou-board-voice-width'), '324', 'saved only when the drag ends');
  fire(grip, 'pointerup');
  assert.equal(saved.get('ou-board-voice-width'), '600');
  fire(grip, 'pointermove', { clientX: 500 });
  await tick();
  assert.equal(root.style.getPropertyValue('--ou-voice-width'), '600px');
});

test('no voice draws nothing and takes the classes off the board', async () => {
  fresh();
  await show(base);
  await show(null);
  assert.equal(host.children.length, 0);
  assert.ok(!root.classList.contains('ou-board-has-voice'));
  assert.ok(!root.classList.contains('ou-board-pushed'));
});

test('the width stays between the least and 60% of the window; at the bottom means within 8px', () => {
  assert.equal(clampWidth(100, 1000), MIN_WIDTH);
  assert.equal(clampWidth(500.4, 1000), 500);
  assert.equal(clampWidth(900, 1000), 600);
  assert.equal(clampWidth(900, 300), MIN_WIDTH, 'a small window still gets the least');
  assert.ok(nearBottom(1000, 593, 400));
  assert.ok(nearBottom(1000, 600, 400));
  assert.ok(!nearBottom(1000, 500, 400));
});
