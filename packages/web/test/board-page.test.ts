import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, saved, tick, fire, window } from './dom-env.ts';
import { render } from '../public/vendor/preact.mjs';
import type {
  BoardAgent,
  BoardCard,
  BoardData,
  BoardEditor,
  BoardVoice,
  BoardWorktree,
} from '@once-upon-a-diff/protocol/types';

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
const backlog = (id: string, lane = 'widgets'): BoardCard =>
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
      assign: { prompt: `Start backlog card ${id}: Item ${id}` },
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
  editors: [],
  voice_paused: false,
  listeners: [],
  helpers: [],
  blank: [],
  lanes: [
    {
      key: 'widgets',
      name: 'widgets',
      cards: [
        backlog('bl_1'),
        backlog('bl_2'),
        backlog('bl_3'),
        card({ id: 'w-1', title: 'Working on it' }),
        idleCard,
      ],
    },
    {
      key: 'gadgets',
      name: 'gadgets',
      cards: [backlog('bl_9', 'gadgets'), card({ id: 'g-1', lane: 'gadgets' })],
    },
  ],
  worktrees: {
    at: null,
    scanning: false,
    total: 1,
    on_cards: 0,
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
/** A POST path the bridge refuses with this status and reason. */
const refused = new Map<string, { status: number; error: string }>();
/** A POST path held until `release` is called, to see a button while its call is out. */
const held = new Map<string, Promise<void>>();
let poll = () => {};
/**
 * The room the columns area has, as the tabs measure it (linkedom has no layout): wide by default. A resize tells the
 * page's observers. The default board needs 1560px for its 7 columns.
 */
const WIDE = 2000;
const NARROW = 1200;
let room = WIDE;
const observers = new Set<() => void>();
const resizeTo = async (width: number) => {
  room = width;
  observers.forEach((measure) => measure());
  await tick();
  await tick();
};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
  get: () => room,
  configurable: true,
});
Object.assign(globalThis, {
  ResizeObserver: class {
    measure: () => void;
    constructor(measure: () => void) {
      this.measure = measure;
    }
    observe() {
      observers.add(this.measure);
    }
    disconnect() {
      observers.delete(this.measure);
    }
  },
});
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
      const refusal = refused.get(path);
      if (refusal) {
        return {
          ok: false,
          status: refusal.status,
          json: async () => ({ error: refusal.error }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, url: 'http://x/story?k=1', session: 'clarifi-da' }),
      };
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
        key: 'widgets',
        name: 'widgets',
        cards: [
          ...ids.map((id) => backlog(id, 'widgets')),
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
  const meters = all('.ou-board-meters .ou-ui-meter');
  assert.equal(meters.length, 2);
  assert.equal(meters[0].getAttribute('aria-valuenow'), '75');
  assert.ok(meters[0].className.includes('ou-ui-usage-warn'), 'yellow from 70%');
  assert.match($('[data-board-filter]')?.textContent as string, /Repo: All/);
});

test('Research shows only with a card in it, sits right after Waiting, and is not counted as on you', async () => {
  const headings = () =>
    all('.ou-board-groups .ou-board-col').map((one) => one.getAttribute('aria-label'));
  const titleBefore = document.title;
  assert.ok(!headings().includes('Research'), 'no card, no column');
  try {
    answer = () =>
      withCards(card({ id: 'rs-1', kind: 'agent', column: 'research', title: 'ou-scout' }));
    await pollNow();
    const order = headings();
    assert.equal(order.indexOf('Research'), order.indexOf('Waiting') + 1, 'after Waiting');
    assert.equal($('.ou-board-c-research .ou-board-head .ou-local-muted')?.textContent, '1');
    assert.match(
      $('.ou-local-top-main .ou-local-muted')?.textContent as string,
      /· 1 research · /,
      'the summary line says so',
    );
    assert.equal(document.title, titleBefore, 'the tab title count is only what is on you');
  } finally {
    answer = () => board();
    await pollNow();
  }
  assert.ok(!headings().includes('Research'), 'gone with its card');
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

test('Edit opens a form on the card with its title, note and repo; Save sends only what changed; Cancel closes it', async () => {
  requests.length = 0;
  const item = cardOf('bl_1');
  assert.equal(item.querySelector('[data-backlog-edit-form]'), null);
  await click(item.querySelector('[data-backlog-edit="bl_1"]'));
  const form = item.querySelector('[data-backlog-edit-form]') as HTMLElement;
  assert.ok(form, 'the form is open on the card');
  const title = form.querySelector('[name="title"]') as HTMLInputElement;
  const note = form.querySelector('[name="note"]') as HTMLInputElement;
  const repo = form.querySelector('[name="repo"]') as HTMLInputElement;
  assert.equal(title.value, 'Item bl_1');
  assert.equal(repo.value, 'acme/widgets');
  title.value = '  Better title ';
  note.value = 'a new note';
  await pollNow();
  assert.ok(item.querySelector('[name="title"]') === title, 'typing stays through a poll');
  assert.equal(title.value, '  Better title ');
  fire(form, 'submit');
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/edit'), [
    {
      method: 'POST',
      path: '/api/board/backlog/edit',
      body: { id: 'bl_1', title: 'Better title', note: 'a new note' },
    },
  ]);
  assert.equal(item.querySelector('[data-backlog-edit-form]'), null, 'closed after the save');

  requests.length = 0;
  await click(item.querySelector('[data-backlog-edit="bl_1"]'));
  await click(item.querySelector('[data-backlog-edit-cancel]'));
  assert.equal(item.querySelector('[data-backlog-edit-form]'), null);
  assert.deepEqual(requests, []);
});

test('Edit keeps a multi-line note whole when only the title changes, and Alt+Arrow in the form does not reorder', async () => {
  requests.length = 0;
  answer = () => {
    const world = withOrder('bl_1', 'bl_2');
    world.lanes[0].cards[0].detail = 'line one\nline two';
    return world;
  };
  await pollNow();
  const item = cardOf('bl_1');
  await click(item.querySelector('[data-backlog-edit="bl_1"]'));
  const form = item.querySelector('[data-backlog-edit-form]') as HTMLElement;
  const note = form.querySelector('[name="note"]') as HTMLTextAreaElement;
  assert.equal(note.tagName, 'TEXTAREA');
  assert.equal(note.value, 'line one\nline two');
  const title = form.querySelector('[name="title"]') as HTMLInputElement;
  title.value = 'Renamed';
  fire(title, 'keydown', { key: 'ArrowDown', altKey: true });
  fire(note, 'keydown', { key: 'ArrowUp', altKey: true });
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/move'), [], 'no reorder from inside the form');
  fire(form, 'submit');
  await tick();
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/edit'), [
    { method: 'POST', path: '/api/board/backlog/edit', body: { id: 'bl_1', title: 'Renamed' } },
  ]);
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

test('Assign is always on and asks the bridge to tell the voice session: the id only, no confirm, and the answer shows', async () => {
  requests.length = 0;
  confirmed.length = 0;
  const button = $('[data-backlog-assign="bl_1"]') as HTMLButtonElement;
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-haspopup'), false, 'no menu of sessions');
  await click(button);
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/assign')[0].body, { id: 'bl_1' });
  assert.deepEqual(confirmed, [], 'nothing is asked first');
  assert.match($('[data-backlog-assign-note="sent"]')?.textContent as string, /Sent to clarifi-da/);

  // the bridge's reason for a refusal shows beside the button, not in an alert
  alerts.length = 0;
  refused.set('/api/board/backlog/assign', {
    status: 409,
    error: 'the session is waiting for you',
  });
  await click($('[data-backlog-assign="bl_2"]'));
  await tick();
  assert.match(
    $('[data-backlog-assign-note="refused"]')?.textContent as string,
    /Not sent: the session is waiting for you/,
  );
  assert.deepEqual(alerts, []);
  refused.clear();
});

test('Drop is on the card, Copy start line is not: Drop asks the bridge to drop that item', async () => {
  requests.length = 0;
  assert.equal(all('[data-backlog-copy]').length, 0);
  await click($('[data-backlog-drop="bl_3"]'));
  assert.deepEqual(sentTo('/api/board/backlog/drop')[0].body, { id: 'bl_3' });
});

test('the Someday button is only on a card in the Backlog column', async () => {
  const working = { ...backlog('bl_busy'), column: 'working' as const };
  const done = { ...backlog('bl_tried'), column: 'done' as const };
  answer = () => withCards(working, done);
  await pollNow();
  assert.equal($('[data-backlog-someday="bl_busy"]'), null, 'working: no button');
  assert.equal($('[data-backlog-someday="bl_tried"]'), null, 'done: no button');
  assert.ok($('[data-backlog-someday="bl_1"]'), 'a Backlog card has it');
  answer = () => board();
  await pollNow();
});

test('a someday card is out of the Backlog lanes and its count, in a Someday section closed until opened', async () => {
  requests.length = 0;
  const later = backlog('bl_later');
  (later.backlog as { someday?: true }).someday = true;
  answer = () => withCards(later);
  await pollNow();
  assert.equal(cardOf('bl_later'), null, 'not in the Backlog column, and the section is closed');
  assert.deepEqual(order().sort(), ['bl_1', 'bl_2', 'bl_3', 'bl_9']);
  assert.match(
    $('.ou-local-top-main .ou-local-muted')?.textContent as string,
    /4 in backlog/,
    'the summary counts the main list',
  );
  const toggle = $('[data-someday-toggle]');
  assert.match(toggle?.textContent as string, /Someday\s+1/);
  assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
  await click(toggle);
  assert.equal($('[data-someday-toggle]')?.getAttribute('aria-expanded'), 'true');
  const shown = cardOf('bl_later');
  assert.ok(shown, 'the open section lists it');
  assert.ok($('[data-someday]')?.contains(shown));
  assert.equal(shown.querySelector('[data-backlog-assign]'), null, 'no Assign on a someday card');
  // Alt+Arrow on a someday card moves nothing: it is not in the lane's order, so a move would lose its old place
  fire(shown, 'keydown', { key: 'ArrowDown', altKey: true });
  fire(shown, 'keydown', { key: 'ArrowUp', altKey: true });
  await tick();
  assert.deepEqual(sentTo('/api/board/backlog/move'), []);
  // Back to backlog sends on:false; a main card's Someday button sends on:true
  await click(shown.querySelector('[data-backlog-someday]'));
  assert.deepEqual(sentTo('/api/board/backlog/someday')[0].body, { id: 'bl_later', on: false });
  await click($('[data-backlog-someday="bl_1"]'));
  assert.deepEqual(sentTo('/api/board/backlog/someday')[1].body, { id: 'bl_1', on: true });
  await click($('[data-someday-toggle]'));
  answer = () => board();
  await pollNow();
});

test('a claimed Backlog item whose agent is running takes the Working border, and one waiting takes the Waiting border', async () => {
  const claimed = (id: string, column: 'working' | 'waiting') => ({ ...backlog(id), column });
  answer = () => withCards(claimed('bl_run', 'working'), claimed('bl_wait', 'waiting'));
  await pollNow();
  assert.match(cardOf('bl_run').className, /ou-board-c-working/);
  assert.doesNotMatch(cardOf('bl_run').className, /ou-board-c-backlog/);
  assert.match(cardOf('bl_wait').className, /ou-board-c-waiting/);
  assert.match(cardOf('bl_1').className, /ou-board-c-backlog/);
  answer = () => board();
  await pollNow();
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
  assert.doesNotMatch(
    $('.ou-board-trees-lane .ou-board-head')?.textContent as string,
    /can be cleaned up/,
    'and the header counts only the lane’s removable ones',
  );
  assert.equal(saved.get('ou-board-filter'), 'gadgets');
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  assert.equal(order().length, 4);
  assert.match(
    $('.ou-board-trees-lane .ou-board-head')?.textContent as string,
    /1 can be cleaned up/,
  );
  assert.equal(saved.get('ou-board-filter'), '');
});

test('the repo filter ignores case: a worktree spelled everfi/x is listed and counted under a lane keyed EverFi/x', async () => {
  const world = board();
  world.lanes[1] = { key: 'EverFi/x', name: 'x', cards: [card({ id: 'x-1', lane: 'EverFi/x' })] };
  world.worktrees = {
    ...(world.worktrees as NonNullable<BoardData['worktrees']>),
    items: [{ ...tree, lane: 'everfi/x', lane_label: 'x' }],
  };
  answer = () => world;
  await pollNow();
  await click($('[data-board-filter]'));
  await click([...document.querySelectorAll('.ou-menu-item')][2] as HTMLElement);
  assert.equal($('.ou-board-trees-lane')?.querySelectorAll('.ou-board-tree').length, 1);
  assert.match(
    $('.ou-board-trees-lane .ou-board-head')?.textContent as string,
    /1 can be cleaned up/,
  );
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  answer = () => board();
  await pollNow();
});

test('the Worktrees header counts what the lane lists, with the ones on cards apart, under any filter', async () => {
  const head = () => $('.ou-board-trees-lane .ou-board-head')?.textContent as string;
  const listed = () => $('.ou-board-trees-lane')?.querySelectorAll('.ou-board-tree').length;
  const world = board();
  const onCards = card({ id: 'w-2', title: 'Has trees', worktrees: [tree, tree] });
  world.lanes[0].cards.push(onCards);
  world.lanes[1].cards.push(card({ id: 'g-2', lane: 'gadgets', worktrees: [tree] }));
  const gadgetsTree = {
    ...tree,
    path: '/work/g1',
    name: 'g1',
    lane: 'gadgets',
    removable: false,
    keep: ['dirty'],
    size_kb: 5,
  };
  world.worktrees = {
    at: null,
    scanning: false,
    total: 6,
    on_cards: 3,
    removable: 1,
    size_kb: 15,
    items: [tree, gadgetsTree, { ...gadgetsTree, path: '/work/g2', name: 'g2' }],
    prunable: [],
  };
  answer = () => world;
  await pollNow();
  assert.equal(listed(), 3);
  assert.match(head(), /Worktrees 3 1 can be cleaned up · 3 more on cards · 15K Hide/);
  assert.doesNotMatch(head(), /listed/);
  assert.doesNotMatch(head(), /on this Mac/);
  await click($('[data-board-filter]'));
  await click([...document.querySelectorAll('.ou-menu-item')][2] as HTMLElement);
  assert.equal(listed(), 2);
  assert.match(head(), /Worktrees 2 1 more on cards/);
  assert.doesNotMatch(head(), /listed/);
  assert.doesNotMatch(head(), /can be cleaned up/);
  await click($('[data-board-filter]'));
  await click([...document.querySelectorAll('.ou-menu-item')][1] as HTMLElement);
  assert.equal(listed(), 1);
  assert.match(head(), /1 can be cleaned up · 2 more on cards/);
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  answer = () => board();
  await pollNow();
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

test('too narrow for This Mac and GitHub side by side: two tabs, one group shown, the choice remembered, the other kept', async () => {
  const shown = () =>
    all('.ou-board-group')
      .filter((one) => !one.hasAttribute('hidden'))
      .map((one) => one.getAttribute('aria-labelledby'));
  assert.equal($('[role="tablist"]'), null, 'wide: no tabs');
  assert.equal(all('.ou-board-group').length, 2, 'wide: both groups side by side');
  assert.deepEqual(shown(), [null, null]);

  try {
    await resizeTo(NARROW);
    const tabs = all('[role="tab"]');
    assert.deepEqual(
      tabs.map((one) => one.textContent),
      ['On this Mac', 'On GitHub'],
    );
    assert.deepEqual(
      tabs.map((one) => one.getAttribute('aria-selected')),
      ['true', 'false'],
      'This Mac is the first choice',
    );
    assert.deepEqual(shown(), ['ou-board-tab-local']);
    assert.equal(all('.ou-board-group').length, 2, 'the other group stays drawn, hidden');
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') as string);
      assert.equal(panel?.getAttribute('aria-labelledby'), tab.id, 'each tab names a real panel');
      assert.equal(panel?.getAttribute('tabindex'), '0');
    }

    // text typed into the Add panel (in the This Mac group) survives a visit to the GitHub tab
    await click($('[data-backlog-add-open]'));
    const title = $('[data-backlog-title]') as HTMLInputElement;
    title.value = 'half typed';
    await click(tabs[1]);
    assert.deepEqual(shown(), ['ou-board-tab-github']);
    assert.equal(saved.get('ou-board-tab'), 'github');
    assert.deepEqual(
      all('[role="tab"]').map((one) => one.getAttribute('tabindex')),
      ['-1', '0'],
      'one tab stop, on the chosen tab',
    );
    await click(all('[role="tab"]')[0]);
    assert.ok($('[data-backlog-title]') === title, 'the same input');
    assert.equal(title.value, 'half typed');
    await click($('[data-backlog-cancel]'));

    // the arrow keys move between the tabs, and the focus goes with them
    fire($('[role="tablist"]') as HTMLElement, 'keydown', { key: 'ArrowRight' });
    await tick();
    assert.deepEqual(shown(), ['ou-board-tab-github']);
    assert.ok(document.activeElement === $('#ou-board-tab-github'), 'the focus follows');
    fire($('[role="tablist"]') as HTMLElement, 'keydown', { key: 'ArrowLeft' });
    await tick();
    assert.deepEqual(shown(), ['ou-board-tab-local']);
    assert.equal(saved.get('ou-board-tab'), 'local');
    fire($('[role="tablist"]') as HTMLElement, 'keydown', { key: 'End' });
    await tick();
    assert.deepEqual(shown(), ['ou-board-tab-github']);

    await pollNow();
    assert.deepEqual(shown(), ['ou-board-tab-github'], 'a poll keeps the tab');
    await resizeTo(WIDE);
    assert.equal($('[role="tablist"]'), null, 'wide again: no tabs');
    assert.deepEqual(shown(), [null, null], 'wide again: both groups');

    // the room the columns need grows with the optional ones: Agent checks, Ready to ship and Error are 222px each
    await resizeTo(1700);
    assert.equal($('[role="tablist"]'), null, '1700px holds the seven columns');
    answer = () => withCards(card({ id: 'ck-1', column: 'checks' }));
    await pollNow();
    assert.ok($('[role="tablist"]'), '1700px does not hold eight');
  } finally {
    await resizeTo(WIDE);
    answer = () => board();
    await pollNow();
    saved.delete('ou-board-tab');
  }
});

test('the Tabs button in the header puts the two tabs on a wide board, and the choice is remembered', async () => {
  const shown = () =>
    all('.ou-board-group')
      .filter((one) => !one.hasAttribute('hidden'))
      .map((one) => one.getAttribute('aria-labelledby'));
  const button = () => $('[data-board-tabs]') as HTMLElement;
  assert.equal(room, WIDE);
  assert.equal(button().getAttribute('aria-pressed'), 'false', 'off by default');
  assert.equal($('[role="tablist"]'), null, 'off: the columns side by side');
  assert.deepEqual(shown(), [null, null]);

  try {
    await click(button());
    assert.equal(button().getAttribute('aria-pressed'), 'true');
    assert.equal(saved.get('ou-board-tabs'), 'true');
    assert.ok($('[role="tablist"]'), 'on: the tabs at a wide width');
    assert.equal(shown().length, 1, 'one group shown');
    await click(all('[role="tab"]')[1]);
    assert.deepEqual(shown(), ['ou-board-tab-github']);

    // a narrow page has tabs whatever the button says
    await click(button());
    assert.equal(saved.get('ou-board-tabs'), 'false');
    assert.equal($('[role="tablist"]'), null, 'off again: no tabs');
    await resizeTo(NARROW);
    assert.ok($('[role="tablist"]'), 'narrow: tabs, with the button off');
    await resizeTo(WIDE);
    assert.equal($('[role="tablist"]'), null);
  } finally {
    saved.delete('ou-board-tabs');
    saved.delete('ou-board-tab');
    if (button().getAttribute('aria-pressed') === 'true') {
      await click(button());
    }
  }
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

const EDITOR: BoardEditor = {
  lane: 'widgets',
  label: 'widgets',
  title: 'alpha',
  session: 'editor-session-1',
  can_focus: true,
  name: 'editor-widgets',
  slots: 3,
  in_use: 1,
  since: '2026-10-29T10:00:00Z',
  authors: [
    {
      key: 'abcdef01:ou-a',
      name: 'ou-a',
      state: 'running',
      review: false,
      task: 'build a',
      beat: { n: 3, of: 6, step: 'code', note: '' },
    },
    {
      key: 'abcdef01:ou-b',
      name: 'ou-b',
      state: 'plan',
      review: false,
      task: 'build b',
      beat: null,
    },
  ],
};

test('no overall builder count in the header; the editors strip shows each editor with its slots in use and its authors', async () => {
  answer = () => board({ editors: [EDITOR] });
  await pollNow();
  assert.equal($('[data-builders-free]'), null);
  assert.equal($('.ou-local-top [data-editor]'), null, 'not in the top header');
  const row = $('[data-editor="editor-widgets"]') as HTMLElement;
  assert.ok(row, 'the strip is above the columns');
  assert.deepEqual(
    [...document.querySelectorAll('[data-editor], .ou-board-groups')].map((one) =>
      one.hasAttribute('data-editor'),
    ),
    [true, false],
    'the strip comes before the columns',
  );
  assert.match(row.textContent ?? '', /widgets/);
  assert.equal(
    row.querySelector('[data-editor-slots]')?.textContent?.startsWith('1 of 3 slots · 2 authors'),
    true,
  );
  const authors = [...row.querySelectorAll('[data-author]')].map((one) =>
    one.textContent?.replace(/\s+/g, ' ').trim(),
  );
  assert.deepEqual(authors, ['● ou-a 3/6 code', '… ou-b plan ready']);
  assert.ok(row.querySelector('.ou-board-from'), 'a focus link to the editor’s tab');
  // the repo filter narrows it to its lane
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[2] as HTMLElement);
  assert.equal($('[data-editor]'), null);
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[1] as HTMLElement);
  assert.ok($('[data-editor]'));
  await click($('[data-board-filter]'));
  await click(document.querySelectorAll('.ou-menu-item')[0] as HTMLElement);
  answer = () => board();
  await pollNow();
  assert.equal(all('[data-editor]').length, 0, 'no editor, no strip');
});

test('an author’s row says which editor controls it', async () => {
  const withEditor = (editor: BoardAgent['editor'], kind: BoardCard['kind'] = 'work') =>
    board({
      lanes: [
        {
          key: 'widgets',
          name: 'widgets',
          cards: [
            card({
              id: 'w-2',
              kind,
              title: 'Building',
              agents: [
                {
                  key: 'abcdef01:ou-a',
                  sid: 'abcdef01',
                  name: 'ou-a',
                  kind: 'author',
                  editor,
                  state: 'running',
                  review: false,
                  status: 'working',
                  task: 'build a',
                  model: null,
                  started_at: null,
                  ended_at: null,
                  outcome: null,
                  stale: false,
                  beat: null,
                  gate: null,
                  notes: null,
                  clears_at: null,
                  summary: null,
                },
              ],
            }),
          ],
        },
      ],
    });
  answer = () =>
    withEditor({
      lane: 'widgets',
      label: 'widgets',
      title: 'alpha',
      session: 'editor-session-1',
      can_focus: true,
    });
  await pollNow();
  assert.match(
    $('[data-card="w-2"] .ou-board-agent-editor')?.textContent ?? '',
    /by Editor · widgets/,
  );
  // an agent's own card already says "from Editor ...": its row does not say it again
  answer = () =>
    withEditor(
      {
        lane: 'widgets',
        label: 'widgets',
        title: 'alpha',
        session: 'editor-session-1',
        can_focus: true,
      },
      'agent',
    );
  await pollNow();
  assert.equal($('[data-card="w-2"] .ou-board-agent-editor'), null);
  answer = () => withEditor(null);
  await pollNow();
  assert.equal($('[data-card="w-2"] .ou-board-agent-editor'), null);
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
  assert.deepEqual(sentTo('/api/board/type')[0].body, {
    kind: 'build',
    session: 'idle-s',
    card: 'b-1',
  });

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

test('a Ready author’s card: Build story sends its own card, Copy offers the request when it is blocked, Review opens the storyless page', async () => {
  requests.length = 0;
  opened.length = 0;
  const request = (branch: string) =>
    `Build the Once Upon story of the unpushed commits on branch ${branch} in /wt/${branch}`;
  const author = (name: string, branch: string, build: BoardCard['build']) =>
    card({
      id: `agent:aaaaaaaa:${name}`,
      kind: 'agent',
      title: name,
      column: 'ready',
      focus_session: 'launcher',
      can_focus: true,
      review: { branch, path: `/wt/${branch}` },
      build,
    });
  answer = () =>
    withCards(
      author('one', 'one', { session: 'launcher', prompt: request('one'), blocked: null }),
      author('two', 'two', { session: null, prompt: request('two'), blocked: 'session busy' }),
    );
  await pollNow();
  const one = '[data-card="agent:aaaaaaaa:one"]';
  const two = '[data-card="agent:aaaaaaaa:two"]';
  await click($(`${one} [data-build]`));
  assert.match(confirmed.at(-1) as string, /unpushed commits on branch one in \/wt\/one/);
  assert.deepEqual(sentTo('/api/board/type')[0].body, {
    kind: 'build',
    session: 'launcher',
    card: 'agent:aaaaaaaa:one',
  });
  assert.equal($(`${one} [data-copy-build]`), null, 'nothing to copy while it can be typed');
  assert.ok($(`${two} [data-copy-build]`), 'blocked: the request can be copied instead');
  assert.ok(($(`${two} .ou-board-build`) as HTMLButtonElement).disabled);

  await click($(`${two} [data-review]`));
  assert.deepEqual(sentTo('/api/board/review')[0].body, { card: 'agent:aaaaaaaa:two' });
  assert.equal(opened.at(-1), 'http://x/story?k=1');
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

test('a finished research agent shows its resolution and a copyable notes path, on its own card and inside another card', async () => {
  const notes = '~/Development/ClariFi/notes/research/2026-11-03-options.md';
  const agent = (name: string): BoardAgent => ({
    key: `abcdef01:${name}`,
    sid: 'abcdef01',
    name,
    kind: 'research',
    editor: null,
    state: 'done',
    review: false,
    status: 'done',
    task: 'compare the options',
    model: null,
    started_at: null,
    ended_at: '2026-10-29T11:50:00Z',
    outcome: 'use the second option: it needs no migration',
    stale: false,
    beat: null,
    gate: null,
    notes,
    clears_at: null,
    summary: null,
  });
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  try {
    answer = () =>
      withCards(
        card({
          id: 'agent:abcdef01:scout',
          kind: 'agent',
          title: 'scout',
          repo: null,
          column: 'research',
          detail: 'use the second option: it needs no migration',
          agents: [agent('scout')],
        }),
        card({ id: 'work-1', kind: 'work', title: 'a branch', agents: [agent('inside')] }),
      );
    await pollNow();
    for (const id of ['agent:abcdef01:scout', 'work-1']) {
      const one = $(`[data-card="${id}"]`) as HTMLElement;
      assert.equal(
        one.querySelector('[data-agent-detail]')?.textContent,
        'use the second option: it needs no migration',
        `${id}: the resolution`,
      );
      assert.equal(one.querySelectorAll('[data-agent-notes]').length, 1, `${id}: notes once`);
      assert.equal(one.querySelector('[data-agent-notes] code')?.textContent, notes);
    }
    await click($('[data-card="agent:abcdef01:scout"] [data-copy-notes]'));
    assert.deepEqual(copied, [notes], 'Copy puts the whole path on the clipboard');
    assert.equal($('[data-card="agent:abcdef01:scout"] [data-copy-notes]')?.textContent, 'Copied');
  } finally {
    if (clipboard) {
      Object.defineProperty(navigator, 'clipboard', clipboard);
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    answer = () => board();
    await pollNow();
  }
});

test('a finished agent’s card shows its notes and when it leaves, and Finish asks the bridge to clear it', async () => {
  requests.length = 0;
  confirmed.length = 0;
  sure = true;
  const agentCard = (
    name: string,
    state: BoardAgent['state'],
    over: Partial<BoardAgent> = {},
    id = `agent:abcdef01:${name}`,
  ) =>
    card({
      id,
      kind: 'agent',
      title: name,
      repo: null,
      column: 'waiting',
      detail: 'the result',
      parent: 'main-session',
      agents: [
        {
          key: `abcdef01:${name}`,
          sid: 'abcdef01',
          name,
          kind: null,
          editor: null,
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
          summary: null,
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
      agentCard('odd-one', 'done', {}, 'whatever-the-bridge-calls-it'),
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

  // the sid is the agent's own field, not read out of the card's id
  await click($('[data-finish-agent="whatever-the-bridge-calls-it"]'));
  assert.deepEqual(sentTo('/api/board/agent/finish')[2].body, { sid: 'abcdef01', name: 'odd-one' });
  answer = () => board();
  await pollNow();
});

test('a finished agent’s card says what it did, why it is done, and one meta line, with no agent line repeating it', async () => {
  const finished = card({
    id: 'agent:abcdef01:ou-rename',
    kind: 'agent',
    title: 'ou-rename',
    repo: null,
    column: 'done',
    detail: 'landed at fc59563 (closed 11/4 by sid 989b3246)',
    parent: null,
    since: new Date(Date.now() - 30 * 60000).toISOString(),
    agents: [
      {
        key: 'abcdef01:ou-rename',
        sid: 'abcdef01',
        name: 'ou-rename',
        kind: 'author',
        editor: null,
        state: 'done',
        review: false,
        status: 'done',
        task: 'card bl_x rename builders; plan stop',
        model: null,
        started_at: null,
        ended_at: new Date(Date.now() - 30 * 60000).toISOString(),
        outcome: 'landed at fc59563 (closed 11/4 by sid 989b3246)',
        stale: false,
        beat: null,
        gate: null,
        notes: 'notes/research/x.md',
        clears_at: new Date(Date.now() + 20 * 60000 - 5000).toISOString(),
        summary: { did: 'Rename builders to authors', why: 'landed fc59563' },
      },
    ],
  });
  answer = () => withCards(finished);
  await pollNow();
  const el = $('[data-card="agent:abcdef01:ou-rename"]') as HTMLElement;
  assert.equal(el.querySelector('[data-agent-did]')?.textContent, 'Rename builders to authors');
  assert.equal(el.querySelector('[data-agent-why]')?.textContent, 'landed fc59563');
  assert.equal(
    el.querySelector('[data-agent-meta]')?.textContent,
    'session ended · 30m ago · leaves in 20 min',
  );
  assert.equal(
    el.querySelector('.ou-board-agent'),
    null,
    'no agent line repeating name, state and time',
  );
  assert.doesNotMatch(
    el.textContent ?? '',
    /closed 11\/4|its session has ended/,
    'no free-text outcome',
  );
  assert.match(el.querySelector('[data-agent-notes]')?.textContent ?? '', /notes\/research\/x\.md/);
  assert.match(
    el.getAttribute('title') ?? '',
    /closed 11\/4 by sid 989b3246/,
    'the outcome on hover',
  );
  assert.ok(el.querySelector('[data-finish-agent="agent:abcdef01:ou-rename"]'), 'Finish stays');

  // no did line: only the why
  answer = () =>
    withCards({
      ...finished,
      agents: [{ ...finished.agents[0], summary: { did: null, why: 'done' } }],
    });
  await pollNow();
  const bare = $('[data-card="agent:abcdef01:ou-rename"]') as HTMLElement;
  assert.equal(bare.querySelector('[data-agent-did]'), null);
  assert.equal(bare.querySelector('[data-agent-why]')?.textContent, 'done');
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

test('a page that loads already narrow starts with the tabs, and the saved tab', async () => {
  saved.set('ou-board-tab', 'github');
  render(null, root);
  try {
    room = NARROW;
    const again = '../public/board.ts?narrow';
    await import(again);
    await idle();
    assert.ok($('[role="tablist"]'), 'the tabs are there from the first draw');
    assert.deepEqual(
      all('.ou-board-group')
        .filter((one) => !one.hasAttribute('hidden'))
        .map((one) => one.getAttribute('aria-labelledby')),
      ['ou-board-tab-github'],
    );
  } finally {
    room = WIDE;
    saved.delete('ou-board-tab');
  }
});

test('a wide page that loads with the Tabs button remembered on starts with the tabs', async () => {
  saved.set('ou-board-tabs', 'true');
  render(null, root);
  try {
    room = WIDE;
    const again = '../public/board.ts?tabs';
    await import(again);
    await idle();
    assert.ok($('[role="tablist"]'), 'the tabs are there from the first draw');
    assert.equal(($('[data-board-tabs]') as HTMLElement).getAttribute('aria-pressed'), 'true');
  } finally {
    saved.delete('ou-board-tabs');
  }
});
