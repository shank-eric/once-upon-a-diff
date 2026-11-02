import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, saved, tick, fire, window } from './dom-env.ts';
import { render } from '../public/vendor/preact.mjs';
import type {
  BoardAgent,
  BoardCard,
  BoardData,
  BoardVoice,
  BoardWorktree,
} from '@once-upon-a-diff/shared/types';

/*
 * The board page itself, loaded as the browser loads it with a fake bridge behind fetch and linkedom for a DOM: one Preact
 * tree in the app element, the poll feeding it, and each region's main interactions (add, assign, drag, filter, the Idle
 * fold, the phone buttons, Clean up) driven with the events a browser would send.
 */
const voice: BoardVoice = {
  name: 'clarifi-f9',
  title: 'ClariFi f9',
  repo: 'acme/widgets',
  lane: 'widgets',
  branch: 'main',
  status: 'listening',
  since: null,
  agents: { running: 0, waiting: 0, review: 0 },
  session: 'sess-1',
  can_focus: true,
  context: null,
  lines: [{ who: 'voice', text: 'hello', at: 1 }],
};
const card = (over: Partial<BoardCard>): BoardCard => ({
  id: 'c',
  kind: 'work',
  title: 'A card',
  repo: 'acme/widgets',
  branch: null,
  lane: 'widgets',
  column: 'working',
  detail: null,
  since: '2026-10-29T10:00:00Z',
  pr: null,
  story: null,
  building: null,
  sessions: [],
  agents: [],
  parent: null,
  focus_session: null,
  can_focus: false,
  listening: null,
  build: null,
  ...over,
});
const candidates = (...ids: string[]) =>
  ids.map((id) => ({
    id,
    title: `session ${id}`,
    status: 'idle' as const,
    since: null,
    branch: null,
    repo: null,
    blank: false,
  }));
const backlog = (id: string, lane = 'widgets', sessions: string[] = ['s1']): BoardCard =>
  card({
    id: `backlog:${id}`,
    kind: 'backlog',
    title: `Item ${id}`,
    lane,
    repo: `acme/${lane}`,
    column: 'backlog',
    backlog: {
      id,
      added_by: 'board',
      started: null,
      start_line: `once-upon backlog start ${id}`,
      assigned: null,
      assign: { candidates: candidates(...sessions), prompt: `start ${id}` },
    },
  });
const tree: BoardWorktree = {
  path: '/work/old-one',
  name: 'old-one',
  repo: 'acme/widgets',
  lane: 'widgets',
  main: '/work/widgets',
  branch: 'old/one',
  last_commit_at: null,
  state: 'clean',
  modified: 0,
  untracked: 0,
  unpushed: 0,
  size_kb: 10,
  pr: { number: null, state: 'none' },
  verdict: 'merged',
  in_use: [],
  locked: false,
  ignored: [],
  attention: null,
  stale: false,
  removable: true,
  keep: [],
  deletes_branch: false,
};
const idleCard = card({
  id: 'idle-1',
  kind: 'session',
  title: 'Resting session',
  column: 'idle',
  sessions: [
    {
      id: 'idle-s',
      title: 'resting',
      cwd: '/work/widgets',
      branch: null,
      status: 'idle',
      detail: null,
      since: null,
      source: 'registry',
      focus: false,
    },
  ],
});
const board = (over: Partial<BoardData> = {}): BoardData => ({
  at: '2026-10-29T12:00:00Z',
  status_source: 'registry',
  warning: null,
  voice,
  phone: null,
  voice_start: null,
  voice_paused: false,
  listeners: [],
  helpers: [],
  blank: [],
  lanes: [
    {
      name: 'widgets',
      cards: [
        backlog('bl_1'),
        backlog('bl_2', 'widgets', ['s1', 's2']),
        backlog('bl_3'),
        card({ id: 'w-1', title: 'Working on it' }),
        idleCard,
      ],
    },
    { name: 'gadgets', cards: [backlog('bl_9', 'gadgets'), card({ id: 'g-1', lane: 'gadgets' })] },
  ],
  worktrees: {
    at: null,
    scanning: false,
    total: 1,
    removable: 1,
    size_kb: 10,
    items: [tree],
    prunable: [],
  },
  usage: {
    at: '2026-10-29T12:00:00Z',
    five_hour: { percent: 75, resets_at: null },
    seven_day: { percent: 20, resets_at: null },
  },
  ...over,
});

const alerts: string[] = [];
let answer: () => BoardData | Error = () => board();
/** A status the bridge refuses polls with (401 for no key), or 0 for answering. */
let refuse = 0;
type Sent = { method: string; path: string; body?: Record<string, unknown> };
const requests: Sent[] = [];
/** A POST path held until `release` is called, to see a button while its call is out. */
const held = new Map<string, Promise<void>>();
let poll = () => {};
Object.assign(globalThis, {
  location: { hash: '' },
  alert: (text: string) => void alerts.push(text),
  matchMedia: () => ({ matches: false }),
  // the page polls on a timer: the test calls the poll itself
  setInterval: (callback: () => void) => {
    poll = callback;
    return 0;
  },
  fetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      requests.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
      await held.get(path);
      return { ok: true, status: 200, json: async () => ({ ok: true, url: 'http://x/story?k=1' }) };
    }
    if (refuse) {
      return { ok: false, status: refuse, json: async () => ({ error: 'no key' }) };
    }
    const result = answer();
    if (result instanceof Error) {
      throw result;
    }
    return { ok: true, status: 200, json: async () => result };
  },
});
Object.defineProperty(document, 'visibilityState', { value: 'visible' });
const opened: string[] = [];
const confirmed: string[] = [];
let sure = true;
Object.assign(window, {
  open: (url: string) => void opened.push(url),
  confirm: (text: string) => {
    confirmed.push(text);
    return sure;
  },
});

await import('../public/board.ts');
await tick();

const $ = (selector: string) => root.querySelector(selector) as HTMLElement | null;
const all = (selector: string) => [...root.querySelectorAll(selector)] as HTMLElement[];
const pollNow = async () => {
  poll();
  await tick();
  await tick();
};
const click = async (target: Element | null) => {
  assert.ok(target, 'the element to click is on the page');
  fire(target, 'click');
  await tick();
  await tick();
};
const cardOf = (id: string) => $(`[data-backlog-card="${id}"]`) as HTMLElement;
const order = () => all('[data-backlog-card]').map((one) => one.getAttribute('data-backlog-card'));
/** The widgets lane with its Backlog cards in this order (the bridge's answer after a move). */
const withOrder = (...ids: string[]) =>
  board({
    lanes: [
      {
        name: 'widgets',
        cards: [
          ...ids.map((id) => backlog(id, 'widgets', id === 'bl_2' ? ['s1', 's2'] : ['s1'])),
          card({ id: 'w-1', title: 'Working on it' }),
          idleCard,
        ],
      },
      board().lanes[1],
    ],
  });
/** The board with extra cards in the widgets lane. */
const withCards = (...cards: BoardCard[]) => {
  const world = board();
  world.lanes[0].cards.push(...cards);
  return world;
};
const idle = async () => {
  await tick();
  await tick();
};
const sentTo = (path: string) => requests.filter((one) => one.path === path);

test('the page is one Preact tree in the app element: header, columns, lanes and the voice panel', () => {
  assert.ok(root.querySelector('header h1'), 'the header');
  assert.ok($('main.ou-board .ou-board-groups'), 'the columns');
  assert.ok($('.ou-board-trees-lane'), 'the worktrees lane');
  assert.ok($('.ou-board-voice'), 'the voice tab');
  assert.ok(root.classList.contains('ou-board-has-voice'));
  assert.ok(!root.querySelector('[style*="display:contents"]'), 'no string-render wrapper');
});

test('the header says what is on the board: the summary, the usage meters and the repo filter', () => {
  assert.match(
    $('.ou-local-top-main .ou-local-muted')?.textContent as string,
    /4 in backlog · 2 working/,
  );
  const meters = all('.ou-board-meters .ou-board-meter');
  assert.equal(meters.length, 2);
  assert.equal(meters[0].getAttribute('aria-valuenow'), '75');
  assert.ok(meters[0].className.includes('ou-board-usage-warn'), 'yellow from 70%');
  assert.match($('[data-board-filter]')?.textContent as string, /Repo: All/);
});

test('a poll redraws in place: the same nodes stay, so focus and scroll are not lost', async () => {
  const button = $('[data-backlog-drop="bl_1"]') as HTMLElement;
  const item = cardOf('bl_1');
  button.focus();
  answer = () => board({ warning: 'iTerm is not answering' });
  await pollNow();
  assert.match(root.textContent as string, /iTerm is not answering/);
  assert.ok($('[data-backlog-drop="bl_1"]') === button, 'the same button');
  assert.ok(document.activeElement === button, 'and it keeps the focus');
  assert.ok(cardOf('bl_1') === item, 'the same card');
  answer = () => board();
  await pollNow();
});

test('+ Add opens the panel with the title focused; typing and focus stay through polls; Escape closes it', async () => {
  assert.equal($('[data-backlog-add]'), null);
  await click($('[data-backlog-add-open]'));
  const form = $('[data-backlog-add]');
  assert.ok(form, 'the panel is open');
  assert.equal($('[data-backlog-add-open]'), null, '+ Add gives way to the panel');
  const title = $('[data-backlog-title]') as HTMLInputElement;
  assert.ok(document.activeElement === title, 'the title has the focus');
  title.value = 'half typed';
  const note = $('[name="note"]') as HTMLInputElement;
  note.value = 'and a note';
  await pollNow();
  assert.ok($('[data-backlog-title]') === title, 'the same input');
  assert.equal(title.value, 'half typed');
  assert.equal(note.value, 'and a note');
  assert.ok(document.activeElement === title, 'and keeps it');
  fire(document.body as unknown as Element, 'keydown', { key: 'Escape' });
  await tick();
  await tick();
  assert.equal($('[data-backlog-add]'), null, 'Escape closes it');
  assert.ok($('[data-backlog-add-open]'), '+ Add is back');
});

test('Add sends the title and note, clears the panel and closes it; Cancel closes without sending', async () => {
  requests.length = 0;
  await click($('[data-backlog-add-open]'));
  await click($('[data-backlog-cancel]'));
  assert.equal($('[data-backlog-add]'), null);
  assert.deepEqual(requests, []);

  await click($('[data-backlog-add-open]'));
  ($('[data-backlog-title]') as HTMLInputElement).value = '  Fix the thing ';
  ($('[name="note"]') as HTMLInputElement).value = 'soon';
  fire($('[data-backlog-add]') as Element, 'submit');
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog'), [
    {
      method: 'POST',
      path: '/api/board/backlog',
      body: { title: 'Fix the thing', note: 'soon' },
    },
  ]);
  assert.equal($('[data-backlog-add]'), null, 'closed after the add');
});

test('the Add panel’s repo menu picks the repo the item is for', async () => {
  requests.length = 0;
  await click($('[data-backlog-add-open]'));
  await click($('[data-backlog-repo]'));
  const items = [...document.querySelectorAll('.ou-menu-item')] as HTMLElement[];
  assert.deepEqual(
    items.map((one) => one.querySelector('.ou-menu-label')?.textContent),
    ['No repo', 'gadgets', 'widgets'],
  );
  await click(items[2]);
  assert.match($('[data-backlog-repo]')?.textContent as string, /Repo: widgets/);
  ($('[data-backlog-title]') as HTMLInputElement).value = 'For widgets';
  fire($('[data-backlog-add]') as Element, 'submit');
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog')[0].body, {
    title: 'For widgets',
    repo: 'acme/widgets',
  });
});

test('Assign types into the one obvious session after a confirm, and offers a menu when there is no obvious one', async () => {
  requests.length = 0;
  sure = false;
  await click($('[data-backlog-assign="bl_1"]'));
  assert.match(confirmed.at(-1) as string, /Type this into "session s1" and press Enter/);
  assert.deepEqual(requests, [], 'a no sends nothing');
  sure = true;
  await click($('[data-backlog-assign="bl_1"]'));
  assert.deepEqual(sentTo('/api/board/backlog/assign')[0].body, { id: 'bl_1', session: 's1' });

  requests.length = 0;
  const two = $('[data-backlog-assign="bl_2"]') as HTMLElement;
  assert.equal(two.getAttribute('aria-haspopup'), 'menu', 'two idle sessions: a menu button');
  await click(two);
  const items = [...document.querySelectorAll('.ou-menu-item')] as HTMLElement[];
  assert.equal(items.length, 2);
  assert.deepEqual(requests, [], 'the menu sends nothing until one is picked');
  await click(items[1]);
  assert.deepEqual(sentTo('/api/board/backlog/assign')[0].body, { id: 'bl_2', session: 's2' });
});

test('Copy start line and Drop are on the card: Drop asks the bridge to drop that item', async () => {
  requests.length = 0;
  await click($('[data-backlog-drop="bl_3"]'));
  assert.deepEqual(sentTo('/api/board/backlog/drop')[0].body, { id: 'bl_3' });
});

test('dragging a Backlog card marks where it would land and a drop moves it there', async () => {
  requests.length = 0;
  const first = cardOf('bl_1');
  const dataTransfer = { setData() {}, effectAllowed: '' };
  fire(first, 'dragstart', { dataTransfer });
  await tick();
  assert.ok(first.classList.contains('ou-board-dragging'));
  const list = first.parentElement as HTMLElement;
  // the cards are 100 tall; 250 is the lower half of the third card: after it, the bottom of the lane
  const over = fire(list, 'dragover', { clientY: 250 });
  await tick();
  assert.ok(over.defaultPrevented, 'a drop is allowed here');
  assert.ok(cardOf('bl_3').classList.contains('ou-board-drop-after'));
  // a poll in the middle of the drag brings a changed board (the other two cards swapped): the drag and its marks stay
  const second = cardOf('bl_2');
  answer = () => withOrder('bl_1', 'bl_3', 'bl_2');
  await pollNow();
  assert.deepEqual(
    order().slice(0, 3),
    ['bl_1', 'bl_3', 'bl_2'],
    'the poll’s order is on the page',
  );
  assert.ok(cardOf('bl_1') === first && first.classList.contains('ou-board-dragging'));
  assert.ok(cardOf('bl_2') === second, 'the moved card is the same node');
  assert.ok(cardOf('bl_3').classList.contains('ou-board-drop-after'));
  // the upper half of the second card: before it, which is where the card already is, so no slot
  const none = fire(list, 'dragover', { clientY: 120 });
  await tick();
  assert.ok(none.defaultPrevented === false, 'no drop on the card’s own place');
  assert.equal(all('.ou-board-drop-before, .ou-board-drop-after').length, 0);
  fire(list, 'dragover', { clientY: 250 });
  await tick();
  assert.ok(
    cardOf('bl_2').classList.contains('ou-board-drop-after'),
    'the line is on the new last card',
  );
  fire(list, 'drop', { clientY: 250 });
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/move')[0].body, { id: 'bl_1', edge: 'bottom' });
  answer = () => board();
  await pollNow();
  fire(first, 'dragend');
  await tick();
  assert.ok(!first.classList.contains('ou-board-dragging'));
  assert.equal(all('.ou-board-drop-before, .ou-board-drop-after').length, 0);
});

test('the drop line goes when the pointer leaves the lane’s list, and stays while it moves inside it', async () => {
  const first = cardOf('bl_1');
  fire(first, 'dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } });
  await tick();
  const list = first.parentElement as HTMLElement;
  fire(list, 'dragover', { clientY: 250 });
  await tick();
  assert.equal(all('.ou-board-drop-after').length, 1);
  fire(list, 'dragleave', { relatedTarget: cardOf('bl_2') });
  await tick();
  assert.equal(all('.ou-board-drop-after').length, 1, 'onto one of its own cards: the line stays');
  fire(list, 'dragleave', { relatedTarget: $('.ou-board-head') });
  await tick();
  assert.equal(
    all('.ou-board-drop-before, .ou-board-drop-after').length,
    0,
    'onto a heading: gone',
  );
  fire(first, 'dragend');
  await tick();
});

test('a drag only drops in its own lane', async () => {
  requests.length = 0;
  const dataTransfer = { setData() {}, effectAllowed: '' };
  fire(cardOf('bl_1'), 'dragstart', { dataTransfer });
  await tick();
  const other = fire(cardOf('bl_9').parentElement as Element, 'dragover', { clientY: 10 });
  assert.equal(other.defaultPrevented, false);
  fire(cardOf('bl_9').parentElement as Element, 'drop', { clientY: 10 });
  await tick();
  assert.deepEqual(requests, []);
  fire(cardOf('bl_1'), 'dragend');
  await tick();
});

test('Alt+Down on a focused Backlog card moves it down its lane', async () => {
  requests.length = 0;
  fire(cardOf('bl_1'), 'keydown', { key: 'ArrowDown', altKey: true });
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/move')[0].body, { id: 'bl_1', before: 'bl_3' });
  requests.length = 0;
  fire(cardOf('bl_1'), 'keydown', { key: 'ArrowUp', altKey: true });
  await tick();
  assert.deepEqual(requests, [], 'the first card has nowhere to go up');
  fire(cardOf('bl_1'), 'keydown', { key: 'ArrowDown' });
  await tick();
  assert.deepEqual(requests, [], 'a plain arrow is not a move');
});

test('Alt+Down keeps the keyboard on the card through the move, even when a poll lands before the move is done', async () => {
  requests.length = 0;
  const card1 = cardOf('bl_1');
  card1.focus();
  let release = () => {};
  held.set('/api/board/backlog/move', new Promise<void>((resolve) => (release = resolve)));
  fire(card1, 'keydown', { key: 'ArrowDown', altKey: true });
  await tick();
  assert.equal(sentTo('/api/board/backlog/move').length, 1, 'the move is out');
  // a poll lands while it is out: the board is as it was, and it must not use the restore up
  await pollNow();
  assert.deepEqual(order().slice(0, 3), ['bl_1', 'bl_2', 'bl_3']);
  // the bridge moves it, and the move's own redraw puts the card in its new place (a keyed reorder drops the focus)
  answer = () => withOrder('bl_2', 'bl_1', 'bl_3');
  release();
  await idle();
  held.clear();
  assert.deepEqual(order().slice(0, 3), ['bl_2', 'bl_1', 'bl_3']);
  assert.ok(document.activeElement === cardOf('bl_1'), 'the moved card has the focus');
  // and again, with the keyboard still on it
  requests.length = 0;
  answer = () => withOrder('bl_2', 'bl_3', 'bl_1');
  fire(cardOf('bl_1'), 'keydown', { key: 'ArrowDown', altKey: true });
  await idle();
  assert.equal(sentTo('/api/board/backlog/move').length, 1);
  assert.ok(document.activeElement === cardOf('bl_1'), 'repeated moves keep it');
  answer = () => board();
  await pollNow();
});

test('a repo heading folds its cards, and the fold is remembered', async () => {
  const toggle = $('[data-lane-toggle="backlog/widgets"]') as HTMLElement;
  await click(toggle);
  assert.equal(
    order().filter((id) => id !== 'bl_9').length,
    0,
    'the widgets cards are folded away',
  );
  assert.ok(cardOf('bl_9'), 'the other lane is not');
  assert.equal(saved.get('ou-board-collapsed-lanes'), '["backlog/widgets"]');
  assert.match(
    $('[data-lane-toggle="backlog/widgets"] .ou-board-lane-count')?.textContent as string,
    /3/,
  );
  await click($('[data-lane-toggle="backlog/widgets"]'));
  assert.equal(order().length, 4);
  assert.equal(saved.get('ou-board-collapsed-lanes'), '[]');
});

test('the repo filter narrows the whole board to one lane, and is remembered', async () => {
  await click($('[data-board-filter]'));
  const items = [...document.querySelectorAll('.ou-menu-item')] as HTMLElement[];
  assert.deepEqual(
    items.map((one) => one.querySelector('.ou-menu-label')?.textContent),
    ['All', 'widgets', 'gadgets'],
  );
  await click(items[2]);
  assert.match($('[data-board-filter]')?.textContent as string, /Repo: gadgets/);
  assert.deepEqual(order(), ['bl_9']);
  assert.equal(
    $('.ou-board-trees-lane')?.querySelectorAll('.ou-board-tree').length,
    0,
    'the lane’s worktrees are filtered too',
  );
  assert.equal(saved.get('ou-board-filter'), 'gadgets');
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  assert.equal(order().length, 4);
  assert.equal(saved.get('ou-board-filter'), '');
});

test('the Idle lane’s Hide and Show fold its row, and the choice is remembered', async () => {
  assert.ok($('.ou-board-c-idle .ou-board-idle-row'), 'open to begin with');
  await click($('[data-idle-toggle]'));
  assert.equal($('.ou-board-c-idle .ou-board-idle-row'), null);
  assert.equal($('[data-idle-toggle]')?.getAttribute('aria-expanded'), 'false');
  assert.equal(saved.get('ou-board-idle-open'), 'false');
  await pollNow();
  assert.equal($('.ou-board-c-idle .ou-board-idle-row'), null, 'a poll keeps it folded');
  await click($('[data-idle-toggle]'));
  assert.ok($('.ou-board-c-idle .ou-board-idle-row'));
  assert.equal(saved.get('ou-board-idle-open'), 'true');
});

test('the Worktrees lane folds, and Clean up asks first, then asks the bridge', async () => {
  requests.length = 0;
  sure = false;
  await click($('[data-worktree-clean]'));
  assert.match(confirmed.at(-1) as string, /old-one/);
  assert.deepEqual(requests, []);
  sure = true;
  await click($('[data-worktree-clean]'));
  const sent = sentTo('/api/board/worktree/clean');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { path: '/work/old-one', ack: [], ignored: [] });

  await click($('[data-trees-toggle]'));
  assert.equal($('.ou-board-trees-grid'), null);
  assert.equal(saved.get('ou-board-worktrees-open'), 'false');
  await click($('[data-trees-toggle]'));
  assert.ok($('.ou-board-trees-grid'));
});

/** Opens the Phone menu and picks its item by position. */
async function pickPhone(index: number) {
  await click($('[data-voice-phone-menu]'));
  await click(document.querySelectorAll('.ou-menu-item')[index] as HTMLElement);
}

test('the Phone menu waits while the bridge works, then asks for the opposite', async () => {
  requests.length = 0;
  answer = () => board({ phone: { on: false, bridge: true } });
  await pollNow();
  const group = $('.ou-board-voice-phone') as HTMLElement;
  assert.match($('[data-voice-phone-menu]')?.textContent as string, /^Phone ▾$/);
  await click($('[data-voice-phone-menu]'));
  assert.deepEqual(
    [...document.querySelectorAll('.ou-menu-label')].map((one) => one.textContent),
    ['Turn on phone mode', 'Stop phone bridge'],
  );
  await click($('[data-voice-phone-menu]')); // a second click closes it
  let release = () => {};
  held.set('/api/board/voice/phone', new Promise<void>((resolve) => (release = resolve)));
  await pickPhone(0);
  assert.deepEqual(sentTo('/api/board/voice/phone')[0].body, { on: true });
  assert.ok(
    ([...group.querySelectorAll('button')] as HTMLButtonElement[]).every((one) => one.disabled),
  );
  release();
  await tick();
  await tick();
  assert.ok(
    ([...group.querySelectorAll('button')] as HTMLButtonElement[]).every((one) => !one.disabled),
  );
  await pickPhone(1);
  assert.equal(sentTo('/api/board/voice/phone/bridge-stop').length, 1);
  held.clear();
  // phone mode on: a dot, and the menu offers to turn it off
  answer = () => board({ phone: { on: true, bridge: false } });
  await pollNow();
  assert.match($('[data-voice-phone-menu]')?.textContent as string, /Phone ● ▾/);
  await pickPhone(0);
  assert.deepEqual(sentTo('/api/board/voice/phone').at(-1)?.body, { on: false });
  answer = () => board();
  await pollNow();
});

const START = {
  last: { id: 'sess-1', name: 'clarifi-f9' },
  candidates: [
    { id: 'sess-1', name: 'clarifi-f9', idle: true },
    { id: 'sess-2', name: 'widgets-2', idle: true },
    { id: 'sess-3', name: 'busy-3', idle: false },
  ],
};
const voiceOff = { voice: null, phone: { on: false, bridge: false } };

test('with voice off the header starts voice in the last session, or in another one from the menu', async () => {
  requests.length = 0;
  held.clear();
  answer = () => board({ ...voiceOff, voice_start: START });
  await pollNow();
  assert.equal($('[data-voice-pause]'), null, 'nothing to pause');
  assert.equal($('[data-voice-stop]'), null);
  assert.match(
    $('[data-voice-start="last"]')?.textContent as string,
    /^Start voice in clarifi-f9$/,
  );
  let release = () => {};
  held.set('/api/board/voice/start', new Promise<void>((resolve) => (release = resolve)));
  await click($('[data-voice-start="last"]'));
  assert.deepEqual(sentTo('/api/board/voice/start')[0].body, { session: 'sess-1' });
  assert.match($('[data-voice-start="last"]')?.textContent as string, /Starting…/);
  assert.ok(
    ([...root.querySelectorAll('.ou-board-voice-phone button')] as HTMLButtonElement[]).every(
      (one) => one.disabled,
    ),
    'every voice button waits while Larmor types and checks',
  );
  release();
  await tick();
  await tick();
  held.clear();
  // the menu lists the sessions at their prompt, the last one ticked, and sends the chosen id
  await click($('[data-voice-start-menu]'));
  assert.deepEqual(
    [...document.querySelectorAll('.ou-menu-label')].map((one) => one.textContent),
    ['clarifi-f9', 'widgets-2'],
  );
  await click(document.querySelectorAll('.ou-menu-item')[1] as HTMLElement);
  assert.deepEqual(sentTo('/api/board/voice/start').at(-1)?.body, { session: 'sess-2' });
});

test('Start voice with the last session busy is off, and the menu still offers the others; with no last session it is a menu', async () => {
  requests.length = 0;
  answer = () =>
    board({
      ...voiceOff,
      voice_start: {
        ...START,
        candidates: START.candidates.map((one) => ({
          ...one,
          idle: one.id !== 'sess-1' && one.idle,
        })),
      },
    });
  await pollNow();
  const main = $('[data-voice-start="last"]') as HTMLButtonElement;
  assert.ok(main.disabled);
  assert.match(main.title, /busy/);
  await click($('[data-voice-start-menu]'));
  assert.deepEqual(
    [...document.querySelectorAll('.ou-menu-label')].map((one) => one.textContent),
    ['widgets-2'],
  );
  await click($('[data-voice-start-menu]'));
  answer = () => board({ ...voiceOff, voice_start: { ...START, last: null } });
  await pollNow();
  assert.equal($('[data-voice-start="last"]'), null);
  assert.equal($('[data-voice-start-menu]'), null);
  assert.match($('[data-voice-start="pick"]')?.textContent as string, /^Start voice ▾$/);
  await click($('[data-voice-start="pick"]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  assert.deepEqual(sentTo('/api/board/voice/start').at(-1)?.body, { session: 'sess-1' });
  answer = () => board();
  await pollNow();
});

test('with voice on the header pauses, resumes and stops it, and a refusal is shown', async () => {
  requests.length = 0;
  answer = () => board({ voice_start: START });
  await pollNow();
  assert.equal($('[data-voice-start="last"]'), null);
  await click($('[data-voice-pause="pause"]'));
  assert.deepEqual(sentTo('/api/board/voice/pause')[0].body, { paused: true });
  answer = () => board({ voice: { ...voice, status: 'paused' }, voice_start: START });
  await pollNow();
  assert.equal($('[data-voice-pause="pause"]'), null);
  assert.equal($('[data-voice-pause="resume"]')?.textContent, 'Resume');
  await click($('[data-voice-stop]'));
  assert.equal(sentTo('/api/board/voice/stop').length, 1);
  // without a Larmor checkout that can run voice_ctl there is no Stop, but Pause still works
  answer = () => board({ voice_start: null });
  await pollNow();
  assert.equal($('[data-voice-stop]'), null);
  assert.ok($('[data-voice-pause="pause"]'));
  answer = () => board();
  await pollNow();
});

test('Resume is in the header while voice is paused', async () => {
  requests.length = 0;
  answer = () => board({ voice: { ...voice, status: 'paused' } });
  await pollNow();
  await click($('[data-voice-pause="resume"]'));
  assert.deepEqual(sentTo('/api/board/voice/pause')[0].body, { paused: false });
  answer = () => board();
  await pollNow();
  assert.equal($('[data-voice-pause="resume"]'), null);
});

test('a pause left with voice off shows Resume next to Start, and Resume asks the bridge', async () => {
  requests.length = 0;
  answer = () => board({ voice: null, voice_paused: true, voice_start: START });
  await pollNow();
  assert.ok($('[data-voice-start="last"]'));
  assert.equal($('[data-voice-pause="pause"]'), null, 'nothing to pause');
  assert.equal($('[data-voice-stop]'), null);
  await click($('[data-voice-pause="resume"]'));
  assert.deepEqual(sentTo('/api/board/voice/pause')[0].body, { paused: false });
  answer = () => board();
  await pollNow();
});

test('clicks in the panel are the panel’s own: they ask the bridge for nothing', async () => {
  requests.length = 0;
  fire($('.ou-board-voice-tab') as HTMLElement, 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel'), 'the tab opened the panel');
  fire($('.ou-board-voice-close') as HTMLElement, 'click');
  await tick();
  assert.deepEqual(requests, []);
  assert.equal(saved.get('ou-board-voice-open'), 'false');
});

test('one failed poll keeps the last board and a peeked panel; a second in a row shows the error and takes the voice off', async () => {
  answer = () => board({ voice: { ...voice, status: 'paused' } });
  await pollNow();
  fire($('.ou-board-voice-tab') as HTMLElement, 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel'), 'peeking');
  const item = cardOf('bl_1');

  answer = () => new Error('network down');
  await pollNow();
  assert.doesNotMatch(root.textContent as string, /Couldn't load the board/);
  assert.ok($('main.ou-board') && cardOf('bl_1') === item, 'the last good board stays, untouched');
  assert.ok($('header h1'), 'with its header');
  assert.ok($('.ou-board-voice-panel'), 'one failed poll keeps the peek');
  await pollNow();
  assert.match(root.textContent as string, /Couldn't load the board/);
  assert.ok(
    $('.ou-board-voice-panel') === null && $('.ou-board-voice') === null,
    'a second failed poll takes the voice off',
  );

  answer = () => board({ voice: { ...voice, status: 'paused' } });
  await pollNow();
  assert.ok($('.ou-board-voice') !== null, 'the voice is back with the bridge');
  assert.ok($('.ou-board-voice-panel') === null, 'collapsed again, the peek was dropped');
  assert.ok($('main.ou-board'), 'and the board with it');
  assert.doesNotMatch(root.textContent as string, /Couldn't load the board/);
  answer = () => board();
  await pollNow();
});

test('a failed poll does not give back a button that is still waiting on its own call, nor take the Add title’s focus', async () => {
  requests.length = 0;
  answer = () => board({ phone: { on: false, bridge: true } });
  await pollNow();
  let release = () => {};
  held.set('/api/board/voice/phone', new Promise<void>((resolve) => (release = resolve)));
  await pickPhone(0);
  assert.equal(sentTo('/api/board/voice/phone').length, 1);
  await click($('[data-backlog-add-open]'));
  const title = $('[data-backlog-title]') as HTMLInputElement;
  assert.ok(document.activeElement === title);
  title.blur();
  // the bridge stops answering polls long enough to show the error, then comes back
  answer = () => new Error('network down');
  await pollNow();
  await pollNow();
  assert.match(root.textContent as string, /Couldn't load the board/);
  answer = () => board({ phone: { on: false, bridge: true } });
  await pollNow();
  assert.ok(
    ([...root.querySelectorAll('.ou-board-voice-phone button')] as HTMLButtonElement[]).every(
      (one) => one.disabled,
    ),
    'the phone call is still out, so its buttons wait',
  );
  assert.ok($('[data-backlog-add]'), 'the Add panel is still open');
  assert.ok(
    document.activeElement !== $('[data-backlog-title]'),
    'the board coming back does not take the focus',
  );
  await click($('[data-backlog-cancel]'));
  release();
  await idle();
  held.clear();
  assert.ok(
    ([...root.querySelectorAll('.ou-board-voice-phone button')] as HTMLButtonElement[]).every(
      (one) => !one.disabled,
    ),
    'free once the call returns',
  );
  answer = () => board();
  await pollNow();
});

test('a click on a card’s body brings its session forward and says Switching… until it is done; a click on a button does not', async () => {
  requests.length = 0;
  answer = () =>
    withCards(
      card({
        id: 'f-1',
        title: 'Has a tab',
        column: 'waiting',
        focus_session: 'tab-1',
        can_focus: true,
      }),
    );
  await pollNow();
  const target = $('[data-card="f-1"]') as HTMLElement;
  const button = target.querySelector('[data-focus]') as HTMLButtonElement;
  assert.equal(button.textContent, 'Open in iTerm');
  let release = () => {};
  held.set('/api/board/focus', new Promise<void>((resolve) => (release = resolve)));
  await click(target.querySelector('.ou-board-title'));
  assert.deepEqual(sentTo('/api/board/focus')[0].body, { session: 'tab-1' });
  assert.equal(button.textContent, 'Switching…');
  assert.equal(button.disabled, true);
  release();
  await idle();
  held.clear();
  assert.equal(button.textContent, 'Open in iTerm');
  assert.equal(button.disabled, false);
  assert.equal(sentTo('/api/board/focus').length, 1);
  // the button asks once, not twice (its click is not also the card's)
  await click(button);
  assert.equal(sentTo('/api/board/focus').length, 2);
  answer = () => board();
  await pollNow();
});

test('Build story and Start and Stop listening ask first, then type into the session or stop the listener', async () => {
  requests.length = 0;
  answer = () =>
    ({
      ...withCards(
        card({
          id: 'b-1',
          title: 'Needs a story',
          column: 'waiting',
          build: { session: 'idle-s', prompt: '/once-upon acme/widgets#4', blocked: null },
        }),
      ),
      listeners: [
        {
          repo: 'acme/widgets',
          active: null,
          last_seen: null,
          candidates: [{ id: 'l-1', title: 'listener one', status: 'idle', since: null }],
        },
        {
          repo: 'acme/gadgets',
          active: {
            consumer: 'c-1',
            session: 'g-s',
            title: 'gadget session',
            can_focus: false,
            state: 'waiting',
            since: null,
            last_handled_at: null,
          },
          last_seen: null,
          candidates: [],
        },
      ],
    }) as BoardData;
  await pollNow();
  sure = false;
  await click($('[data-build="idle-s"]'));
  assert.match(confirmed.at(-1) as string, /\/once-upon acme\/widgets#4/);
  assert.deepEqual(requests, [], 'a no types nothing');
  sure = true;
  await click($('[data-build="idle-s"]'));
  assert.deepEqual(sentTo('/api/board/type')[0].body, { kind: 'build', session: 'idle-s' });

  requests.length = 0;
  await click($('[data-start-listening="acme/widgets"]'));
  assert.match(confirmed.at(-1) as string, /\/once-upon-listen acme\/widgets/);
  assert.deepEqual(sentTo('/api/board/type')[0].body, {
    kind: 'listen',
    session: 'l-1',
    repo: 'acme/widgets',
  });

  requests.length = 0;
  sure = false;
  await click($('[data-stop-listening="acme/gadgets"]'));
  assert.deepEqual(requests, []);
  sure = true;
  await click($('[data-stop-listening="acme/gadgets"]'));
  assert.deepEqual(sentTo('/api/board/stop-listening'), [
    { method: 'POST', path: '/api/board/stop-listening', body: { repo: 'acme/gadgets' } },
  ]);
  answer = () => board();
  await pollNow();
});

test('standing helpers are a row under the Listeners, with the session and the last request, and none when there are none', async () => {
  answer = () =>
    board({
      helpers: [
        {
          name: 'backlog-clerk',
          state: 'waiting',
          session: 'main-session-1',
          title: 'main one',
          can_focus: false,
          last_request_at: new Date(Date.now() - 40 * 60000).toISOString(),
        },
      ],
    });
  await pollNow();
  const row = $('[data-helper="backlog-clerk"]') as HTMLElement;
  assert.match(row.textContent ?? '', /backlog-clerk/);
  assert.match(row.textContent ?? '', /Standing by/);
  assert.match(row.textContent ?? '', /main one/);
  assert.match(row.textContent ?? '', /last request 40m ago/);
  assert.equal(all('.ou-board-listeners h2').at(-1)?.textContent?.startsWith('Helpers'), true);
  answer = () => board();
  await pollNow();
  assert.equal(all('[data-helper]').length, 0);
});

test('Open story, Push and Mark reviewed each ask the bridge for the right thing', async () => {
  requests.length = 0;
  opened.length = 0;
  const story = (id: string, over: Partial<NonNullable<BoardCard['story']>> = {}) => ({
    id,
    kind: 'local' as const,
    url: null,
    reviewed: false,
    unread: false,
    unread_answers: 0,
    approved_at: null,
    ship: null,
    ...over,
  });
  answer = () =>
    withCards(
      card({ id: 'r-1', title: 'To review', column: 'ready', story: story('st-ready') }),
      card({
        id: 's-1',
        title: 'To ship',
        column: 'ship',
        story: story('st-ship', { approved_at: '2026-10-29T11:00:00Z', ship: 'push' }),
      }),
    );
  await pollNow();
  await click($('[data-open-local="st-ready"]'));
  assert.deepEqual(sentTo('/api/board/open-story')[0].body, { story: 'st-ready' });
  assert.deepEqual(opened, ['http://x/story?k=1']);

  await click($('[data-push-local="st-ship"]'));
  assert.deepEqual(sentTo('/api/board/open-story')[1].body, { story: 'st-ship' });
  assert.deepEqual(
    opened.at(-1),
    'http://x/story?k=1&push=1',
    'Push opens the story with its Push box',
  );

  await click($('[data-mark-local="st-ready"]'));
  assert.deepEqual(sentTo('/api/board/reviewed'), [
    { method: 'POST', path: '/api/board/reviewed', body: { story: 'st-ready' } },
  ]);
  assert.equal(
    $('[data-mark-local="st-ship"]'),
    null,
    'a story ready to ship is not marked reviewed',
  );
  answer = () => board();
  await pollNow();
});

test('a finished agent’s card shows its notes and when it leaves, and Finish asks the bridge to clear it', async () => {
  requests.length = 0;
  confirmed.length = 0;
  sure = true;
  const agentCard = (name: string, state: BoardAgent['state'], over: Partial<BoardAgent> = {}) =>
    card({
      id: `agent:abcdef01:${name}`,
      kind: 'agent',
      title: name,
      repo: null,
      column: 'waiting',
      detail: 'the result',
      parent: 'main-session',
      agents: [
        {
          name,
          state,
          review: false,
          status: 'done',
          task: null,
          model: null,
          started_at: null,
          ended_at: '2026-10-29T11:50:00Z',
          outcome: 'the result',
          stale: false,
          beat: null,
          gate: null,
          notes: 'notes/research/x.md',
          clears_at: new Date(Date.now() + 20 * 60000 - 5000).toISOString(),
          ...over,
        },
      ],
    });
  answer = () =>
    withCards(
      agentCard('finished-one', 'done'),
      agentCard('question-one', 'waiting', { clears_at: null }),
      agentCard('working-one', 'running', { clears_at: null, notes: null }),
      agentCard('parked-one', 'waiting', { review: true, clears_at: null }),
    );
  await pollNow();
  const finished = $('[data-card="agent:abcdef01:finished-one"]') as HTMLElement;
  assert.match(
    finished.querySelector('[data-agent-notes]')?.textContent ?? '',
    /notes\/research\/x\.md/,
  );
  assert.match(finished.querySelector('[data-agent-clears]')?.textContent ?? '', /in 20 min/);
  assert.equal(
    $('[data-card="agent:abcdef01:question-one"] [data-agent-clears]'),
    null,
    'a question has no timer',
  );
  assert.equal(
    $('[data-finish-agent="agent:abcdef01:working-one"]'),
    null,
    'no Finish on a working agent',
  );
  assert.equal(
    $('[data-finish-agent="agent:abcdef01:parked-one"]'),
    null,
    'nor on one parked on your review',
  );

  await click($('[data-finish-agent="agent:abcdef01:finished-one"]'));
  assert.deepEqual(sentTo('/api/board/agent/finish'), [
    {
      method: 'POST',
      path: '/api/board/agent/finish',
      body: { sid: 'abcdef01', name: 'finished-one' },
    },
  ]);
  assert.deepEqual(confirmed, [], 'a finished agent is cleared without asking');

  sure = false;
  await click($('[data-finish-agent="agent:abcdef01:question-one"]'));
  assert.equal(sentTo('/api/board/agent/finish').length, 1, 'declined: nothing sent');
  assert.match(confirmed[0], /still waiting on a question/);
  sure = true;
  await click($('[data-finish-agent="agent:abcdef01:question-one"]'));
  assert.deepEqual(sentTo('/api/board/agent/finish')[1].body, {
    sid: 'abcdef01',
    name: 'question-one',
  });
  answer = () => board();
  await pollNow();
});

test('Hide N on their author hides others’ PRs with nothing on you, and the choice is remembered', async () => {
  const theirs = card({
    id: 'p-1',
    title: 'Their PR',
    column: 'pr_open',
    pr: {
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Their PR',
      state: 'open',
      draft: false,
      branch: 'their/branch',
      author: 'sam',
      mine: false,
      review_requested: false,
      approvals: 0,
      required: null,
      review: null,
      checks: null,
      merge: null,
      merged_at: null,
      unresolved: 0,
      viewer_at: null,
      others_at: null,
    },
  });
  answer = () => withCards(theirs);
  await pollNow();
  assert.ok($('[data-card="p-1"]'));
  const toggle = $('[data-on-author-toggle]') as HTMLElement;
  assert.match(toggle.textContent as string, /Hide 1 on their author/);
  await click(toggle);
  assert.equal($('[data-card="p-1"]'), null, 'the card is hidden');
  assert.match($('[data-on-author-toggle]')?.textContent as string, /Show 1 on their author/);
  assert.equal(saved.get('ou-board-hide-on-author'), 'true');
  await pollNow();
  assert.equal($('[data-card="p-1"]'), null, 'a poll keeps it hidden');
  await click($('[data-on-author-toggle]'));
  assert.ok($('[data-card="p-1"]'));
  assert.equal(saved.get('ou-board-hide-on-author'), 'false');
  answer = () => board();
  await pollNow();
});

test('with no key the page says how to connect, and fills in once the bridge answers', async () => {
  refuse = 401;
  await pollNow();
  assert.ok($('main.ou-board'), 'one refusal keeps the last board');
  await pollNow();
  assert.ok($('.ou-not-connected'), 'two in a row show the Not connected page');
  assert.match($('.ou-not-connected h1')?.textContent as string, /Not connected yet/);
  assert.match($('.ou-not-connected')?.textContent as string, /once-upon board/);
  assert.equal($('header h1'), null);
  refuse = 0;
  await pollNow();
  assert.equal($('.ou-not-connected'), null);
  assert.ok($('main.ou-board'), 'the board is back');
});

test('the remembered settings are read back when the page loads', async () => {
  const world = withCards(
    card({
      id: 'p-2',
      column: 'pr_open',
      title: 'Their PR',
      pr: {
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
        title: 'Their PR',
        state: 'open',
        draft: false,
        branch: 'x',
        author: 'sam',
        mine: false,
        review_requested: false,
        approvals: 0,
        required: null,
        review: null,
        checks: null,
        merge: null,
        merged_at: null,
        unresolved: 0,
        viewer_at: null,
        others_at: null,
      },
    }),
  );
  answer = () => world;
  saved.set('ou-board-filter', 'widgets');
  saved.set('ou-board-idle-open', 'false');
  saved.set('ou-board-worktrees-open', 'false');
  saved.set('ou-board-hide-on-author', 'true');
  saved.set('ou-board-collapsed-lanes', '["backlog/widgets"]');
  // a fresh load: the old page's tree comes down and a new copy of the page starts
  render(null, root);
  const again = '../public/board.ts?reload';
  await import(again);
  await idle();
  assert.match($('[data-board-filter]')?.textContent as string, /Repo: widgets/);
  assert.equal($('[data-idle-toggle]')?.getAttribute('aria-expanded'), 'false');
  assert.equal($('.ou-board-trees-grid'), null, 'Worktrees folded');
  assert.equal($('[data-card="p-2"]'), null, 'their PR hidden');
  assert.match($('[data-on-author-toggle]')?.textContent as string, /Show 1 on their author/);
  assert.equal(
    $('[data-lane-toggle="backlog/widgets"]')?.getAttribute('aria-expanded'),
    'false',
    'the widgets Backlog heading is folded',
  );
  assert.equal(order().length, 0);
});
