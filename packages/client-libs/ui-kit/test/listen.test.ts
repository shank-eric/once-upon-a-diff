import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, tick, fire } from './preact-env.ts';
import type { ListenOffer } from '../src/listen.ts';
import type { ListenSession, ListenTarget } from '@once-upon-a-diff/contracts/types';

const {
  failedNote,
  idleFor,
  listenPlan,
  lineFor,
  noSessionNote,
  queuedNote,
  typedNote,
  wireStartListening,
} = await import('../src/listen.ts');

const NOW = Date.UTC(2026, 9, 28, 18, 0);
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const session = (id: string, minutes: number | null): ListenSession => ({
  id,
  title: `tab ${id}`,
  status: 'idle',
  since: minutes === null ? null : ago(minutes),
});

test('no session: nothing to type into. One, or one clearly fresher: typed at once. Several close together: choose, freshest first', () => {
  assert.deepEqual(listenPlan([]), { kind: 'none' });
  assert.deepEqual(listenPlan([session('a', null)]), { kind: 'one', session: session('a', null) });
  assert.deepEqual(listenPlan([session('old', 90), session('new', 2)]), {
    kind: 'one',
    session: session('new', 2),
  });
  const close = listenPlan([session('a', 30), session('b', 28), session('c', 29)]);
  assert.equal(close.kind, 'choose');
  assert.deepEqual(close.kind === 'choose' && close.sessions.map((one) => one.id), ['b', 'c', 'a']);
});

test('how long a session has been idle, for the chooser', () => {
  assert.equal(idleFor(null, NOW), '');
  assert.equal(idleFor('nope', NOW), '');
  assert.equal(idleFor(ago(0), NOW), 'idle just now');
  assert.equal(idleFor(ago(12), NOW), 'idle 12m');
  assert.equal(idleFor(ago(180), NOW), 'idle 3h');
  assert.equal(idleFor(ago(60 * 23), NOW), 'idle 23h');
  assert.equal(idleFor(ago(60 * 24), NOW), 'idle 1d');
  assert.equal(idleFor(ago(60 * 47), NOW), 'idle 1d');
  assert.equal(idleFor(ago(60 * 48), NOW), 'idle 2d');
});

test('the notes say what happened, and with no session to type into say why and to run the line by hand', () => {
  const repo: ListenTarget = { scope: 'repo', repo: 'acme/widgets' };
  const story: ListenTarget = { scope: 'story' };
  assert.equal(
    noSessionNote(repo, 'acme/widgets', '~/Development/widgets', false),
    "iTerm isn't set up here, so there is no tab to type into. Run this line in Claude Code in ~/Development/widgets:",
  );
  assert.match(
    noSessionNote(repo, 'acme/widgets', null, true),
    /No idle Claude Code session in acme\/widgets has an iTerm tab.*Run this line in Claude Code in your acme\/widgets checkout, or start a session there and click Start listening again:$/,
  );
  assert.match(
    noSessionNote(story, 'acme/widgets', null),
    /click Start listening for this story again:$/,
  );
  assert.match(
    queuedNote('~/Development/widgets', 'acme/widgets'),
    /^Queued for 15 minutes\. Send any message in a Claude Code session in ~\/Development\/widgets and it will start listening \(needs the hook: once-upon install-hooks\)\.$/,
  );
  assert.match(typedNote('tab a', repo, 'acme/widgets'), /“tab a” to listen for acme\/widgets/);
  assert.match(typedNote('tab a', story, 'acme/widgets'), /to listen for this story/);
  assert.equal(failedNote('session busy'), "Couldn't start it: session busy.");
});

test('the line to run by hand is the story’s own for a story target, else the answer’s line', () => {
  const offer = (extra: Partial<ListenOffer> = {}): ListenOffer => ({
    sessions: [],
    line: '/once-upon-listen acme/widgets --keep',
    typing: false,
    ...extra,
  });
  const story = '/once-upon-listen --story s-1 --keep';
  assert.equal(lineFor(offer(), { scope: 'repo', repo: 'acme/widgets' }), offer().line);
  assert.equal(lineFor(offer({ storyLine: story }), { scope: 'story' }), story);
  assert.equal(
    lineFor(offer({ storyLine: story }), { scope: 'repo', repo: 'acme/widgets' }),
    offer().line,
  );
  assert.equal(lineFor(offer(), { scope: 'story' }), offer().line);
});

const LINE = '/once-upon-listen acme/widgets --keep';

function wired(
  sessions: ListenSession[] | Error,
  start: (id: string) => Promise<void> = async () => {},
  options: { typing?: boolean; queue?: (target: ListenTarget) => Promise<unknown> } = {},
) {
  const button = document.createElement('button');
  button.textContent = 'Start listening';
  const note = document.createElement('div');
  note.hidden = true;
  const calls: string[] = [];
  const asked: ListenTarget[] = [];
  wireStartListening(
    button,
    note,
    { scope: 'repo', repo: 'acme/widgets' },
    {
      sessions: async (target) => {
        asked.push(target);
        if (sessions instanceof Error) {
          throw sessions;
        }
        return { sessions, line: LINE, typing: options.typing ?? true };
      },
      start: async (id) => {
        calls.push(id);
        await start(id);
      },
      ...(options.queue ? { queue: options.queue } : {}),
    },
    { repo: 'acme/widgets', checkout: '~/Development/widgets' },
  );
  return {
    button,
    note,
    calls,
    asked,
    click: async () => {
      fire(button, 'click');
      await tick();
    },
  };
}

test('Start listening with no idle session says so, shows the line with Copy, and types nothing', async () => {
  const { button, note, calls, asked, click } = wired([]);
  await click();
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, [{ scope: 'repo', repo: 'acme/widgets' }]);
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /No idle Claude Code session in acme\/widgets/);
  assert.match(note.textContent, /Run this line in Claude Code in ~\/Development\/widgets/);
  assert.ok(note.textContent.includes(LINE));
  assert.ok(note.textContent.includes('Copy'));
  assert.equal(button.textContent, 'Start listening');
  assert.equal(button.disabled, false);
});

/** The buttons in the note's line box, by label. */
const buttonsOf = (note: HTMLElement): HTMLButtonElement[] => [
  ...note.querySelectorAll<HTMLButtonElement>('.ou-startline button'),
];

test('with no iTerm the note says so, and Queue (when the host has it) queues the target and says how it starts', async () => {
  const queued: ListenTarget[] = [];
  const { note, calls, click } = wired([], undefined, {
    typing: false,
    queue: async (target) => queued.push(target),
  });
  await click();
  assert.match(note.textContent, /^iTerm isn't set up here, so there is no tab to type into\./);
  assert.ok(note.textContent.includes(LINE));
  const [copy, queue] = buttonsOf(note);
  assert.equal(copy.textContent, 'Copy');
  assert.equal(queue.textContent, 'Queue for my next message');
  fire(queue, 'click');
  await tick();
  assert.deepEqual(queued, [{ scope: 'repo', repo: 'acme/widgets' }]);
  assert.match(
    note.textContent,
    /^Queued for 15 minutes\. Send any message in a Claude Code session in ~\/Development\/widgets/,
  );
  assert.deepEqual(calls, []);
});

test('a host with no queue gets only Copy, and a queue the bridge refuses shows its words', async () => {
  const plain = wired([]);
  await plain.click();
  assert.deepEqual(
    buttonsOf(plain.note).map((one) => one.textContent),
    ['Copy'],
  );
  const refused = wired([], undefined, {
    queue: async () => {
      throw new Error('a session is already listening for that');
    },
  });
  await refused.click();
  fire(buttonsOf(refused.note)[1], 'click');
  await tick();
  assert.match(
    refused.note.textContent,
    /Couldn't start it: a session is already listening for that\./,
  );
});

test('with one session it types into it, then says which', async () => {
  const { note, calls, click } = wired([session('a', 3)]);
  await click();
  assert.deepEqual(calls, ['a']);
  assert.match(note.textContent, /Typed into “tab a” to listen for acme\/widgets/);
});

test('with several close together it lists them, and a click on one types into that one', async () => {
  const lately = (id: string, minutes: number): ListenSession => ({
    id,
    title: `tab ${id}`,
    status: 'idle',
    since: new Date(Date.now() - minutes * 60000).toISOString(),
  });
  const { note, calls, click } = wired([lately('a', 30), lately('b', 28)]);
  await click();
  assert.deepEqual(calls, []);
  const picks = [...note.querySelectorAll<HTMLButtonElement>('.ou-startpick button')];
  assert.deepEqual(
    picks.map((pick) => pick.textContent),
    ['tab b · idle 28m', 'tab a · idle 30m'],
  );
  fire(picks[1], 'click');
  await tick();
  assert.deepEqual(calls, ['a']);
  assert.match(note.textContent, /Typed into “tab a”/);
});

test('clicking again closes the chooser', async () => {
  const { note, calls, click } = wired([session('a', 30), session('b', 28)]);
  await click();
  assert.ok(note.querySelector('.ou-startpick'));
  await click();
  assert.equal(note.hidden, true);
  assert.deepEqual(calls, []);
});

test('the bridge refusing (busy, tab gone) or not answering shows its words, and the button comes back', async () => {
  const refused = wired([session('a', 3)], async () => {
    throw new Error('session busy');
  });
  await refused.click();
  assert.match(refused.note.textContent, /Couldn't start it: session busy\./);
  assert.equal(refused.button.disabled, false);
  const down = wired(new Error('the bridge is not running'));
  await down.click();
  assert.match(down.note.textContent, /Couldn't start it: the bridge is not running/);
  assert.deepEqual(down.calls, []);
  assert.equal(down.button.textContent, 'Start listening');
});
