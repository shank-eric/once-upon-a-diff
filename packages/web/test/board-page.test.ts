import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, saved, tick, fire } from './dom-env.ts';
import type { BoardData, BoardVoice } from '@once-upon-a-diff/shared/types';

/*
 * The board page itself, loaded as the browser loads it with a fake bridge behind fetch: the string-rendered board goes in
 * `main` and the voice panel (Preact) in `voiceHost`, and a redraw of the first never touches the second.
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
const board = (over: Partial<BoardData> = {}): BoardData => ({
  at: '2026-10-29T12:00:00Z',
  status_source: 'registry',
  warning: null,
  voice,
  phone: null,
  listeners: [],
  blank: [],
  lanes: [],
  worktrees: null,
  usage: null,
  ...over,
});

let answer: () => BoardData | Error = () => board();
const requests: string[] = [];
let poll = () => {};
Object.assign(globalThis, {
  location: { hash: '' },
  alert: () => {},
  matchMedia: () => ({ matches: false }),
  // the page polls on a timer: the test calls the poll itself
  setInterval: (callback: () => void) => {
    poll = callback;
    return 0;
  },
  fetch: async (path: string, init?: { method?: string }) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    const result = answer();
    if (result instanceof Error) {
      throw result;
    }
    return { ok: true, status: 200, json: async () => result };
  },
});
Object.defineProperty(document, 'visibilityState', { value: 'visible' });

await import('../public/board.ts');
await tick();

const [main, voiceHost] = [...root.children] as HTMLElement[];
const $ = (selector: string) => root.querySelector(selector) as HTMLElement | null;
const pollNow = async () => {
  poll();
  await tick();
  await tick();
};

test('the board page is two parts: strings in main, the voice panel in voiceHost', () => {
  assert.equal(root.children.length, 2);
  assert.equal(main.style.display, 'contents');
  assert.ok(main.querySelector('h1'), 'the strings drew the header in main');
  assert.ok(voiceHost.querySelector('.ou-board-voice'), 'the voice tab is in voiceHost');
  assert.ok(root.classList.contains('ou-board-has-voice'));
});

test('a redraw of the strings replaces what is in main and leaves the voice panel’s elements alone', async () => {
  const aside = voiceHost.querySelector('.ou-board-voice');
  const header = main.querySelector('h1');
  answer = () =>
    board({
      warning: 'iTerm is not answering',
      voice: { ...voice, lines: [...voice.lines, { who: 'you', text: 'more', at: 2 }] },
    });
  await pollNow();
  assert.match(main.textContent as string, /iTerm is not answering/);
  assert.ok(main.querySelector('h1') !== header, 'main was redrawn');
  assert.ok(
    root.children[0] === main && root.children[1] === voiceHost,
    'main and voiceHost are the same elements',
  );
  assert.ok(voiceHost.querySelector('.ou-board-voice') === aside, 'the panel is the same element');
});

test('clicks in the panel are the panel’s own: the page’s delegated click handler asks the bridge for nothing', async () => {
  answer = () => board();
  await pollNow();
  requests.length = 0;
  fire($('.ou-board-voice-tab') as HTMLElement, 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel'), 'the tab opened the panel');
  fire($('.ou-board-voice-close') as HTMLElement, 'click');
  await tick();
  assert.deepEqual(requests, []);
  assert.equal(saved.get('ou-board-voice-open'), 'false');
});

test('a peeked panel stays open through one failed poll and goes after two in a row', async () => {
  answer = () => board({ voice: { ...voice, status: 'paused' } });
  await pollNow();
  fire($('.ou-board-voice-tab') as HTMLElement, 'click');
  await tick();
  assert.ok($('.ou-board-voice-panel'), 'peeking');

  answer = () => new Error('network down');
  await pollNow();
  assert.match(main.textContent as string, /Couldn't load the board/);
  assert.ok($('.ou-board-voice-panel'), 'one failed poll keeps the peek');
  await pollNow();
  assert.ok(
    $('.ou-board-voice-panel') === null && $('.ou-board-voice') === null,
    'a second failed poll takes the voice off',
  );

  answer = () => board({ voice: { ...voice, status: 'paused' } });
  await pollNow();
  assert.ok($('.ou-board-voice') !== null, 'the voice is back with the bridge');
  assert.ok($('.ou-board-voice-panel') === null, 'collapsed again, the peek was dropped');
});
