import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, fire, tick, worker } from './preact-env.ts';
import type { Tag } from '../src/content/tag-model.ts';

// the effects Preact runs after the next frame, run at once
Object.assign(globalThis, {
  requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const { html, render } = await import('/assets/preact.mjs');
const { StoryTag, TagView } = await import('../src/content/components/story-tag.ts');
const { createTagHost, showTag, clickedTagButton } =
  await import('../src/content/components/tag-host.ts');
const { listenNotice } = await import('../src/content/components/listen-notice.ts');
const { toast } = await import('../src/content/components/toast.ts');

/** A node as markup with its attributes in alphabetical order (the order a document keeps them in is not what these pin). */
function canon(node: Node): string {
  if (node.nodeType === 3) {
    return (node.textContent as string).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }
  const element = node as Element;
  const attrs = [...element.attributes]
    .map((attr) => ` ${attr.name}="${attr.value}"`)
    .sort()
    .join('');
  const inside = [...element.childNodes].map(canon).join('');
  return `<${element.localName}${attrs}>${inside}</${element.localName}>`;
}

/** What a component draws, as canon markup. */
function drawn(vnode: Parameters<typeof render>[0]): string {
  const box = document.createElement('div');
  render(vnode, box);
  return [...box.childNodes].map(canon).join('');
}

const link: Tag = {
  kind: 'link',
  cls: 'ready',
  label: 'Story · 2 of 5 read',
  title: 'Opens the first one you haven’t read.',
  href: 'https://github.com/acme/widgets/pull/7/changes#ou-step-3',
};
const stale: Tag = {
  kind: 'button',
  act: 'update',
  base: 'abc1234',
  cls: 'stale',
  label: 'Story out of date · Update',
  title: 'Update (new commits): the story is for abc1234',
  alt: { act: 'retell', label: 'Re-tell', title: 'Re-tell from scratch' },
};

test('a link tag is an a.b with its class, href and title', () => {
  assert.equal(
    drawn(html`<${StoryTag} tag=${link} />`),
    '<a class="b ready" href="https://github.com/acme/widgets/pull/7/changes#ou-step-3" title="Opens the first one you haven’t read.">Story · 2 of 5 read</a>',
  );
});

test('a button tag is a button.b with data-act, and its small alt button follows it', () => {
  assert.equal(
    drawn(html`<${StoryTag} tag=${stale} />`),
    '<button class="b stale" data-act="update" title="Update (new commits): the story is for abc1234">Story out of date · Update</button>' +
      '<button class="alt" data-act="retell" title="Re-tell from scratch">Re-tell</button>',
  );
  const build: Tag = { kind: 'button', act: 'build', cls: '', label: 'Build story', title: 'Ask' };
  assert.equal(
    drawn(html`<${StoryTag} tag=${build} />`),
    '<button class="b" data-act="build" title="Ask">Build story</button>',
    'no alt button, and no class but b for a tag with none',
  );
});

test('a progress tag is a span.b that is not clickable and says it is live, with a spinner while building', () => {
  const building: Tag = {
    kind: 'progress',
    cls: 'building',
    label: 'Building…',
    spin: true,
    title: 'A Claude session is building the story',
  };
  assert.equal(
    drawn(html`<${StoryTag} tag=${building} />`),
    '<span aria-live="polite" class="b building" title="A Claude session is building the story"><span class="spin"></span>Building…</span>',
  );
  const queued: Tag = { kind: 'progress', cls: 'queued', label: 'Queued', title: 'Asked for' };
  assert.equal(
    drawn(html`<${StoryTag} tag=${queued} />`),
    '<span aria-live="polite" class="b queued" title="Asked for">Queued</span>',
  );
});

test('a label and a title are text and attributes, never markup', () => {
  const out = drawn(
    html`<${StoryTag} tag=${{ kind: 'progress', cls: '', label: '<x>', title: '"' }} />`,
  );
  assert.ok(!out.includes('<x'), 'the label is a text node, not an element');
  assert.match(out, /&lt;x/);
});

test('the answers badge follows the one tag, as a link that is not a second tag', () => {
  const badge = {
    href: 'https://github.com/acme/widgets/pull/7/changes#ou-ask',
    label: '1 new answer',
    title: 'An answer to your question in the story is unread.',
  };
  const box = document.createElement('div');
  render(html`<${TagView} tag=${link} badge=${badge} />`, box);
  assert.equal(box.querySelectorAll('.b').length, 1);
  assert.equal(
    canon(box.lastElementChild!),
    '<a class="ans" href="https://github.com/acme/widgets/pull/7/changes#ou-ask" title="An answer to your question in the story is unread.">1 new answer</a>',
  );
  assert.equal(drawn(html`<${TagView} tag=${link} badge=${null} />`).includes('ans'), false);
});

test('a tag host has its shadow root, its stylesheet and its slot, and draws the tag there once', () => {
  const clicks: Event[] = [];
  const host = createTagHost('data-ou-test', 'acme/widgets#7', (event) => clicks.push(event));
  document.body.appendChild(host);
  assert.equal(host.getAttribute('data-ou-test'), 'acme/widgets#7');
  assert.equal(host.tagName, 'SPAN');
  const shadow = host.shadowRoot!;
  const sheet = shadow.querySelector('link')!;
  assert.equal(sheet.getAttribute('rel'), 'stylesheet');
  assert.equal(
    sheet.getAttribute('href'),
    'chrome-extension://test/content/components/story-tag.css',
  );
  assert.equal(host.style.visibility, 'hidden', 'hidden until its stylesheet loads');
  const slot = shadow.querySelector('span.slot')!;
  assert.equal(slot.children.length, 0);

  showTag(host, stale, null);
  assert.equal(slot.children.length, 2);
  const button = slot.querySelector('button.b')!;
  assert.equal(button.textContent, 'Story out of date · Update');
  showTag(host, stale, null);
  assert.equal(slot.querySelector('button.b'), button, 'the same tag drawn again is the same node');
  showTag(host, link, {
    href: 'https://github.com/acme/widgets/pull/7/changes#ou-ask',
    label: '2 new answers',
    title: 't',
  });
  assert.deepEqual(
    [...slot.children].map((child) => [child.tagName, child.className]),
    [
      ['A', 'b ready'],
      ['A', 'ans'],
    ],
  );

  showTag(host, stale, null);
  fire(slot.querySelector('button.alt')!, 'click');
  assert.equal(clicks.length, 1, 'a click inside the shadow root reaches the page’s handler');
  // linkedom has no composedPath: the target a browser would name first
  const target = slot.querySelector('button.alt')!;
  const click = { composedPath: () => [target] } as unknown as Event;
  assert.equal(clickedTagButton(click)?.getAttribute('data-act'), 'retell');
  host.remove();
});

const row = (repo: string, checkout: string | null = null) => ({
  repo,
  prompt: `/once-upon-listen ${repo}`,
  details: `once-upon wait --repo ${repo}`,
  checkout,
});
const noticeHost = () => document.getElementById('once-upon-listen-notice');
const noticeRoot = () => noticeHost()!.shadowRoot!.querySelector('div.n')!;

test('the listen notice is one fixed element in its own shadow root, a line per repo with Start listening and a place for its note', () => {
  const notice = listenNotice();
  notice.set([row('acme/widgets', '~/Development/widgets'), row('acme/gadgets')]);
  const host = noticeHost()!;
  assert.equal(host.parentElement, document.body);
  const shadow = host.shadowRoot!;
  assert.equal(
    shadow.querySelector('link')!.getAttribute('href'),
    'chrome-extension://test/content/components/listen-notice.css',
  );
  assert.equal(host.style.visibility, 'hidden', 'hidden until its stylesheet loads');
  const box = noticeRoot();
  assert.equal(box.getAttribute('role'), 'status');
  assert.equal(box.firstElementChild!.className, 'row top');
  assert.equal(box.querySelector('.row.top > .lines')!.children.length, 4, 'a row and a note each');
  const first = box.querySelector('.lines > .row')!;
  assert.equal(
    [...first.querySelector('span')!.childNodes].map(canon).join(''),
    'No session listening for <b>acme/widgets</b> <span class="muted">· ~/Development/widgets</span>',
  );
  const start = box.querySelector<HTMLButtonElement>('button[data-i="0"]')!;
  assert.equal(start.textContent, 'Start listening');
  assert.match(
    start.title,
    /^Types \/once-upon-listen acme\/widgets into an idle Claude Code session in ~\/Development\/widgets\./,
  );
  assert.match(
    start.title,
    /\n\nWithout the once-upon-listen skill: once-upon wait --repo acme\/widgets$/,
  );
  const second = box.querySelector('button[data-i="1"]')!;
  assert.match((second as HTMLElement).title, /in your acme\/gadgets checkout/);
  assert.equal(second.parentElement!.querySelector('.muted'), null, 'no checkout, no muted part');
  const note = box.querySelector('.note[data-n="0"]')!;
  assert.equal(note.getAttribute('role'), 'status');
  assert.ok(note.hasAttribute('hidden'));
  const hide = box.querySelector('button.x')!;
  assert.equal(hide.textContent, '×');
  assert.equal(hide.getAttribute('title'), 'Hide until the page reloads');
  assert.equal(hide.getAttribute('aria-label'), 'Hide');
  notice.remove();
  assert.equal(noticeHost(), null);
});

test('the notice lists three repos and says how many more', () => {
  const notice = listenNotice();
  notice.set([row('a/one'), row('a/two'), row('a/three'), row('a/four'), row('a/five')]);
  const box = noticeRoot();
  assert.equal(box.querySelectorAll('button[data-i]').length, 3);
  assert.equal(box.querySelector('.lines > .muted')!.textContent, 'and 2 more repos');
  notice.set([row('a/one'), row('a/two'), row('a/three')]);
  assert.equal(box.querySelector('.lines > .muted'), null);
  notice.remove();
});

test('Start listening asks the bridge for sessions and says what happened in its note, which stays while the notice draws again', async () => {
  worker.sent = [];
  worker.answer = () => ({ ok: true, status: 200, body: { sessions: [] } });
  const notice = listenNotice();
  notice.set([row('acme/widgets', '~/Development/widgets')]);
  const box = noticeRoot();
  const note = box.querySelector<HTMLElement>('.note[data-n="0"]')!;
  fire(box.querySelector('button[data-i="0"]')!, 'click');
  for (let tries = 0; tries < 50 && note.hasAttribute('hidden'); tries++) {
    await tick();
  }
  assert.deepEqual(
    (worker.sent as { method: string; path: string }[]).map((one) => [one.method, one.path]),
    [['GET', '/api/board/listen-sessions?repo=acme%2Fwidgets']],
  );
  assert.ok(!note.hasAttribute('hidden'));
  assert.match(note.textContent!, /^No idle Claude Code session in acme\/widgets has an iTerm tab/);
  notice.set([row('acme/widgets', '~/Development/widgets')]);
  assert.equal(box.querySelector('.note[data-n="0"]'), note, 'the same note node');
  assert.match(note.textContent!, /^No idle Claude Code session/, 'and its words');
  assert.ok(!note.hasAttribute('hidden'));
  notice.remove();
});

test('a row that changes while its click waits on the sessions call still gets its Start listening label back', async () => {
  let answer: (reply: unknown) => void = () => {};
  worker.answer = () => new Promise((resolve) => (answer = resolve));
  const notice = listenNotice();
  notice.set([row('acme/widgets', '~/Development/widgets')]);
  const box = noticeRoot();
  const start = box.querySelector<HTMLButtonElement>('button[data-i="0"]')!;
  const note = box.querySelector<HTMLElement>('.note[data-n="0"]')!;
  fire(start, 'click');
  for (let tries = 0; tries < 50 && start.textContent !== 'Looking…'; tries++) {
    await tick();
  }
  assert.equal(start.textContent, 'Looking…');
  // the bridge's answer about the repo's listener changed while it waits: another checkout, prompt and details
  notice.set([
    { ...row('acme/widgets', '~/Development/other'), prompt: '/once-upon-listen --new' },
  ]);
  assert.equal(box.querySelector('button[data-i="0"]'), start, 'the same button');
  answer({ ok: true, status: 200, body: { sessions: [] } });
  for (let tries = 0; tries < 50 && note.hasAttribute('hidden'); tries++) {
    await tick();
  }
  assert.equal(start.textContent, 'Start listening');
  assert.match(
    note.textContent!,
    /Start one in ~\/Development\/other, then click Start listening again/,
  );
  fire(start, 'click');
  for (let tries = 0; tries < 50 && start.textContent !== 'Looking…'; tries++) {
    await tick();
  }
  answer({ ok: true, status: 200, body: { sessions: [] } });
  for (let tries = 0; tries < 50 && start.textContent !== 'Start listening'; tries++) {
    await tick();
  }
  assert.equal(start.textContent, 'Start listening', 'and again after a later click');
  notice.remove();
});

test('the × hides the notice until the page reloads, and an empty list removes it', () => {
  const notice = listenNotice();
  notice.set([row('acme/widgets')]);
  fire(noticeRoot().querySelector('button.x')!, 'click');
  assert.equal(noticeHost(), null);
  notice.set([row('acme/widgets')]);
  assert.equal(noticeHost(), null, 'it stays hidden');
  const other = listenNotice();
  other.set([row('acme/widgets')]);
  assert.ok(noticeHost());
  other.set([]);
  assert.equal(noticeHost(), null);
});

test('a toast is a div with the text, role status and its stylesheet, in a shadow root, and goes after its time', () => {
  const timers: (() => void)[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    if (delay === 5000) {
      timers.push(run);
      return 0;
    }
    return real(run, delay);
  }) as typeof setTimeout;
  try {
    toast('Saved');
  } finally {
    globalThis.setTimeout = real;
  }
  const host = [...document.body.children].find(
    (child) => child.shadowRoot && child.shadowRoot.querySelector('.t'),
  )!;
  const shadow = host.shadowRoot!;
  assert.equal(
    shadow.querySelector('link')!.getAttribute('href'),
    'chrome-extension://test/content/components/toast.css',
  );
  const message = shadow.querySelector('div.t')!;
  assert.equal(message.textContent, 'Saved');
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(host.isConnected, false);
});
