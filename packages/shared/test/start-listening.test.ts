import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failedNote,
  idleFor,
  listenPlan,
  noSessionNote,
  typedNote,
  wireStartListening,
} from '../src/panel/start-listening.ts';
import { askWhoHtml, type Health } from '../src/panel/status-light.ts';
import type { ListenSession, ListenTarget } from '../src/types.ts';

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
  assert.equal(idleFor(ago(60 * 48), NOW), 'idle 2d');
});

test('the notes say what happened and keep Copy prompt as the way left', () => {
  const repo: ListenTarget = { scope: 'repo', repo: 'acme/widgets' };
  const story: ListenTarget = { scope: 'story' };
  assert.match(
    noSessionNote(repo, 'acme/widgets', '~/Development/widgets'),
    /No idle Claude Code session in acme\/widgets has an iTerm tab.*in ~\/Development\/widgets.*Copy prompt for Claude/,
  );
  assert.match(
    noSessionNote(story, 'acme/widgets', null),
    /in your acme\/widgets checkout.*Copy prompt for this story/,
  );
  assert.match(typedNote('tab a', repo, 'acme/widgets'), /“tab a” to listen for acme\/widgets/);
  assert.match(typedNote('tab a', story, 'acme/widgets'), /to listen for this story/);
  assert.match(
    failedNote('session busy'),
    /Couldn't start it: session busy\. Copy prompt still works/,
  );
});

/** Just enough of an element for wireStartListening: children, text, hidden, disabled, click. */
class Fake {
  children: (Fake | string)[] = [];
  hidden = true;
  disabled = false;
  className = '';
  title = '';
  type = '';
  textContent: string | null = '';
  onclick: (() => unknown) | null = null;
  ownerDocument = { createElement: () => new Fake() };
  replaceChildren(...nodes: (Fake | string)[]) {
    this.children = nodes;
  }
  append(...nodes: (Fake | string)[]) {
    this.children.push(...nodes);
  }
  querySelector(selector: string): Fake | null {
    const wanted = selector.replace('.', '');
    const found = (node: Fake | string): Fake | null => {
      if (typeof node === 'string') {
        return null;
      }
      return node.className === wanted ? node : node.children.map(found).find(Boolean) || null;
    };
    return this.children.map(found).find(Boolean) || null;
  }
  get text(): string {
    return this.children.map((node) => (typeof node === 'string' ? node : node.text)).join('');
  }
}

function wired(
  sessions: ListenSession[] | Error,
  start: (id: string) => Promise<void> = async () => {},
) {
  const button = new Fake();
  button.textContent = 'Start listening';
  const note = new Fake();
  const calls: string[] = [];
  const asked: ListenTarget[] = [];
  wireStartListening(
    button as unknown as HTMLButtonElement,
    note as unknown as HTMLElement,
    { scope: 'repo', repo: 'acme/widgets' },
    {
      sessions: async (target) => {
        asked.push(target);
        if (sessions instanceof Error) {
          throw sessions;
        }
        return sessions;
      },
      start: async (id) => {
        calls.push(id);
        await start(id);
      },
    },
    { repo: 'acme/widgets', checkout: '~/Development/widgets' },
  );
  return { button, note, calls, asked, click: async () => button.onclick?.() };
}

test('Start listening with no idle session says so and types nothing', async () => {
  const { button, note, calls, asked, click } = wired([]);
  await click();
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, [{ scope: 'repo', repo: 'acme/widgets' }]);
  assert.equal(note.hidden, false);
  assert.match(note.text, /No idle Claude Code session in acme\/widgets/);
  assert.equal(button.textContent, 'Start listening');
  assert.equal(button.disabled, false);
});

test('with one session it types into it, then says which', async () => {
  const { note, calls, click } = wired([session('a', 3)]);
  await click();
  assert.deepEqual(calls, ['a']);
  assert.match(note.text, /Typed into “tab a” to listen for acme\/widgets/);
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
  const picks = (note.children[0] as Fake).children.filter(
    (node): node is Fake => node instanceof Fake,
  );
  assert.deepEqual(
    picks.map((pick) => pick.textContent),
    ['tab b · idle 28m', 'tab a · idle 30m'],
  );
  await picks[1].onclick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['a']);
  assert.match(note.text, /Typed into “tab a”/);
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
  assert.match(refused.note.text, /Couldn't start it: session busy\. Copy prompt still works/);
  assert.equal(refused.button.disabled, false);
  const down = wired(new Error('the bridge is not running'));
  await down.click();
  assert.match(down.note.text, /Couldn't start it: the bridge is not running/);
  assert.deepEqual(down.calls, []);
  assert.equal(down.button.textContent, 'Start listening');
});

test('the story line offers Start listening only where the host can, beside Copy prompt for this story', () => {
  const result = {
    level: 'ok' as const,
    prompt: '/once-upon-listen acme/widgets',
    storyPrompt: { prompt: '/once-upon-listen --story acme-widgets-7' },
    answering: null,
  } as Health;
  const without = String(askWhoHtml(result));
  assert.doesNotMatch(without, /Start listening/);
  assert.match(without, /Copy prompt for this story/);
  const withStart = String(askWhoHtml(result, true));
  assert.match(withStart, /class="ou-startstory"[^>]*>Start listening for this story</);
  assert.match(withStart, /class="ou-startnote"/);
  assert.match(withStart, /Copy prompt for this story/);
  assert.doesNotMatch(
    String(askWhoHtml({ ...result, answering: { consumer: 'x', scope: 'story' } } as Health, true)),
    /Start listening/,
    'a story that has its own listener needs none',
  );
});
