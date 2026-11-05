/*
 * The panel's DOM, from worlds scripted in panel-fixtures.ts: mounted in linkedom with a fake diff page and scripted host
 * calls, then serialized (attributes sorted, text trimmed, boolean attributes as present or not, change tags in one order) and compared with the golden files in
 * fixtures/panel-dom/. The goldens were recorded from the panel before it drew with Preact, so a change that moves a node,
 * an attribute or a word fails here. A change that should alter the panel rewrites them with
 * UPDATE_SNAPSHOTS=1 node --test test/panel-dom.test.ts: review the diff.
 *
 * Flows click and type, and read the DOM straight after (no waiting), the way the panel's own callers do, then wait for the
 * host's answers and read it again.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dom, clock, clipboardEnv, FakeIntersectionObserver } from './panel-env.ts';
import {
  FIXES,
  QUESTIONS,
  READS,
  CURRENT_UPDATED,
  STALE,
  WORKING,
  fullOptions,
  pageWorld,
  question,
  smallStory,
  story,
} from './panel-fixtures.ts';
import type { PanelOptions } from '../src/host/context.ts';
import type {
  DraftRow,
  DraftsAnswer,
  FixesView,
  StoryData,
} from '@once-upon-a-diff/contracts/types';

const { storyOverlay } = await import('../src/shell/overlay.ts');
const { parseMarkup } = await import('@once-upon-a-diff/ui-kit/parse-markup');
const { render, h } = await import('/assets/preact.mjs');
const { document, tick, fire, window } = dom;

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panel-dom');
const BOOLEAN = new Set([
  'hidden',
  'open',
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
]);

/** An element and what is under it, one line each: the tag, its attributes sorted, then its text and children indented. */
function serialize(node: Node, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? [`${pad}"${text}"`] : [];
  }
  if (node.nodeType !== 1) {
    return [];
  }
  const el = node as HTMLElement;
  const attrs = [...el.attributes]
    .filter((attr) => !(attr.name === 'class' && !attr.value)) // an empty class says nothing
    .filter((attr) => attr.name !== 'data-label') // the old Copy as gh script button noted its own label there; nothing read it
    .map((attr) =>
      BOOLEAN.has(attr.name) ? attr.name : `${attr.name}=${JSON.stringify(attr.value)}`,
    )
    .sort();
  // a ticked box is a property in the DOM the panel sets it on, and linkedom does not write it back as the attribute
  if (
    el.tagName === 'INPUT' &&
    (el as HTMLInputElement).checked === true &&
    !attrs.includes('checked')
  ) {
    attrs.push('checked');
    attrs.sort();
  }
  const own: string[] = [];
  if (el.tagName === 'TEXTAREA' && (el as HTMLTextAreaElement).value) {
    own.push(`${pad}  value=${JSON.stringify((el as HTMLTextAreaElement).value)}`);
  }
  const head = `${pad}<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  return [
    head,
    ...own,
    ...inOrder([...el.childNodes]).flatMap((child) => serialize(child, depth + 1)),
  ];
}

const isTag = (node: Node) =>
  node.nodeType === 1 && /\bou-chg(by)?\b/.test((node as Element).getAttribute('class') || '');
const tagKey = (node: Node) => {
  const el = node as Element;
  return `${el.getAttribute('class')}|${el.getAttribute('data-why') || ''}|${el.textContent}`;
};
/**
 * A step's or file's "changed since" and "being changed" tags in one fixed order. The panel put each in when its answer came,
 * so which came first depended on which request answered first: only that order is not a behavior to keep.
 */
function inOrder(nodes: Node[]): Node[] {
  // adjacent text nodes read as one (a parser may split a text at an entity, a template keeps what it was given)
  const children: Node[] = [];
  for (const node of nodes) {
    const last = children[children.length - 1];
    if (node.nodeType === 3 && last && last.nodeType === 3) {
      children[children.length - 1] = document.createTextNode(
        `${last.textContent}${node.textContent}`,
      );
    } else {
      children.push(node);
    }
  }
  const first = children.findIndex(isTag);
  if (first < 0) {
    return children;
  }
  const tags = children
    .filter(isTag)
    .sort((one, other) => tagKey(one).localeCompare(tagKey(other)));
  const others = children.filter((child) => !isTag(child));
  const before = children.slice(0, first).filter((child) => !isTag(child));
  return [...before, ...tags, ...others.slice(before.length)];
}

const panelRoot = () =>
  (document.getElementById('once-upon-panel') as HTMLElement).shadowRoot!.querySelector(
    '#ou-panel',
  ) as HTMLElement;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  panelRoot().querySelector(selector) as T;
const maybe = (selector: string) => panelRoot().querySelector(selector);
const all = (selector: string) => [...panelRoot().querySelectorAll<HTMLElement>(selector)];

/** The panel's DOM, plus what it did to the page around it (the docking class and width, and each file block's marks). */
function snapshot(world: ReturnType<typeof pageWorld>): string {
  const page = world.blocks.map((block) => {
    const marks = [...block.el.attributes]
      .filter((attr) => attr.name.startsWith('data-ou') || attr.name === 'hidden')
      .map((attr) => attr.name)
      .sort();
    return `  ${block.rel}: ${marks.join(' ') || '-'}`;
  });
  return [
    `html class=${JSON.stringify(document.documentElement.getAttribute('class') || '')} --ou-w=${document.documentElement.style.getPropertyValue('--ou-w')}`,
    'page',
    ...page,
    'panel',
    ...serialize(panelRoot()),
    '',
  ].join('\n');
}

function check(name: string, actual: string) {
  const file = path.join(GOLDEN, `${name}.txt`);
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `${name}: no golden, record it with UPDATE_SNAPSHOTS=1`);
  // not assert.equal: a diff of two 75k-character strings takes a minute to print (UPDATE_SNAPSHOTS=1 and git diff show it)
  assert.ok(actual === readFileSync(file, 'utf8'), `${name} changed`);
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await tick();
  }
};

interface Mounted {
  overlay: ReturnType<typeof storyOverlay>;
  world: ReturnType<typeof pageWorld>;
  calls: unknown[][];
  shot: () => string;
  done: () => void;
}

async function mount(
  input: StoryData,
  options: (calls: unknown[][]) => PanelOptions,
  initial: PanelOptions['initial'] = {},
  { onPage, wait = settle }: { onPage?: string[]; wait?: () => Promise<void> } = {},
): Promise<Mounted> {
  const world = pageWorld(input, { onPage });
  const calls: unknown[][] = [];
  const opts = { ...options(calls), initial };
  const overlay = storyOverlay(input, opts, world.host);
  await wait();
  return {
    overlay,
    world,
    calls,
    shot: () => snapshot(world),
    done() {
      overlay.destroy();
      document.getElementById('diff-page')?.remove();
    },
  };
}
const bare = (): PanelOptions => ({
  stylesheets: { page: '/p.css', panel: '/q.css', ui: '/u.css' },
});
const full = (calls: unknown[][]) => fullOptions(calls);

async function scenario(
  name: string,
  input: StoryData,
  options: (calls: unknown[][]) => PanelOptions,
  initial?: PanelOptions['initial'],
  extra?: (panel: Mounted) => Promise<void> | void,
) {
  await test(name, async () => {
    const panel = await mount(input, options, initial);
    try {
      await extra?.(panel);
      check(name, panel.shot());
    } finally {
      panel.done();
    }
  });
}

// ---------- the panel as it opens, with and without what a host can give it
await scenario('overview-bare', story(), bare);
await scenario('chapter-bare', story(), bare, { n: 1 });
await scenario('overview-full', story(), full);
await scenario('chapter-full', story(), full, {
  n: 2,
  filesOpen: true,
  showPosted: true,
  showDismissed: true,
});
await scenario('chapter-one-full-chat-open', story(), full, {
  n: 1,
  chatOpen: true,
  chatHeight: 300,
});
await scenario('chapter-unwritten', story(), full, { n: 3 });
await scenario(
  'chapter-since-updated',
  story(),
  (calls) => fullOptions(calls, { freshness: async () => CURRENT_UPDATED }),
  { n: 4 },
);
await scenario('collapsed', story(), full, { n: 1, collapsed: true, width: 500 });
await scenario('small-story-no-comments', smallStory(), bare);

// the parts strip: drawn under Steps on the Overview and a chapter when the story has parts, and no trace of it when it has none
await test('the parts strip shows under Steps on the Overview and on a chapter, and a story without parts has none', async () => {
  const parts = {
    groups: ['Code', 'Docs'],
    parts: [
      { id: 'source', name: 'Source', group: 'Code' },
      { id: 'tests', name: 'Tests', group: 'Code' },
      { id: 'docs', name: 'Docs', group: 'Docs' },
    ],
    by_chapter: [['source'], ['source', 'tests'], ['docs'], []],
    files: { source: 3, docs: 1 },
  };
  const panel = await mount({ ...story(), parts }, bare);
  try {
    const overview = panel.shot();
    assert.ok(overview.includes('Parts this story touches'));
    assert.match(overview, /Source[^]*touched, 3 files/);
    panel.overlay.go(1);
    await settle();
    const chapter = panel.shot();
    assert.ok(chapter.includes('Parts this chapter touches'));
    assert.ok(chapter.includes('Not touched: Docs'));
    assert.ok(!chapter.includes('Parts this story touches'));
    panel.overlay.go(4);
    await settle();
    assert.ok(
      !panel.shot().includes('ou-ui-parts'),
      'a chapter that touches nothing draws no strip',
    );
  } finally {
    panel.done();
  }
  const without = await mount(story(), bare);
  try {
    assert.ok(!without.shot().includes('ou-ui-parts'));
  } finally {
    without.done();
  }
});
await scenario('status-error', story(), (calls) =>
  fullOptions(calls, {
    status: async () => Promise.reject(Object.assign(new Error('x'), { code: 'down' })),
  }),
);
await scenario('status-listening', story(), (calls) =>
  fullOptions(calls, {
    status: async () => ({
      bridge: { version: '1' },
      story: { ok: true },
      listening: {
        ok: true,
        consumers: [{ consumer: 'author-1', story: 'story-1', state: 'handling' }],
        answering: { consumer: 'author-1', scope: 'story' },
      },
    }),
  }),
);
await scenario(
  'questions-only-local-host',
  story(),
  (calls) => {
    const opts = fullOptions(calls, { host: 'the local page' });
    delete opts.drafts;
    delete opts.fixes;
    delete opts.requestUpdate;
    delete opts.requestRebuild;
    delete opts.listen;
    return opts;
  },
  { n: 1, chatOpen: true },
);

// ---------- viewed marks: from the page's Viewed toggles
await test('viewed-states', async () => {
  const panel = await mount(story(), full, { n: 2 });
  try {
    panel.world.viewed.set('src/a.ts', true);
    panel.world.viewed.set('src/c.ts', true); // c is finished in chapter 4: viewed early here
    panel.overlay.apply();
    check('viewed-chapter-2-partly-and-early', panel.shot());
    panel.world.viewed.set('src/b.ts', true);
    panel.overlay.apply();
    check('viewed-chapter-2-complete', panel.shot());
    panel.overlay.go(4);
    check('viewed-chapter-4', panel.shot());
    panel.overlay.go(0);
    check('viewed-overview-progress', panel.shot());
    for (const rel of panel.world.viewed.keys()) {
      panel.world.viewed.set(rel, 'none');
    }
    panel.overlay.apply();
    check('viewed-no-toggles', panel.shot());
  } finally {
    panel.done();
  }
});

// ---------- flows: click, then read the DOM at once
await test('flow-steps', async () => {
  const panel = await mount(story(), full);
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    shot('overview');
    fire($('ol.ou-map li[data-n="2"]'), 'click');
    shot('step list -> 2');
    assert.equal(panel.overlay.state.n, 2);
    fire($('.ou-next'), 'click');
    shot('next -> 3');
    fire($('.ou-next'), 'click');
    shot('next -> 4 (last: Next is disabled)');
    fire($('.ou-prev'), 'click');
    fire($('.ou-prev'), 'click');
    fire($('.ou-prev'), 'click');
    shot('prev x3 -> 1');
    fire($('.ou-prev'), 'click');
    shot('prev -> overview (Prev disabled)');
    panel.overlay.go(1);
    shot('go(1)');
    panel.overlay.setCollapsed(true);
    shot('setCollapsed(true)');
    fire($('.ou-toggle'), 'click');
    shot('toggle click: expanded');
    assert.equal(panel.overlay.state.collapsed, false);
    check('flow-steps', shots.join('\n'));
    assert.deepEqual(
      panel.calls
        .filter((call) => call[0] === 'onState')
        .map(
          (call) =>
            (call[1] as { n: number; collapsed: boolean }).n +
            ':' +
            (call[1] as { collapsed: boolean }).collapsed,
        ),
      [
        '2:false',
        '3:false',
        '4:false',
        '3:false',
        '2:false',
        '1:false',
        '0:false',
        '1:false',
        '1:false',
      ],
      'each step change and the toggle report once',
    );
  } finally {
    panel.done();
  }
});

await test('flow-leaving-a-chapter-with-files-left-says-so', async () => {
  const panel = await mount(story(), full, { n: 2 });
  try {
    panel.world.viewed.set('src/a.ts', true);
    panel.overlay.apply();
    panel.overlay.go(3);
    const shots = [`### after go(3)\n${panel.shot()}`];
    check('flow-leaving-message', shots.join('\n'));
    assert.match($('.ou-msg').textContent || '', /still has 1 to mark viewed: b\.ts/);
  } finally {
    panel.done();
  }
});

await test('flow-show-all-files', async () => {
  const panel = await mount(story(), full, { n: 1 });
  try {
    const shots: string[] = [];
    fire($('.ou-all'), 'click');
    shots.push(`### show all\n${panel.shot()}`);
    fire($('.ou-all'), 'click');
    shots.push(`### chapter files only\n${panel.shot()}`);
    check('flow-show-all', shots.join('\n'));
  } finally {
    panel.done();
  }
});

await test('flow-mark-viewed-clicks-the-toggle-once', async () => {
  const panel = await mount(story(), full, { n: 2 });
  try {
    const shots: string[] = [];
    const fileButton = all('ul.ou-files li[data-file="src/a.ts"] [data-mark-for]');
    fire(fileButton[0], 'click');
    assert.equal(
      panel.world.clicks.get('src/a.ts'),
      1,
      'one click on the file list button is one click on the toggle',
    );
    shots.push(`### file list button\n${panel.shot()}`);
    const pill = $('.ou-md [data-mark-for]');
    assert.equal(pill.getAttribute('data-mark-for'), 'src/b.ts');
    fire(pill, 'click');
    assert.equal(panel.world.clicks.get('src/b.ts'), 1, 'a pill click is one click on its file');
    assert.equal(panel.world.clicks.get('src/a.ts'), 1, 'and none on another');
    shots.push(`### pill\n${panel.shot()}`);
    fire($('ol.ou-map li[data-n="3"]'), 'click');
    assert.equal(panel.overlay.state.n, 3, 'a step click goes once');
    check('flow-mark-viewed', shots.join('\n'));
  } finally {
    panel.done();
  }
});

await test('flow-ask', async () => {
  const panel = await mount(story(), full, { n: 2, chatOpen: true });
  try {
    const text = $<HTMLTextAreaElement>('.ou-ask textarea');
    text.value = '  Why this?  ';
    fire(text, 'input');
    fire($('.ou-ask'), 'submit');
    await settle();
    check('flow-ask', panel.shot());
    assert.deepEqual(
      panel.calls.filter((call) => call[0] === 'ask').map((call) => call[1]),
      [{ text: 'Why this?', step: 2, chapter: 'Chapter 2: Finish', file: 'src/a.ts' }],
    );
    assert.equal(text.value, '');
  } finally {
    panel.done();
  }
});

await test('flow-questions-and-drafts-and-fixes', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    fire($('[data-qa-act="dismiss"]'), 'click');
    shot('question dismissed (sync)');
    await settle();
    shot('question dismissed (settled)');
    fire($('[data-qa-act="undo"]'), 'click');
    await settle();
    shot('undo');
    fire($('[data-qa-act="show-dismissed"]'), 'click');
    shot('show dismissed');
    fire($('[data-draft-act="dismiss"]'), 'click');
    await settle();
    shot('draft dismissed');
    fire($('[data-draft-show="showPosted"]'), 'click');
    shot('show posted drafts');
    fire($('.ou-fixes [data-fix-act="send"]'), 'click');
    await settle();
    shot('fixes sent');
    check('flow-questions-drafts-fixes', shots.join('\n'));
    assert.deepEqual(
      panel.calls
        .filter((call) => /^(markQuestions|drafts\.act|fixes\.act)$/.test(call[0] as string))
        .map((call) => [call[0], ...(call.slice(1) as unknown[])]),
      [
        ['markQuestions', 'dismiss', ['q1'], {}],
        ['markQuestions', 'restore', ['q1'], {}],
        ['drafts.act', 1, 1, 'dismiss'],
        ['fixes.act', { action: 'send' }],
      ].filter(Boolean) as unknown[][],
    );
  } finally {
    panel.done();
  }
});

await test('flow-rebuild-and-update-buttons', async () => {
  const panel = await mount(story(), (calls) => fullOptions(calls, { pulse: undefined }), { n: 2 });
  try {
    const shots: string[] = [];
    fire($('.ou-rebuild-open'), 'click');
    shots.push(`### rebuild form\n${panel.shot()}`);
    const guidance = $<HTMLTextAreaElement>('.ou-rebuild-form textarea');
    guidance.value = 'Tell it again';
    fire(guidance, 'input');
    fire($('.ou-rebuild-form'), 'submit');
    await settle();
    shots.push(`### rebuild sent\n${panel.shot()}`);
    fire($('.ou-update[data-retell="0"]'), 'click');
    await settle();
    shots.push(`### update asked\n${panel.shot()}`);
    check('flow-rebuild-update', shots.join('\n'));
    assert.deepEqual(
      panel.calls.filter((call) => call[0] === 'requestUpdate').map((call) => call[2]),
      [{ retell: false }],
    );
  } finally {
    panel.done();
  }
});

await test('flow-status-light-and-close', async () => {
  let closed = 0;
  const panel = await mount(story(), (calls) =>
    fullOptions(calls, { onClose: () => void closed++ }),
  );
  try {
    fire($('.ou-light'), 'click');
    const opened = panel.shot();
    fire($('.ou-light'), 'click');
    check('flow-status-light', opened + '\n### closed again\n' + panel.shot());
    fire($('.ou-close'), 'click');
    assert.equal(closed, 1);
    assert.equal(document.getElementById('once-upon-panel'), null, 'the panel is off the page');
    assert.equal(document.documentElement.getAttribute('class') || '', '');
  } finally {
    panel.done();
  }
});

await test('live redraw keeps the body scroll and the typed question', async () => {
  const panel = await mount(story(), full, {
    n: 1,
    bodyScroll: 120,
    chatOpen: true,
  } as PanelOptions['initial']);
  try {
    assert.equal(panel.overlay.bodyScroll, 120);
    panel.overlay.go(2);
    assert.equal(panel.overlay.bodyScroll, 0, 'a step change starts at the top');
  } finally {
    panel.done();
  }
});

await test('a question the host sends in later shows up in the dock', async () => {
  let list = [question('late')];
  const panel = await mount(
    story(),
    (calls) => fullOptions(calls, { loadQuestions: async () => list, pulse: undefined }),
    { chatOpen: true },
  );
  try {
    assert.equal(all('.ou-qa').length, 1);
    list = QUESTIONS;
    await panel.overlay.refreshQuestions();
    assert.equal(all('.ou-qa').length, 6 - 1 + 0, 'the five that are not dismissed');
    assert.ok(READS);
  } finally {
    panel.done();
  }
});

await test('the frame keeps its nodes, and the listeners the parts bound to them, through redraws and step changes', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    const frame = [
      '.ou-body',
      '.ou-note',
      '.ou-chat',
      '.ou-chatbody',
      '.ou-chathead',
      '.ou-chatgrip',
      '.ou-chatarrow',
      '.ou-chatcount',
      '.ou-chatfoot',
      '.ou-ask',
      '.ou-questions',
      '.ou-light',
      '.ou-health',
      '.ou-fresh',
      '.ou-rebuilding',
      '.ou-askhint',
      '.ou-askwho',
      '.ou-ask textarea',
      '.ou-count-note',
      '.ou-msg',
      '.ou-title',
      '.ou-toggle',
    ];
    const before = frame.map((selector) => $(selector));
    panel.overlay.go(2);
    panel.overlay.go(3);
    panel.overlay.setCollapsed(true);
    panel.overlay.apply();
    panel.overlay.go(0);
    await panel.overlay.refreshQuestions();
    frame.forEach((selector, i) =>
      assert.equal($(selector), before[i], `${selector} is the same node`),
    );
    // the status light bound its click when it was built, before the first draw
    const health = $('.ou-health');
    const wasHidden = health.hasAttribute('hidden');
    fire($('.ou-light'), 'click');
    assert.notEqual(health.hasAttribute('hidden'), wasHidden);
  } finally {
    panel.done();
  }
});

await test('a step change redraws the body from the top and keeps what the reader typed in the Ask box', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    const text = $<HTMLTextAreaElement>('.ou-ask textarea');
    text.value = 'half a question';
    fire(text, 'input');
    $('.ou-body').scrollTop = 99;
    panel.overlay.go(2);
    assert.equal($('.ou-body').scrollTop, 0);
    assert.equal($<HTMLTextAreaElement>('.ou-ask textarea').value, 'half a question');
  } finally {
    panel.done();
  }
});

await test('markup the panel builds as a string draws as the browser would read it, and the parts can write into it', () => {
  const holder = document.createElement('div');
  const hooks = {
    element(tag: string, props: Record<string, unknown>) {
      if (tag === 'b') {
        props.title = 'hooked';
      }
    },
  };
  const markup =
    '<p class="x" data-n="2">a &amp; b <b>bold</b> &lt;i&gt;</p><button hidden disabled>go</button><details open><summary>s</summary></details>';
  render(h('div', null, ...parseMarkup(markup, hooks)), holder);
  const root = holder.firstElementChild as HTMLElement;
  assert.equal(root.querySelector('p')!.textContent, 'a & b bold <i>');
  assert.equal(root.querySelector('b')!.getAttribute('title'), 'hooked');
  assert.ok(
    root.querySelector('button')!.hasAttribute('hidden') &&
      root.querySelector('button')!.hasAttribute('disabled'),
  );
  assert.ok(root.querySelector('details')!.hasAttribute('open'));
  // a part writes into what was drawn; drawing the same markup again leaves it
  const written = document.createElement('i');
  root.querySelector('p')!.appendChild(written);
  root.querySelector('button')!.removeAttribute('hidden');
  render(h('div', null, ...parseMarkup(markup, hooks)), holder);
  assert.equal(root.querySelector('p')!.lastChild, written);
  assert.ok(!root.querySelector('button')!.hasAttribute('hidden'));
});

await test('a Mark viewed button in a question answer clicks the file toggle once and follows the toggle', async () => {
  const answered = question('qa', {
    step: 2,
    answers: [
      {
        at: '2026-11-03T11:10:00Z',
        text: 'Because [the top](ref:top) says so.',
        by: 'author-1',
        refs: [{ id: 'top', path: 'src/a.ts', side: 'R', start: 1, end: 3 }],
      },
    ],
  });
  const panel = await mount(
    story(),
    (calls) => fullOptions(calls, { loadQuestions: async () => [answered], pulse: undefined }),
    { n: 2, chatOpen: true },
  );
  try {
    const button = () => $('.ou-questions [data-mark-for="src/a.ts"]');
    assert.equal(button().textContent, 'mark viewed');
    fire(button(), 'click');
    assert.equal(
      panel.world.clicks.get('src/a.ts'),
      1,
      'one click on the answer button is one click on the toggle',
    );
    panel.world.viewed.set('src/a.ts', true);
    panel.overlay.apply();
    assert.equal(button().textContent, 'viewed ✓');
    assert.equal(button().getAttribute('aria-pressed'), 'true');
    fire(button(), 'click');
    assert.equal(panel.world.clicks.get('src/a.ts'), 2, 'and a click on "viewed" unticks it');
  } finally {
    panel.done();
  }
});

await test('a step change blanks the step list progress when the page has no Viewed toggles to read', async () => {
  const panel = await mount(story(), full, { n: 2 });
  try {
    const progress = () => all('ol.ou-map [data-prog-for]').map((el) => el.textContent);
    panel.world.viewed.set('src/a.ts', true);
    panel.overlay.apply();
    assert.ok(progress().some(Boolean), 'the step list shows progress while there are toggles');
    for (const rel of panel.world.viewed.keys()) {
      panel.world.viewed.set(rel, 'none');
    }
    panel.overlay.apply();
    assert.ok(progress().some(Boolean), 'a look with no toggles leaves what was there');
    panel.overlay.go(1);
    assert.deepEqual(progress().filter(Boolean), [], 'a step change draws the list blank');
  } finally {
    panel.done();
  }
});

// ---------- the Ask dock and the status light (before they drew with Preact: these pass on the string versions)

/** Timers the test moves by hand: the panel mounted under mocked timers, with the tab showing. */
const startClock = () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // Preact's hooks call setTimeout(callback) with no delay, and node's mock timers file that as a NaN run time, which breaks the
  // order of every timer after it (a poll's 5 s tick then never ran when this test ran alone): give it the 0 a real one reads.
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, millis = 0, ...rest: unknown[]) =>
    mocked(callback, millis, ...rest)) as typeof setTimeout;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  clock.now = Date.parse('2026-11-03T12:00:00Z');
  FakeIntersectionObserver.all = [];
};
const stopClock = () => {
  mock.timers.reset();
  delete (document as unknown as Record<string, unknown>).visibilityState;
  clock.now = Date.parse('2026-11-03T12:00:00Z');
};
/** Moves the mocked clock `ms` on, letting promises and Preact's effects run as it goes. */
const pump = async (millis: number, step = 50) => {
  for (let left = millis; left > 0; left -= step) {
    clock.now += Math.min(step, left);
    mock.timers.tick(Math.min(step, left));
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }
};
const pumpOnce = async () => pump(50);

const deferred = <T>() => {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
};
const calling = (calls: unknown[][], name: string) => calls.filter((call) => call[0] === name);
const notListening = (extra: Record<string, unknown> = {}) => ({
  bridge: { version: '1.0.0' },
  story: { ok: true, id: 'story-1' },
  listening: {
    ok: false,
    prompt: '/once-upon-listen acme/widgets',
    repo: 'acme/widgets',
    checkout: '/work/widgets',
    start: 'once-upon wait --consumer once-upon',
    story_prompt: { prompt: '/once-upon-listen --story story-1' },
    ...extra,
  },
});
const withStatus = (status: () => unknown) => (calls: unknown[][]) =>
  fullOptions(calls, { status: (async () => status()) as never });
const SESSION = { id: 's1', title: 'api-1', status: 'idle' as const, since: null };

await test('the dock header opens and closes the dock, saves it and focuses the Ask box', async () => {
  const panel = await mount(story(), full, { n: 1 });
  try {
    const open = () => $('.ou-chat').classList.contains('ou-open');
    const saved = () =>
      (calling(panel.calls, 'onState').at(-1)?.[1] as { chatOpen?: boolean } | undefined)?.chatOpen;
    assert.equal(open(), false);
    let focused = 0;
    $('.ou-ask textarea').focus = () => void focused++;
    fire($('.ou-chathead'), 'click');
    assert.equal(open(), true);
    assert.equal($('.ou-chathead').getAttribute('aria-expanded'), 'true');
    assert.equal($('.ou-chatarrow').textContent, '▾');
    assert.equal(saved(), true);
    assert.equal(focused, 1, 'the Ask box takes focus');
    const shot = panel.shot();
    panel.overlay.apply();
    panel.overlay.apply();
    assert.equal(panel.shot(), shot, 'a redraw leaves the open dock as it was');
    fire($('.ou-chathead'), 'click');
    assert.equal(open(), false);
    assert.equal($('.ou-chathead').getAttribute('aria-expanded'), 'false');
    assert.equal($('.ou-chatarrow').textContent, '▸');
    assert.equal(saved(), false);
  } finally {
    panel.done();
  }
});

await test('the dock header counts what the list shows, and a mark moves both in the same step', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    assert.equal(
      $('.ou-chatcount').textContent,
      '5 questions · 1 being worked on · 1 waiting · 1 unread answer',
    );
    assert.ok($('.ou-chatcount').classList.contains('ou-unread'));
    assert.equal(all('.ou-qa-new').length, 1);
    fire($('[data-qa-act="read-all"]'), 'click');
    // read straight after the click: the count and the rows it counts agree
    assert.equal($('.ou-chatcount').textContent, '5 questions · 1 being worked on · 1 waiting');
    assert.ok(!$('.ou-chatcount').classList.contains('ou-unread'));
    assert.equal(all('.ou-qa-new').length, 0);
    assert.ok(maybe('[data-qa-act="read-all"]') === null, 'and Mark all read is gone');
    await settle();
    assert.deepEqual(calling(panel.calls, 'markQuestions').at(-1), [
      'markQuestions',
      'read_all',
      ['q4'],
      { seen: { q4: '2026-11-03T11:20:00Z' } },
    ]);
  } finally {
    panel.done();
  }
});

await test('flow-ask-actions', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    const shots: string[] = [];
    const act = async (label: string, selector: string) => {
      fire($(selector), 'click');
      shots.push(`### ${label} (sync)\n${panel.shot()}`);
      await settle();
    };
    await act('collapse q3', '[data-qid="q3"] [data-qa-act="collapse"]');
    await act('expand q5', '[data-qid="q5"] [data-qa-act="expand"]');
    await act('mark q4 read', '[data-qid="q4"] [data-qa-act="read"]');
    await act('mark q3 unread', '[data-qid="q3"] [data-qa-act="unread"]');
    await act('clear conversation', '[data-qa-act="clear"]');
    check('flow-ask-actions', shots.join('\n'));
    assert.deepEqual(
      calling(panel.calls, 'markQuestions').map((call) => [call[1], call[2]]),
      [
        ['collapse', ['q3']],
        ['expand', ['q5']],
        ['read', ['q4']],
        ['unread', ['q3']],
        ['clear', ['q1', 'q2', 'q3', 'q4', 'q5']],
      ],
    );
  } finally {
    panel.done();
  }
});

await test('a failed mark says so and looks at the list again', async () => {
  let looked = 0;
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        pulse: undefined,
        loadQuestions: async () => {
          looked++;
          return QUESTIONS;
        },
        markQuestions: async () => Promise.reject(new Error('nope')),
      }),
    { n: 1, chatOpen: true },
  );
  try {
    const before = looked;
    fire($('[data-qid="q3"] [data-qa-act="collapse"]'), 'click');
    await settle();
    assert.equal($('.ou-msg').textContent, "Couldn't save that: nope");
    assert.equal(looked, before + 1);
  } finally {
    panel.done();
  }
});

await test('the undo line goes after fifteen seconds', async () => {
  startClock();
  const panel = await mount(story(), full, { n: 1, chatOpen: true }, { wait: pumpOnce });
  try {
    fire($('[data-qid="q1"] [data-qa-act="dismiss"]'), 'click');
    assert.equal($('.ou-qundo').textContent?.trim(), 'Dismissed 1 question. Undo');
    await pump(14000);
    assert.ok(maybe('.ou-qundo'), 'still there at 14 s');
    await pump(1500);
    assert.ok(maybe('.ou-qundo') === null, 'the undo line is gone at 15 s');
  } finally {
    panel.done();
    stopClock();
  }
});

await test('a working question counts its time up on its own, and stops when the panel is closed', async () => {
  startClock();
  const panel = await mount(story(), full, { n: 1, chatOpen: true }, { wait: pumpOnce });
  try {
    const span = () => $('.ou-elapsed');
    const first = span();
    assert.equal(first.textContent, '5:00');
    const before = panel.shot();
    await pump(3000);
    assert.equal(span().textContent, '5:03');
    assert.ok(span() === first, 'the same node: only its text moved');
    assert.equal(panel.shot().replace('5:03', '5:00'), before, 'and nothing else changed');
    const shown = span();
    panel.overlay.destroy();
    await pump(5000);
    assert.equal(shown.textContent, '5:03', 'no timer runs once the panel is closed');
  } finally {
    panel.done();
    stopClock();
  }
});

await test('an unread answer in view for a moment, with the dock open, is read once', async () => {
  startClock();
  const unread = (calls: unknown[][]) =>
    calling(calls, 'markQuestions').filter((call) => call[1] === 'read');
  const inView = (target: Element) => ({
    target,
    isIntersecting: true,
    intersectionRatio: 1,
    intersectionRect: { height: 10 } as DOMRectReadOnly,
    rootBounds: { height: 100 } as DOMRectReadOnly,
  });
  const panel = await mount(story(), full, { n: 1, chatOpen: true }, { wait: pumpOnce });
  try {
    const observer = FakeIntersectionObserver.all.at(-1)!;
    const target = $('.ou-a[data-aat]');
    assert.ok(observer.targets.has(target), 'the unread answer is watched');
    observer.callback([inView(target)]);
    await pump(1000);
    assert.equal(unread(panel.calls).length, 0, 'not yet');
    await pump(1000);
    assert.deepEqual(
      unread(panel.calls).map((call) => [call[2], call[3]]),
      [[['q4'], { seen: { q4: '2026-11-03T11:20:00Z' }, auto: true }]],
    );
  } finally {
    panel.done();
    stopClock();
  }
  startClock();
  const closed = await mount(story(), full, { n: 1, chatOpen: false }, { wait: pumpOnce });
  try {
    const observer = FakeIntersectionObserver.all.at(-1)!;
    observer.callback([inView($('.ou-a[data-aat]'))]);
    await pump(3000);
    assert.equal(unread(closed.calls).length, 0, 'a closed dock reads nothing');
  } finally {
    closed.done();
    stopClock();
  }
});

await test('dragging the top of the dock sets its height, and a closed dock does not drag', async () => {
  const panel = await mount(story(), full, { n: 1, chatOpen: true });
  try {
    Object.defineProperty(panelRoot(), 'clientHeight', { value: 800, configurable: true });
    $('.ou-chat').getBoundingClientRect = () => ({ bottom: 700 }) as DOMRect;
    const grip = $('.ou-chatgrip');
    fire(grip, 'pointerdown');
    assert.ok($('.ou-chat').classList.contains('ou-chat-dragging'));
    fire(grip, 'pointermove', { clientY: 400 });
    assert.match($('.ou-chat').getAttribute('style') || '', /--ou-chat-h:\s*300px/);
    fire(grip, 'pointerup');
    assert.ok(!$('.ou-chat').classList.contains('ou-chat-dragging'));
    assert.deepEqual(calling(panel.calls, 'onLayout').at(-1), ['onLayout', { chatHeight: 300 }]);
    assert.equal(
      (calling(panel.calls, 'onState').at(-1)?.[1] as { chatHeight?: number }).chatHeight,
      300,
    );
    fire($('.ou-chathead'), 'click'); // closed
    fire(grip, 'pointerdown');
    assert.ok(!$('.ou-chat').classList.contains('ou-chat-dragging'));
  } finally {
    panel.done();
  }
});

await test('the Ask box: Cmd+Enter sends it, the button is off while it goes, a failure keeps the text', async () => {
  let fail = false;
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        ask: async (question) => {
          calls.push(['ask', question]);
          return fail ? Promise.reject(new Error('boom')) : { ok: true };
        },
        status: (async () => notListening({ ok: true })) as never,
      }),
    { n: 1, chatOpen: true },
  );
  try {
    const text = $<HTMLTextAreaElement>('.ou-ask textarea');
    const button = $<HTMLButtonElement>('.ou-ask button');
    text.value = 'First?';
    fire(text, 'input');
    fire(text, 'keydown', { key: 'Enter', metaKey: true });
    assert.equal(button.disabled, true, 'off straight after the send');
    await settle();
    assert.equal(button.disabled, false);
    assert.equal(text.value, '');
    assert.equal($('.ou-msg').textContent, 'Sent to the bridge inbox.');
    fail = true;
    text.value = 'Second?';
    fire(text, 'input');
    fire(text, 'keydown', { key: 'Enter', ctrlKey: true });
    await settle();
    assert.equal(text.value, 'Second?', 'a failure keeps what was typed');
    assert.equal(button.disabled, false);
    assert.equal($('.ou-msg').textContent, "Couldn't send the question: boom");
    fire(text, 'keydown', { key: 'Enter' });
    assert.equal(calling(panel.calls, 'ask').length, 2, 'Enter alone sends nothing');
  } finally {
    panel.done();
  }
});

await test('a jump link in an answer jumps once, and its pill clicks the file once', async () => {
  const answered = question('qa', {
    step: 2,
    answers: [
      {
        at: '2026-11-03T11:10:00Z',
        text: 'Because [the top](ref:top) says so.',
        refs: [{ id: 'top', path: 'src/a.ts', side: 'R', start: 1, end: 3 }],
      },
    ],
  });
  const panel = await mount(
    story(),
    (calls) => fullOptions(calls, { loadQuestions: async () => [answered], pulse: undefined }),
    { n: 2, chatOpen: true },
  );
  try {
    const reveals = () => calling(panel.calls, 'reveal').length;
    await panel.overlay.jumpTo('src/a.ts', { side: 'R', start: 1, end: 3 });
    const once = reveals();
    assert.ok(once > 0, 'a jump asks the host to reveal the lines');
    fire($('.ou-questions span[data-rel="src/a.ts"]'), 'click');
    await settle();
    assert.equal(reveals(), 2 * once, 'a click on the link is one jump');
    fire($('.ou-questions span[data-rel="src/a.ts"]'), 'keydown', { key: 'Enter' });
    await settle();
    assert.equal(reveals(), 3 * once, 'Enter on the link is a click');
  } finally {
    panel.done();
  }
});

await test('an answer keeps its file pill when the dock is drawn again in the same step', async () => {
  let list = [
    question('qa', {
      step: 2,
      answers: [
        {
          at: '2026-11-03T11:10:00Z',
          text: 'Because [the top](ref:top) says so.',
          refs: [{ id: 'top', path: 'src/a.ts', side: 'R', start: 1, end: 3 }],
        },
      ],
    }),
  ];
  const panel = await mount(
    story(),
    (calls) => fullOptions(calls, { loadQuestions: async () => list, pulse: undefined }),
    { n: 2, chatOpen: true },
  );
  try {
    const pill = () => all('.ou-questions [data-mark-for]').length;
    assert.equal(pill(), 1);
    list = [...list, question('qb')];
    await panel.overlay.refreshQuestions();
    assert.equal(all('.ou-qa').length, 2);
    assert.equal(pill(), 1, 'the second draw of the same answer keeps its pill');
    panel.overlay.go(1);
    panel.overlay.go(2);
    assert.equal(pill(), 1, 'and a step change brings it back too');
  } finally {
    panel.done();
  }
});

// ---------- the status light, its hint and the line saying who answers

const whoScenario = (name: string, listening: Record<string, unknown>) =>
  scenario(
    name,
    story(),
    withStatus(() => notListening(listening)),
    { n: 1, chatOpen: true },
  );
await whoScenario('status-who-relayed', {
  ok: true,
  agent: 'ou-fix-cache',
  answering: { consumer: 'story-x', scope: 'story', agent: 'ou-fix-cache' },
});
await whoScenario('status-who-relayed-by-repo', {
  ok: true,
  agent: 'ou-fix-cache',
  answering: { consumer: 'repo-acme', scope: 'repo', agent: 'ou-fix-cache' },
});
await whoScenario('status-who-agent-without-a-wait', {
  ok: true,
  agent: 'ou-fix-cache',
  answering: { consumer: 'repo-acme', scope: 'repo' },
});
await whoScenario('status-who-repo-listener', {
  ok: true,
  answering: { consumer: 'repo-acme', scope: 'repo' },
});
await whoScenario('status-hint-with-details', { details: 'Paste this line:\n/once-upon-listen x' });
await whoScenario('status-hint-no-prompt', { prompt: null, story_prompt: null, checkout: null });

await test('flow-start-listening', async () => {
  const sessionsOf = (calls: unknown[][], list: () => unknown[]) =>
    fullOptions(calls, {
      listen: {
        sessions: async (target) => {
          calls.push(['listen.sessions', target]);
          return list() as never;
        },
        start: async (id, target) => {
          calls.push(['listen.start', id, target]);
        },
      },
    });
  const shots: string[] = [];
  let list: unknown[] = [];
  const panel = await mount(story(), (calls) => sessionsOf(calls, () => list), {
    n: 1,
    chatOpen: true,
  });
  try {
    const button = () => $<HTMLButtonElement>('.ou-askhint .ou-startlisten');
    const note = () => $('.ou-askhint .ou-startnote');
    fire(button(), 'click');
    assert.equal(button().textContent, 'Looking…');
    assert.equal(button().disabled, true);
    shots.push(`### none, looking\n${panel.shot()}`);
    await settle();
    assert.equal(button().textContent, 'Start listening');
    assert.equal(button().disabled, false);
    assert.match(note().textContent || '', /^No idle Claude Code session in acme\/widgets/);
    shots.push(`### none, said so\n${panel.shot()}`);
    await panel.overlay.refreshHealth();
    await settle();
    assert.ok(!note().hasAttribute('hidden'), 'the same health keeps the note');
    list = [SESSION];
    fire(button(), 'click');
    await settle();
    assert.deepEqual(calling(panel.calls, 'listen.start').at(-1)?.slice(1), [
      's1',
      { scope: 'repo', repo: 'acme/widgets' },
    ]);
    assert.match(note().textContent || '', /^Typed into “api-1” to listen for acme\/widgets\./);
    shots.push(`### one, typed\n${panel.shot()}`);
    list = [
      { ...SESSION, since: '2026-11-03T11:50:00Z' },
      { ...SESSION, id: 's2', title: 'api-2', since: '2026-11-03T11:51:00Z' },
    ];
    fire(button(), 'click');
    await settle();
    const picks = all('.ou-askhint .ou-startpick button');
    assert.equal(picks.length, 2);
    assert.match(picks[0].textContent || '', /^api-2 · idle /, 'freshest first');
    shots.push(`### two, choosing\n${panel.shot()}`);
    fire(button(), 'click');
    assert.equal(all('.ou-askhint .ou-startpick').length, 0, 'Start again closes the chooser');
    fire(button(), 'click');
    await settle();
    fire(all('.ou-askhint .ou-startpick button')[1], 'click');
    await settle();
    assert.deepEqual(calling(panel.calls, 'listen.start').at(-1)?.slice(1), [
      's1',
      { scope: 'repo', repo: 'acme/widgets' },
    ]);
    check('flow-start-listening', shots.join('\n'));
  } finally {
    panel.done();
  }
});

await test('Start listening for this story asks for story sessions', async () => {
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        listen: {
          sessions: async (target) => {
            calls.push(['listen.sessions', target]);
            return [SESSION];
          },
          start: async (id, target) => {
            calls.push(['listen.start', id, target]);
          },
        },
      }),
    { n: 1, chatOpen: true },
  );
  try {
    fire($('.ou-askwho .ou-startstory'), 'click');
    await settle();
    assert.deepEqual(calling(panel.calls, 'listen.sessions').at(-1)?.slice(1), [
      { scope: 'story' },
    ]);
    assert.deepEqual(calling(panel.calls, 'listen.start').at(-1)?.slice(1), [
      's1',
      { scope: 'story' },
    ]);
    assert.match($('.ou-askwho .ou-startnote').textContent || '', /to listen for this story/);
  } finally {
    panel.done();
  }
});

await test('new hint markup starts the Start listening button over, and a reply that was in flight shows nothing on it', async () => {
  let prompt = '/once-upon-listen acme/widgets';
  const looking = deferred<(typeof SESSION)[]>();
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        status: (async () => notListening({ prompt })) as never,
        listen: {
          sessions: async () => looking.promise as never,
          start: async (id, target) => {
            calls.push(['listen.start', id, target]);
          },
        },
      }),
    { n: 1, chatOpen: true },
  );
  try {
    const button = () => $<HTMLButtonElement>('.ou-askhint .ou-startlisten');
    fire(button(), 'click');
    assert.equal(button().textContent, 'Looking…');
    prompt = '/once-upon-listen acme/other';
    await panel.overlay.refreshHealth();
    await settle();
    assert.equal(button().textContent, 'Start listening', 'the new hint has a fresh button');
    assert.equal(button().disabled, false);
    looking.resolve([SESSION]);
    await settle();
    assert.equal(
      calling(panel.calls, 'listen.start').length,
      1,
      'the click still types into the session',
    );
    assert.equal(button().textContent, 'Start listening');
    assert.equal(button().disabled, false);
    assert.ok($('.ou-askhint .ou-startnote').hasAttribute('hidden'), 'and leaves no note');
  } finally {
    panel.done();
  }
});

await test('the hint keeps its details open for the same markup and drops them for new markup', async () => {
  let details = 'Paste this:\n/once-upon-listen x';
  const panel = await mount(
    story(),
    withStatus(() => notListening({ details })),
    {
      n: 1,
      chatOpen: true,
    },
  );
  try {
    const more = () => $('.ou-askhint .ou-promptmore');
    const long = () => $('.ou-askhint .ou-promptlong');
    assert.ok(long().hasAttribute('hidden'));
    fire(more(), 'click');
    assert.ok(!long().hasAttribute('hidden'));
    assert.equal(more().textContent, 'hide details');
    assert.equal(more().getAttribute('aria-expanded'), 'true');
    panel.overlay.apply();
    await panel.overlay.refreshHealth();
    await settle();
    assert.ok(!long().hasAttribute('hidden'), 'the same health leaves it open');
    assert.equal(more().textContent, 'hide details');
    details = 'Another line';
    await panel.overlay.refreshHealth();
    await settle();
    assert.ok(long().hasAttribute('hidden'), 'new markup starts again');
    assert.equal(more().textContent, 'show details');
  } finally {
    panel.done();
  }
});

// ---------- drafts, fixes, the working banner, freshness and rebuild (recorded on the string versions, before they drew with Preact)

/** After a flow: two more draws change nothing (a label written by hand would be reverted, a state a draw cleared would show). */
const stays = (panel: Mounted, what: string) => {
  const before = panel.shot();
  panel.overlay.apply();
  panel.overlay.apply();
  assert.ok(panel.shot() === before, `${what}: a redraw changes nothing`);
};
const GITHUB_AT = '2099-01-01T00:00:00Z';
/** What the panel focused, in order (the panel is in a shadow root, which the kit's activeElement does not see into). */
const focusLog: Element[] = [];
const focusedNow = () => focusLog.at(-1);
{
  const proto = window.HTMLElement.prototype;
  const focus = proto.focus;
  proto.focus = function (this: HTMLElement, ...args: []) {
    focusLog.push(this);
    return focus.apply(this, args);
  };
}
const draftOptions =
  (
    rows: () => DraftRow[],
    act?: (chapter: number, index: number, action: string) => Promise<DraftsAnswer>,
    extra: Partial<PanelOptions> = {},
  ) =>
  (calls: unknown[][]) =>
    fullOptions(calls, {
      pulse: undefined,
      drafts: {
        load: async () => {
          calls.push(['drafts.load']);
          return { drafts: rows(), error: null };
        },
        act: async (chapter, index, action) => {
          calls.push(['drafts.act', chapter, index, action]);
          return act ? act(chapter, index, action) : { drafts: rows(), error: null };
        },
      },
      ...extra,
    });
const comment = (step: number, index: number) =>
  $(`.ou-comment[data-n="${step}"][data-i="${index}"]`);
const draftButton = (step: number, index: number, action: string) =>
  $<HTMLButtonElement>(
    `.ou-comment[data-n="${step}"][data-i="${index}"] [data-draft-act="${action}"]`,
  );

await test('flow-drafts-add-dismiss-restore: each button calls its route once, shows the wait and the error, and a failed add keeps both buttons', async () => {
  let answer: Promise<DraftsAnswer> | null = null;
  const panel = await mount(
    story(),
    draftOptions(
      () => [],
      () => answer ?? Promise.resolve({ drafts: [], error: null }),
    ),
    { n: 2 },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    const acts = () => calling(panel.calls, 'drafts.act');
    shot('plain drafts');
    const gate = deferred<DraftsAnswer>();
    answer = gate.promise;
    fire(draftButton(2, 3, 'review'), 'click');
    assert.equal(acts().length, 1, 'one click, one Add to my review');
    assert.equal(draftButton(2, 3, 'review').disabled, true);
    assert.equal(draftButton(2, 3, 'review').textContent, 'Adding…');
    shot('adding (sync)');
    gate.resolve({
      drafts: [
        {
          chapter: 2,
          index: 3,
          status: 'draft',
          dismissed: false,
          added: { at: GITHUB_AT, url: 'https://github.com/acme/widgets/pull/7#c9' },
        },
      ],
      added: { at: GITHUB_AT, url: 'x', started: true },
    } as never);
    await settle();
    assert.equal(acts().length, 1);
    assert.equal(
      $('.ou-msg').textContent,
      'Added to your pending review (started a new one). Nobody else sees it until you submit the review.',
    );
    shot('added');
    answer = Promise.reject(new Error('GitHub said no'));
    answer.catch(() => {});
    fire(draftButton(2, 0, 'review'), 'click');
    assert.equal(acts().length, 2);
    await settle();
    assert.ok(comment(2, 0).textContent!.includes('GitHub said no'), 'the error is on the draft');
    assert.ok(draftButton(2, 0, 'review') && draftButton(2, 0, 'fix'), 'both buttons are back');
    assert.equal(draftButton(2, 0, 'review').disabled, false);
    shot('add failed');
    panel.overlay.go(1);
    panel.overlay.go(2);
    assert.ok(
      comment(2, 0).textContent!.includes('GitHub said no'),
      'the error is kept across steps',
    );
    answer = Promise.resolve({ drafts: [], error: null });
    fire(draftButton(2, 0, 'review'), 'click');
    assert.equal(acts().length, 3);
    await settle();
    shot('added after a failure');
    const dismissed: DraftRow[] = [{ chapter: 2, index: 1, status: 'draft', dismissed: true }];
    answer = Promise.resolve({ drafts: dismissed, error: null });
    fire(draftButton(2, 1, 'dismiss'), 'click');
    assert.equal(acts().length, 4);
    await settle();
    shot('dismissed (hidden)');
    fire($('[data-draft-show="showDismissed"]'), 'click');
    shot('dismissed shown');
    answer = Promise.resolve({ drafts: [], error: null });
    fire(draftButton(2, 1, 'restore'), 'click');
    assert.equal(acts().length, 5);
    await settle();
    shot('restored');
    answer = Promise.resolve({
      drafts: [
        {
          chapter: 2,
          index: 0,
          status: 'draft',
          dismissed: false,
          fix: { path: 'src/c.ts', side: 'L', line: 7, state: 'draft' },
        },
      ],
      error: null,
    } as never);
    fire(draftButton(2, 0, 'fix'), 'click');
    assert.equal(acts().length, 6);
    assert.equal(draftButton(2, 0, 'fix').textContent, 'Adding…');
    await settle();
    shot('added to fix before push');
    check('flow-drafts-actions', shots.join('\n'));
    assert.deepEqual(
      acts().map((call) => call.slice(1)),
      [
        [2, 3, 'review'],
        [2, 0, 'review'],
        [2, 0, 'review'],
        [2, 1, 'dismiss'],
        [2, 1, 'restore'],
        [2, 0, 'fix'],
      ],
    );
    assert.equal(
      calling(panel.calls, 'fixes.load').length >= 2,
      true,
      'Add to fix asks the notes again',
    );
    stays(panel, 'drafts actions');
  } finally {
    panel.done();
  }
});

await test('a drafts answer that arrives after a step change draws the step on screen', async () => {
  const gate = deferred<DraftsAnswer>();
  const panel = await mount(
    story(),
    draftOptions(
      () => [],
      () => gate.promise,
    ),
    { n: 1 },
  );
  try {
    fire(draftButton(1, 1, 'dismiss'), 'click');
    panel.overlay.go(2);
    gate.resolve({
      drafts: [
        { chapter: 2, index: 0, status: 'posted', dismissed: false, url: 'https://x/c1' },
        { chapter: 2, index: 1, status: 'draft', dismissed: true },
      ],
      error: null,
    });
    await settle();
    assert.ok(comment(2, 0).hasAttribute('hidden'), 'a posted comment is hidden');
    assert.ok(comment(2, 1).classList.contains('ou-c-done'));
    assert.match($('.ou-drafts .ou-draftsum').textContent!, /1 posted/);
    check('drafts-late-reply', panel.shot());
  } finally {
    panel.done();
  }
});

await test('Copy on a drafted comment copies it once, says so for a moment, and selects the text when the clipboard says no', async () => {
  startClock();
  clipboardEnv.written = [];
  clipboardEnv.selected = [];
  clipboardEnv.mode = 'ok';
  clipboardEnv.exec = true;
  clipboardEnv.execCalls = 0;
  const panel = await mount(
    story(),
    draftOptions(() => []),
    { n: 2 },
    { wait: pumpOnce },
  );
  try {
    const copy = () => $<HTMLButtonElement>('.ou-comment[data-i="3"] .ou-copy');
    fire(copy(), 'click');
    await pump(100);
    assert.deepEqual(clipboardEnv.written, ['Fix me'], 'one click, one write');
    assert.equal(copy().textContent, 'Copied');
    await pump(1500);
    assert.equal(copy().textContent, 'Copy');
    clipboardEnv.mode = 'refused';
    fire(copy(), 'click');
    await pump(100);
    assert.equal(clipboardEnv.execCalls, 1);
    assert.equal(clipboardEnv.selected.length, 1);
    assert.equal(clipboardEnv.selected[0].nodeName, 'PRE', 'the comment is selected');
    assert.equal(copy().textContent, 'Copied');
    await pump(1500);
    clipboardEnv.exec = false;
    fire(copy(), 'click');
    await pump(100);
    assert.equal(copy().textContent, 'Select and copy');
    await pump(1500);
    assert.equal(copy().textContent, 'Copy');
    assert.equal(clipboardEnv.written.length, 3);
    stays(panel, 'copy');
  } finally {
    panel.done();
    stopClock();
    clipboardEnv.mode = 'ok';
    clipboardEnv.exec = true;
  }
});

await test('flow-drafts-script-and-toggles: Copy as gh script, Show posted, Reload page and a chapter link on the Overview', async () => {
  startClock();
  clipboardEnv.written = [];
  clipboardEnv.selected = [];
  clipboardEnv.mode = 'ok';
  const rows: DraftRow[] = [
    { chapter: 1, index: 0, status: 'posted', dismissed: false, url: 'https://x/c1' },
    { chapter: 2, index: 1, status: 'draft', dismissed: true },
    {
      chapter: 2,
      index: 2,
      status: 'draft',
      dismissed: false,
      added: { at: GITHUB_AT, url: 'https://x/c3' },
    },
  ];
  const panel = await mount(
    story(),
    draftOptions(() => rows),
    { n: 0 },
    { wait: pumpOnce },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    const script = () => $<HTMLButtonElement>('[data-draft-script]');
    const label = script().textContent;
    assert.match(label!, /^Copy as gh script \(\d+\)$/);
    fire(script(), 'click');
    await pump(100);
    assert.equal(clipboardEnv.written.length, 1, 'one click, one write');
    assert.match(clipboardEnv.written[0], /acme\/widgets/);
    assert.equal(script().textContent, 'Copied');
    await pump(1500);
    assert.equal(script().textContent, label);
    clipboardEnv.mode = 'refused';
    fire(script(), 'click');
    await pump(100);
    assert.equal(clipboardEnv.written.length, 2);
    assert.equal(script().textContent, 'Select and copy');
    assert.equal($('.ou-script').hasAttribute('hidden'), false, 'the script shows to copy by hand');
    assert.equal($('.ou-script').textContent, clipboardEnv.written[1]);
    assert.equal(clipboardEnv.selected.at(-1)?.nodeName, 'PRE');
    await pump(1500);
    assert.equal(script().textContent, label);
    shot('script shown');
    panel.overlay.apply();
    assert.equal($('.ou-script').hasAttribute('hidden'), false, 'a redraw keeps it');
    panel.overlay.go(1);
    panel.overlay.go(0);
    assert.equal($('.ou-script').hasAttribute('hidden'), true, 'a step change starts again');
    const details = $<HTMLDetailsElement>('details.ou-allc');
    assert.equal(details.hasAttribute('open'), false);
    details.open = true;
    fire(details, 'toggle');
    panel.overlay.go(1);
    panel.overlay.go(0);
    assert.equal($('details.ou-allc').hasAttribute('open'), true, 'the open list is remembered');
    shot('list open');
    fire($('[data-draft-show="showPosted"]'), 'click');
    assert.match($('[data-draft-show="showPosted"]').textContent!, /^Hide posted/);
    const states = calling(panel.calls, 'onState').length;
    fire($('[data-draft-show="showPosted"]'), 'click');
    assert.equal(calling(panel.calls, 'onState').length, states + 1, 'a click saves once');
    assert.match($('[data-draft-show="showPosted"]').textContent!, /^Show posted/);
    shot('posted shown and hidden');
    fire($('[data-goto="2"]'), 'click');
    assert.equal(panel.overlay.state.n, 2, 'a chapter link goes to it');
    assert.match($('.ou-title').textContent!, /Chapter 2/);
    fire($('[data-draft-reload]'), 'click');
    assert.equal(calling(panel.calls, 'reloadPage').length, 1, 'Reload page reloads once');
    check('flow-drafts-script-toggles', shots.join('\n'));
    stays(panel, 'script and toggles');
  } finally {
    panel.done();
    stopClock();
    clipboardEnv.mode = 'ok';
  }
});

await test('a draft added to the review turns pending once its comment is on the page, and a settled one is settled once', async () => {
  const rows: DraftRow[] = [
    {
      chapter: 2,
      index: 0,
      status: 'draft',
      dismissed: false,
      added: { at: GITHUB_AT, url: 'https://github.com/acme/widgets/pull/7#c9' },
    },
    {
      chapter: 2,
      index: 1,
      key: 'k-2-1',
      status: 'posted',
      dismissed: false,
      source: 'github',
      url: 'https://github.com/acme/widgets/pull/7#c1',
      added: { at: '2026-01-01T00:00:00Z', url: 'https://github.com/acme/widgets/pull/7#c1' },
    },
  ];
  const panel = await mount(
    story(),
    draftOptions(() => rows),
    { n: 2 },
  );
  try {
    assert.match(comment(2, 0).textContent!, /GitHub shows it after a reload/);
    const block = panel.world.blocks.find((one) => one.rel === 'src/c.ts')!;
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = 'Dropped line';
    block.el.appendChild(body);
    panel.overlay.go(1);
    panel.overlay.go(2);
    assert.match(comment(2, 0).textContent!, /not submitted yet/, 'on the page now');
    assert.ok(!/GitHub shows it after a reload/.test(comment(2, 0).textContent!));
    panel.overlay.apply();
    panel.overlay.apply();
    await settle();
    assert.equal(
      calling(panel.calls, 'drafts.act').filter((call) => call[3] === 'settle').length,
      1,
      'one settle however often it is drawn',
    );
    check('drafts-on-page-and-settled', panel.shot());
  } finally {
    panel.done();
  }
});

await test('an added draft shows "view on GitHub" only when GitHub returned a comment URL', async () => {
  const rows = [
    {
      chapter: 2,
      index: 0,
      status: 'draft',
      dismissed: false,
      added: { at: GITHUB_AT, url: null },
    },
    {
      chapter: 2,
      index: 1,
      status: 'draft',
      dismissed: false,
      added: { at: GITHUB_AT, url: 'https://github.com/acme/widgets/pull/7#c9' },
    },
  ] as unknown as DraftRow[];
  const panel = await mount(
    story(),
    draftOptions(() => rows),
    { n: 2 },
  );
  try {
    assert.match(comment(2, 0).textContent!, /GitHub shows it after a reload/);
    assert.equal(comment(2, 0).querySelector('a'), null, 'no URL, no link');
    assert.match(comment(2, 1).textContent!, /GitHub shows it after a reload/);
    const link = comment(2, 1).querySelector('a')!;
    assert.equal(link.getAttribute('href'), 'https://github.com/acme/widgets/pull/7#c9');
    assert.equal(link.textContent, 'view on GitHub');
  } finally {
    panel.done();
  }
});

// ---------- every jump link in the body jumps once

await test('every file and line link in the body, the drafts, the fixes and the banner jumps once, and Enter on one is a click', async () => {
  const panel = await mount(story(), full, { n: 0 });
  try {
    const reveals = () => calling(panel.calls, 'reveal').length;
    const jump = async (selector: string) => {
      const el = $(selector);
      assert.ok(el, `${selector} is drawn`);
      const rel = el.getAttribute('data-rel')!;
      const line = el.hasAttribute('data-start')
        ? {
            side: (el.getAttribute('data-side') || 'R') as 'L' | 'R',
            start: +el.getAttribute('data-start')!,
            end: +el.getAttribute('data-end')! || +el.getAttribute('data-start')!,
          }
        : null;
      let base = reveals();
      await panel.overlay.jumpTo(rel, line);
      const once = reveals() - base;
      assert.ok(once > 0, `${selector}: a jump asks the host to reveal`);
      base = reveals();
      fire(el, 'click');
      await settle();
      assert.equal(reveals() - base, once, `${selector}: a click is one jump`);
      if (el.getAttribute('role') === 'link') {
        base = reveals();
        fire(el, 'keydown', { key: 'Enter' });
        await settle();
        assert.equal(reveals() - base, once, `${selector}: Enter is one jump`);
      }
    };
    await jump('.ou-md [data-rel]');
    await jump('.ou-uncovered code[data-rel]');
    await jump('.ou-working code[data-rel]');
    await jump('.ou-fixnote code[data-rel]');
    await jump('.ou-files li[data-file] code[data-rel]');
    panel.overlay.go(1);
    await jump('.ou-md [data-rel]');
    await jump('.ou-comment .ou-where code[data-rel]');
    await jump('.ou-files .ou-lines [data-rel]');
    panel.overlay.go(2);
    await jump('.ou-comment .ou-ui-linkish[data-rel]'); // Jump to line N on a fix before push note
    panel.world.viewed.set('src/a.ts', true);
    panel.world.viewed.set('src/c.ts', true);
    panel.overlay.apply();
    await jump('.ou-early-box code[data-rel]');
    await jump('.ou-progress code[data-rel]');
  } finally {
    panel.done();
  }
});

// ---------- fixes before push

const fixesOptions =
  (
    current: { view: FixesView },
    act?: (body: Record<string, unknown>) => Promise<FixesView> | FixesView,
    extra: Partial<PanelOptions> = {},
  ) =>
  (calls: unknown[][]) =>
    fullOptions(calls, {
      pulse: undefined,
      fixes: {
        load: async () => {
          calls.push(['fixes.load']);
          return structuredClone(current.view);
        },
        act: async (body) => {
          calls.push(['fixes.act', body]);
          return act ? act(body as never) : structuredClone(current.view);
        },
        note: async (id, changes) => {
          calls.push(['fixes.note', id, changes]);
          return {};
        },
      },
      ...extra,
    });
const fixButton = (act: string, note?: string) =>
  $<HTMLButtonElement>(
    `.ou-fixes ${note ? `[data-note-id="${note}"] ` : ''}[data-fix-act="${act}"]`,
  );
const editor = () => $<HTMLTextAreaElement>('.ou-fixedit');
const ticked = (el: HTMLElement) =>
  !!(el as HTMLInputElement).checked || el.hasAttribute('checked');
const isOff = (el: HTMLElement) =>
  !!(el as HTMLButtonElement).disabled || el.hasAttribute('disabled');

await test('flow-fixes-edit: Edit opens a focused editor that keeps its text, Save and Remove call their routes once', async () => {
  const current = { view: structuredClone(FIXES) };
  const panel = await mount(story(), fixesOptions(current), { n: 0 });
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    const notes = () => calling(panel.calls, 'fixes.note');
    focusLog.length = 0;
    fire(fixButton('edit', 'n1'), 'click');
    assert.equal(editor().value, 'Rename it');
    assert.ok(focusedNow() === editor(), 'a new editor takes focus');
    shot('editing');
    editor().value = 'Renamed it';
    await panel.overlay.refreshFixes();
    assert.equal(editor().value, 'Renamed it', 'a look with nothing new keeps the text');
    current.view.notes.push({
      id: 'n9',
      at: '2026-11-03T10:09:00Z',
      path: 'src/a.ts',
      line: 4,
      side: 'R',
      body: 'Another',
      state: 'draft',
      draft: 'x',
    });
    await panel.overlay.refreshFixes();
    assert.equal(editor().value, 'Renamed it', 'a look with a new note keeps the text');
    shot('editing while a note came in');
    fire(fixButton('cancel', 'n1'), 'click');
    assert.ok(editor() === null);
    assert.equal(notes().length, 0, 'Cancel saves nothing');
    fire(fixButton('edit', 'n1'), 'click');
    editor().value = '   ';
    fire(fixButton('save', 'n1'), 'click');
    await settle();
    assert.equal(notes().length, 0, 'empty text sends no note');
    assert.ok(editor() === null, 'and ends the edit');
    fire(fixButton('edit', 'n1'), 'click');
    editor().value = 'New text';
    fire(fixButton('save', 'n1'), 'click');
    await settle();
    assert.deepEqual(
      notes().map((call) => call.slice(1)),
      [['n1', { body: 'New text' }]],
      'Save is one note call',
    );
    fire(fixButton('remove', 'n9'), 'click');
    await settle();
    assert.deepEqual(notes().at(-1)!.slice(1), ['n9', { delete: true }]);
    assert.equal(notes().length, 2, 'Remove is one note call');
    fire(fixButton('edit', 'n1'), 'click');
    editor().value = 'lost on a step change';
    focusLog.length = 0;
    panel.overlay.go(1);
    assert.equal(
      editor().value,
      'Rename it',
      'a step change starts the editor again with the note',
    );
    assert.ok(focusedNow() === editor(), 'the editor takes focus');
    shot('after a step change');
    check('flow-fixes-edit', shots.join('\n'));
    stays(panel, 'fixes edit');
  } finally {
    panel.done();
  }
});

await test('flow-fixes-tools: Send, Auto-send and Take back call their routes once, a second click while one runs is ignored', async () => {
  const current = { view: structuredClone(FIXES) };
  let answer: Promise<FixesView> | FixesView | null = null;
  const panel = await mount(
    story(),
    fixesOptions(current, () => answer ?? structuredClone(current.view)),
    { n: 0 },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    const acts = () => calling(panel.calls, 'fixes.act').map((call) => call[1]);
    shot('tools');
    const gate = deferred<FixesView>();
    answer = gate.promise;
    fire(fixButton('send'), 'click');
    assert.equal(fixButton('send').disabled, true, 'the control is off while it goes');
    fire(fixButton('send'), 'click');
    fire(fixButton('send'), 'click');
    assert.deepEqual(acts(), [{ action: 'send' }], 'a second click while it runs is ignored');
    shot('sending');
    gate.resolve({ ...structuredClone(current.view), sent: { to: 'author-1' } } as never);
    await settle();
    assert.equal(fixButton('send').disabled, false);
    assert.equal(
      $('.ou-msg').textContent,
      'Sent to author-1. Its notes are locked until it reports back.',
    );
    answer = { ...structuredClone(current.view), to: null } as never;
    fire(fixButton('send'), 'click');
    await settle();
    assert.equal(
      $('.ou-msg').textContent,
      'Queued: the next Claude session that takes fix requests for this story gets it.',
    );
    assert.equal(acts().length, 2);
    // Auto-send: ticked from the click until the answer
    const autoGate = deferred<FixesView>();
    answer = autoGate.promise;
    const box = () => $<HTMLInputElement>('.ou-fixauto input');
    box().checked = true;
    fire(box(), 'click');
    assert.equal(ticked(box()), true, 'still ticked while the request is out');
    assert.equal(isOff(box()), true, 'and off');
    autoGate.resolve({ ...structuredClone(current.view), auto_send: true });
    await settle();
    assert.deepEqual(acts().at(-1), { action: 'auto', on: true });
    assert.equal(acts().length, 3);
    assert.equal(ticked(box()), true);
    assert.equal(isOff(box()), false);
    shot('auto-send on');
    answer = null;
    current.view.auto_send = true;
    fire(fixButton('take_back'), 'click');
    await settle();
    assert.deepEqual(acts().at(-1), { action: 'take_back', request: 'r1' });
    assert.equal(acts().length, 4, 'Take back is one call');
    await panel.overlay.sendFixes();
    assert.deepEqual(acts().at(-1), { action: 'send' }, 'a send from outside the panel');
    assert.equal(acts().length, 5);
    check('flow-fixes-tools', shots.join('\n'));
    stays(panel, 'fixes tools');
  } finally {
    panel.done();
  }
});

await test('a failed fix call says why and looks again; the list is the bridge’s: notes, read-only, auto-send with no notes', async () => {
  const current = { view: structuredClone(FIXES) };
  let fail = true;
  const panel = await mount(
    story(),
    fixesOptions(current, () => (fail ? Promise.reject(new Error('boom')) : current.view)),
    { n: 0 },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) => shots.push(`### ${label}\n${panel.shot()}`);
    const loads = calling(panel.calls, 'fixes.load').length;
    fire(fixButton('send'), 'click');
    await settle();
    assert.equal($('.ou-msg').textContent, "Couldn't save that: boom");
    assert.equal(calling(panel.calls, 'fixes.load').length, loads + 1, 'it looks again');
    assert.equal(fixButton('send').disabled, false);
    panel.overlay.go(1);
    shot('chapter 1 (notes on its files, and a line for the rest)');
    panel.overlay.go(3);
    shot('chapter 3');
    fail = false;
    current.view = { ...structuredClone(FIXES), can_add: false };
    await panel.overlay.refreshFixes();
    panel.overlay.go(0);
    shot('read-only');
    assert.ok(maybe('.ou-fixtools') === null);
    assert.ok(maybe('[data-draft-act="fix"]') === null);
    current.view = { ...structuredClone(FIXES), notes: [], auto_send: true };
    await panel.overlay.refreshFixes();
    shot('auto-send with no notes');
    current.view = { ...structuredClone(FIXES), notes: [], auto_send: false };
    await panel.overlay.refreshFixes();
    assert.ok(maybe('.ou-fixes h2') === null, 'no notes and no auto-send: nothing');
    check('fixes-states', shots.join('\n'));
  } finally {
    panel.done();
  }
});

await test('a fixes answer that arrives after a step change draws the step on screen', async () => {
  const current = { view: structuredClone(FIXES) };
  const gate = deferred<FixesView>();
  let slow = false;
  const panel = await mount(
    story(),
    (calls) => {
      const opts = fixesOptions(current)(calls);
      const load = opts.fixes!.load;
      opts.fixes!.load = () => (slow ? gate.promise : load());
      return opts;
    },
    { n: 1 },
  );
  try {
    slow = true;
    const pending = panel.overlay.refreshFixes();
    panel.overlay.go(2);
    gate.resolve({ ...structuredClone(FIXES), notes: FIXES.notes.slice(1, 2) });
    await pending;
    await settle();
    assert.equal(all('.ou-fixnote').length, 1, 'chapter 2 lists its file’s note only');
    check('fixes-late-reply', panel.shot());
  } finally {
    panel.done();
  }
});

// ---------- the working banner

await test('the working banner names each session, a few files, and tags the rows and the page', async () => {
  const marks = [
    ...WORKING,
    {
      consumer: 'author-3',
      files: [
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'README.md',
        'x/y/z.ts',
        'q/r.ts',
        'w/v.ts',
        'u.ts',
      ].map((path, i) => ({ path, ranges: i === 1 ? ([[4, 4]] as [number, number][]) : [] })),
      started_at: '2026-11-03T11:45:00Z',
      at: '2026-11-03T11:50:00Z',
    },
  ];
  const panel = await mount(
    story(),
    (calls) => fullOptions(calls, { pulse: undefined, working: async () => ({ marks }) }),
    { n: 1 },
  );
  try {
    assert.equal(all('.ou-beingchg').length, 2);
    assert.match(all('.ou-beingchg')[1].textContent!, /and 2 more/);
    check('working-banner-two-sessions', panel.shot());
    const slot = $('.ou-working');
    panel.overlay.apply();
    assert.ok($('.ou-working') === slot, 'a redraw keeps the banner’s node');
    panel.overlay.go(2);
    assert.ok($('.ou-working') !== slot, 'a step change draws a new one');
    assert.equal(all('.ou-beingchg').length, 2);
  } finally {
    panel.done();
  }
});

// ---------- freshness, the since banner and rebuild

const REQUEST_AT = '2026-11-03T11:50:00Z';
const pulseOptions =
  (extra: Record<string, unknown>, overrides: Partial<PanelOptions> = {}) =>
  (calls: unknown[][]) =>
    fullOptions(calls, {
      pulse: async () => {
        calls.push(['pulse']);
        return {
          version: 'v1',
          questions_rev: '1',
          drafts_rev: '1',
          fixes_rev: '1',
          working_rev: '1',
          listening: false,
          answering: null,
          rebuild: null,
          request: null,
          ...extra,
        } as never;
      },
      ...overrides,
    });

await test('freshness-states: the line under the toolbar for every state, alone and with a request in flight', async () => {
  const shots: string[] = [];
  const states: [
    string,
    NonNullable<Parameters<typeof fullOptions>[1]>['freshness'],
    Record<string, unknown>,
  ][] = [
    ['current', async () => ({ state: 'current', story_head: 'abcdef1234567' }), {}],
    ['current and updated', async () => CURRENT_UPDATED, {}],
    ['stale', async () => STALE, {}],
    ['stale and rewritten', async () => ({ ...STALE, rewritten: true, newer: null }), {}],
    ['unknown with an error', async () => ({ state: 'unknown', error: 'bridge said no' }), {}],
    ['unknown without one', async () => ({ state: 'unknown' }), {}],
    ['n/a', async () => ({ state: 'n/a' }), {}],
    [
      'stale, update queued',
      async () => STALE,
      {
        request: {
          kind: 'update',
          state: 'queued',
          requested_at: REQUEST_AT,
          claimed_by: null,
          claimed_at: null,
        },
      },
    ],
    [
      'stale, update building',
      async () => STALE,
      {
        request: {
          kind: 'update',
          state: 'building',
          requested_at: REQUEST_AT,
          claimed_by: 'session-a',
          claimed_at: REQUEST_AT,
        },
      },
    ],
    [
      'stale, a rebuild in flight',
      async () => STALE,
      {
        request: {
          kind: 'rebuild',
          state: 'building',
          requested_at: REQUEST_AT,
          claimed_by: 'session-a',
          claimed_at: REQUEST_AT,
        },
      },
    ],
    [
      'current, a rebuild in flight',
      async () => ({ state: 'current', story_head: 'abcdef1234567' }),
      {
        request: {
          kind: 'rebuild',
          state: 'building',
          requested_at: REQUEST_AT,
          claimed_by: 'session-a',
          claimed_at: REQUEST_AT,
        },
      },
    ],
    [
      'current, a build in flight',
      async () => ({ state: 'current', story_head: 'abcdef1234567' }),
      {
        request: {
          kind: 'build',
          state: 'queued',
          requested_at: REQUEST_AT,
          claimed_by: null,
          claimed_at: null,
        },
      },
    ],
    [
      'unknown, a fix in flight',
      async () => ({ state: 'unknown', error: 'e' }),
      {
        request: {
          kind: 'fix',
          state: 'building',
          requested_at: REQUEST_AT,
          claimed_by: 's',
          claimed_at: REQUEST_AT,
        },
      },
    ],
  ];
  for (const [name, freshness, extra] of states) {
    const panel = await mount(story(), pulseOptions(extra, { freshness }), { n: 1 });
    try {
      await settle();
      shots.push(
        `### ${name}\n${[$('.ou-fresh'), $('.ou-rebuilding')].map((el) => serialize(el).join('\n')).join('\n')}`,
      );
    } finally {
      panel.done();
    }
  }
  check('freshness-states', shots.join('\n'));
});

await test('Update and Re-tell: all the buttons go off at once, the one asked for says so, a failure brings them back', async () => {
  let fail = false;
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        pulse: undefined,
        requestUpdate: async (head, options) => {
          calls.push(['requestUpdate', head, options]);
          if (fail) {
            throw new Error('nope');
          }
          return {};
        },
      }),
    { n: 1 },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) =>
      shots.push(
        `### ${label}\n${serialize($('.ou-fresh')).join('\n')}\n${$('.ou-msg').textContent}`,
      );
    const update = () => $<HTMLButtonElement>('.ou-update[data-retell="0"]');
    const retell = () => $<HTMLButtonElement>('.ou-update[data-retell="1"]');
    const asks = () => calling(panel.calls, 'requestUpdate');
    shot('stale');
    fire(retell(), 'click');
    assert.equal(update().disabled && retell().disabled, true, 'both off at once');
    assert.equal(asks().length, 1, 'one click, one request');
    shot('asking');
    await settle();
    assert.equal(retell().textContent, 'Re-tell asked for');
    assert.equal(update().disabled && retell().disabled, true);
    assert.deepEqual(asks()[0].slice(1), [STALE.story_head, { retell: true }]);
    shot('asked');
    window.dispatchEvent(new window.Event('focus')); // the slow look: freshness comes again
    await settle();
    assert.equal(retell().textContent, 'Re-tell from scratch');
    assert.equal(update().disabled, false);
    shot('looked again');
    fail = true;
    fire(update(), 'click');
    await settle();
    assert.equal(update().disabled || retell().disabled, false, 'a failure brings them back');
    assert.equal($('.ou-msg').textContent, "Couldn't ask for an update: nope");
    assert.deepEqual(asks().at(-1)!.slice(1), [STALE.story_head, { retell: false }]);
    assert.equal(asks().length, 2);
    shot('failed');
    check('flow-update-buttons', shots.join('\n'));
    stays(panel, 'update buttons');
  } finally {
    panel.done();
  }
});

await test('the request line’s minutes move on with the clock when the page has no freshness call', async () => {
  startClock();
  let request: Record<string, unknown> | null = {
    kind: 'update',
    state: 'building',
    requested_at: '2026-11-03T11:48:00Z',
    claimed_by: 'session-a',
    claimed_at: '2026-11-03T11:50:00Z',
  };
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        freshness: undefined,
        pulse: async () => ({ version: 'v1', rebuild: null, request }) as never,
      }),
    { n: 1 },
    { wait: pumpOnce },
  );
  try {
    await pump(100);
    assert.match(
      $('.ou-fresh').textContent!,
      /Updating the story for you….*\(10 min ago\), session-a/,
    );
    await pump(3 * 60000, 1000);
    window.dispatchEvent(new window.Event('focus'));
    await pump(100);
    assert.match($('.ou-fresh').textContent!, /\(13 min ago\)/);
    request = null;
    window.dispatchEvent(new window.Event('focus'));
    await pump(100);
    assert.ok(!/min ago/.test($('.ou-fresh').textContent!));
  } finally {
    panel.done();
    stopClock();
  }
});

const showing = (state: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });

await test('the pulse tick: one pulse a first and then every 5 s while the tab shows, none while it is hidden, one on focus, none after destroy', async () => {
  startClock();
  const panel = await mount(story(), pulseOptions({}), { n: 1 }, { wait: pumpOnce });
  const pulses = () => calling(panel.calls, 'pulse').length;
  try {
    assert.equal(pulses(), 1, 'the first pulse comes with the mount');
    await pump(4900);
    assert.equal(pulses(), 1, 'not before 5 s');
    await pump(300);
    assert.equal(pulses(), 2);
    await pump(5200); // 5 s after the last pulse came back
    assert.equal(pulses(), 3);
    showing('hidden');
    await pump(30000);
    assert.equal(pulses(), 3, 'a hidden tab does not pulse');
    showing('visible');
    await pump(5200);
    assert.equal(pulses(), 4);
    window.dispatchEvent(new window.Event('focus'));
    await pump(100);
    assert.equal(pulses(), 5, 'focus asks at once');
  } finally {
    panel.done();
  }
  await pump(30000);
  assert.equal(pulses(), 5, 'destroy stops the tick and the focus pulse');
  window.dispatchEvent(new window.Event('focus'));
  await pump(100);
  assert.equal(pulses(), 5);
  stopClock();
});

await test('a pulse that hangs past the poll’s timeout reads as down: the status light looks again', async () => {
  startClock();
  let hang = false;
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        pulse: () => {
          calls.push(['pulse']);
          return hang
            ? new Promise<never>(() => {})
            : Promise.resolve({ version: 'v1', rebuild: null, request: null } as never);
        },
        status: async () => {
          calls.push(['status']);
          return Promise.reject(Object.assign(new Error('x'), { code: 'down' }));
        },
      }),
    { n: 1 },
    { wait: pumpOnce },
  );
  const looks = () => calling(panel.calls, 'status').length;
  try {
    await pump(5200);
    const before = looks();
    hang = true;
    await pump(5000); // the next pulse goes out and never comes back
    assert.equal(calling(panel.calls, 'pulse').length, 3);
    await pump(55000);
    assert.equal(looks(), before, 'not yet: the poll waits 60 s for the pulse');
    await pump(6000);
    assert.equal(looks(), before + 1, 'the timed-out pulse moved the panel to down');
  } finally {
    panel.done();
    stopClock();
  }
});

await test('a focus that lands on the 12th tick runs the slow look once (drafts, freshness, reads)', async () => {
  startClock();
  let freshness = 0;
  const panel = await mount(
    story(),
    pulseOptions(
      {},
      {
        freshness: async () => {
          freshness++;
          return { state: 'current', story_head: 'abcdef1234567' };
        },
      },
    ),
    { n: 1 },
    { wait: pumpOnce },
  );
  try {
    // the poll waits 5 s after each pulse comes back: run until the 12th pulse is in (11 ticks), then focus is the 12th
    const pulses = () => calling(panel.calls, 'pulse').length;
    for (let waited = 0; pulses() < 12 && waited < 120000; waited += 50) {
      await pump(50);
    }
    assert.equal(pulses(), 12, 'eleven ticks in');
    const before = freshness;
    window.dispatchEvent(new window.Event('focus'));
    await pump(100);
    assert.equal(freshness - before, 1, 'one freshness look for the focus, not two');
  } finally {
    panel.done();
    stopClock();
  }
});

await test('stillOpen: said about once a minute while the tab is hidden, never while it shows, and not after destroy', async () => {
  startClock();
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        pulse: undefined,
        stillOpen: async () => void calls.push(['stillOpen']),
      }),
    { n: 1 },
    { wait: pumpOnce },
  );
  const said = () => calling(panel.calls, 'stillOpen').length;
  try {
    await pump(180000, 1000);
    assert.equal(said(), 0, 'a showing tab says nothing');
    showing('hidden');
    await pump(59000, 1000);
    assert.equal(said(), 0, 'not before the minute is up');
    await pump(1500, 500);
    assert.equal(said(), 1);
    await pump(60000, 1000);
    assert.equal(said(), 2);
  } finally {
    panel.done();
  }
  await pump(120000, 1000);
  assert.equal(said(), 2, 'destroy stops it');
  stopClock();
});

await test('the "Since you read it" banner, with and without a link to GitHub, and on that range’s own page', async () => {
  const shots: string[] = [];
  const banner = () => serialize($('.ou-since')).join('\n');
  const panel = await mount(story(), full, { n: 4 });
  try {
    shots.push(`### with a link\n${banner()}`);
  } finally {
    panel.done();
  }
  const noUrl = story();
  noUrl.pr = { ...noUrl.pr, url: undefined } as never;
  const bare = await mount(noUrl, full, { n: 4 });
  try {
    shots.push(`### without a url\n${banner()}`);
  } finally {
    bare.done();
  }
  const saved = globalThis.location;
  Object.assign(globalThis, {
    location: Object.assign(
      new URL(
        `https://github.com/acme/widgets/pull/7/changes/${'a'.repeat(40)}..${'b'.repeat(40)}`,
      ),
      { replace() {} },
    ),
  });
  const here = await mount(story(), full, { n: 4 });
  try {
    shots.push(`### on the range\n${banner()}`);
  } finally {
    here.done();
    Object.assign(globalThis, { location: saved });
  }
  check('since-banner', shots.join('\n'));
});

await test('the rebuild line says where the rebuild stands, and goes after half an hour', async () => {
  const shots: string[] = [];
  const done = (extra: Record<string, unknown>) => ({
    mode: 'rebuild',
    state: 'done',
    requested_at: '2026-11-03T11:00:00Z',
    ...extra,
  });
  const rebuilds: [string, Record<string, unknown> | null][] = [
    ['none', null],
    ['queued', { mode: 'rebuild', state: 'queued', requested_at: REQUEST_AT }],
    [
      'queued from chapter 3',
      { mode: 'rebuild_from', from_step: 3, state: 'queued', requested_at: REQUEST_AT },
    ],
    [
      'building',
      { mode: 'rebuild', state: 'building', requested_at: REQUEST_AT, claimed_by: 'author-1' },
    ],
    ['done', done({ done_at: '2026-11-03T11:50:00Z', note: 'Kept 3 drafts.' })],
    ['failed', done({ state: 'failed', done_at: '2026-11-03T11:50:00Z', note: 'no diff' })],
    ['done long ago', done({ done_at: '2026-11-03T11:20:00Z' })],
  ];
  for (const [name, rebuild] of rebuilds) {
    const panel = await mount(story(), pulseOptions({ rebuild }), { n: 1 });
    try {
      await settle();
      shots.push(
        `### ${name}\n${serialize($('.ou-rebuilding')).join('\n')}\n${serialize($('.ou-rebuild-box')).join('\n')}`,
      );
    } finally {
      panel.done();
    }
  }
  check('rebuild-states', shots.join('\n'));
});

await test('flow-rebuild-form: the form on each step, its text kept, Cancel, a failure keeps the form, and what it sends', async () => {
  let fail = false;
  const panel = await mount(
    story(),
    (calls) =>
      fullOptions(calls, {
        pulse: undefined,
        requestRebuild: async (ask) => {
          calls.push(['requestRebuild', { ...ask, requested_at: 'T' }]);
          if (fail) {
            throw new Error('queue full');
          }
          return { rebuild: { mode: ask.mode, state: 'queued', requested_at: REQUEST_AT } };
        },
      }),
    { n: 0 },
  );
  try {
    const shots: string[] = [];
    const shot = (label: string) =>
      shots.push(
        `### ${label}\n${serialize($('.ou-rebuild-box')).join('\n')}\n${$('.ou-msg').textContent}`,
      );
    const form = () => maybe('.ou-rebuild-form');
    const area = () => $<HTMLTextAreaElement>('.ou-rebuild-form textarea');
    const asks = () => calling(panel.calls, 'requestRebuild');
    shot('overview');
    focusLog.length = 0;
    fire($('.ou-rebuild-open'), 'click');
    assert.ok(form(), 'the form opens at once');
    assert.ok(focusedNow() === area(), 'with the box focused');
    shot('overview form');
    area().value = 'Tell it differently';
    fire(area(), 'input');
    panel.overlay.apply();
    assert.equal(area().value, 'Tell it differently', 'a redraw keeps the text');
    panel.overlay.go(2);
    assert.ok(form() === null, 'a step change closes the form');
    fire($('.ou-rebuild-open'), 'click');
    assert.equal(area().value, 'Tell it differently', 'and keeps what was typed');
    shot('chapter 2 form');
    fire($('[data-rebuild-cancel]'), 'click');
    assert.ok(form() === null);
    fire($('.ou-rebuild-open'), 'click');
    fail = true;
    fire($('.ou-rebuild-form'), 'submit');
    assert.equal(
      $<HTMLButtonElement>('.ou-rebuild-form button[type="submit"]').disabled,
      true,
      'off while it goes',
    );
    await settle();
    assert.ok(form(), 'a failure keeps the form');
    assert.equal(area().value, 'Tell it differently');
    assert.equal($('.ou-msg').textContent, "Couldn't ask for a rebuild: queue full");
    assert.equal(asks().length, 1);
    shot('failed');
    fail = false;
    fire($('.ou-rebuild-form'), 'submit');
    await settle();
    assert.ok(form() === null, 'a success closes it');
    assert.equal($<HTMLButtonElement>('.ou-rebuild-open').textContent, 'Rebuild queued');
    assert.equal($<HTMLButtonElement>('.ou-rebuild-open').disabled, true);
    assert.deepEqual(
      asks().map((call) => call[1]),
      [
        { mode: 'rebuild_from', from_step: 2, guidance: 'Tell it differently', requested_at: 'T' },
        { mode: 'rebuild_from', from_step: 2, guidance: 'Tell it differently', requested_at: 'T' },
      ],
    );
    shot('asked');
    check('flow-rebuild-form', shots.join('\n'));
    stays(panel, 'rebuild form');
  } finally {
    panel.done();
  }
  const withoutAsk = await mount(
    story(),
    (calls) => ({ ...fullOptions(calls), requestRebuild: undefined }),
    { n: 1 },
  );
  try {
    assert.ok(maybe('.ou-rebuild-open') === null, 'no requestRebuild, no box');
  } finally {
    withoutAsk.done();
  }
  const auto = story();
  auto.chapters[1] = { ...auto.chapters[1], auto: true } as never;
  const autoPanel = await mount(auto, full, { n: 2 });
  try {
    assert.ok(maybe('.ou-rebuild-open') === null, 'an automatic chapter has no box');
  } finally {
    autoPanel.done();
  }
});

await test('the body’s slots keep their nodes through a redraw, and a step change draws new ones', async () => {
  const panel = await mount(story(), full, { n: 2 });
  try {
    const slots = [
      '.ou-working',
      '.ou-fixes',
      '.ou-rebuild-box',
      '.ou-drafts',
      '.ou-comment[data-i="0"]',
    ];
    const before = slots.map((selector) => $(selector));
    panel.overlay.apply();
    await panel.overlay.refreshFixes();
    slots.forEach((selector, i) => assert.ok($(selector) === before[i], `${selector} stays`));
    panel.overlay.go(1);
    panel.overlay.go(2);
    slots.forEach((selector, i) => assert.ok($(selector) !== before[i], `${selector} is new`));
  } finally {
    panel.done();
  }
});

// ---------- behavior that is new in this change (not pinned against the string panel: it did these differently)

await test('Edit on a second note while one is being edited opens that note’s own text and takes focus (the string panel carried the first’s text over)', async () => {
  const current = { view: structuredClone(FIXES) };
  const panel = await mount(story(), fixesOptions(current), { n: 0 });
  try {
    fire(fixButton('edit', 'n1'), 'click');
    editor().value = 'typed in the first';
    focusLog.length = 0;
    fire(fixButton('edit', 'n4'), 'click');
    assert.equal(all('.ou-fixedit').length, 1, 'one editor');
    assert.equal(editor().value, 'Came back', 'the second note’s own text');
    assert.ok(focusedNow() === editor(), 'and it takes focus');
    assert.ok(maybe('[data-note-id="n1"] .ou-fixedit') === null, 'the first note is back to text');
    assert.equal(maybe('[data-note-id="n1"] pre')?.textContent, 'Rename it');
  } finally {
    panel.done();
  }
});

await test('a failed Auto-send shows the bridge’s state again: the box un-ticks (the string panel kept the stale tick)', async () => {
  const current = { view: structuredClone(FIXES) };
  const gate = deferred<FixesView>();
  const panel = await mount(
    story(),
    fixesOptions(current, () => gate.promise),
    { n: 0 },
  );
  try {
    const box = () => $<HTMLInputElement>('.ou-fixauto input');
    box().checked = true;
    fire(box(), 'click');
    assert.equal(ticked(box()), true, 'ticked while the request is out');
    gate.promise.catch(() => {});
    gate.resolve(Promise.reject(new Error('boom')) as never);
    await settle();
    assert.equal($('.ou-msg').textContent, "Couldn't save that: boom");
    assert.equal(ticked(box()), false, 'un-ticked once it failed');
    assert.equal(isOff(box()), false);
  } finally {
    panel.done();
  }
});

await test('the body has no delegated click handler: every control and link has its own', async () => {
  const listening: [Element, string][] = [];
  const proto = window.HTMLElement.prototype;
  const add = proto.addEventListener;
  proto.addEventListener = function (this: HTMLElement, type: string, ...rest: never[]) {
    listening.push([this, type]);
    return (add as (...args: unknown[]) => void).call(this, type, ...rest);
  } as never;
  const panel = await mount(story(), full, { n: 2, chatOpen: true });
  try {
    panel.overlay.go(0);
    panel.overlay.go(1);
    const body = $('.ou-body');
    assert.deepEqual(
      listening.filter(
        ([el, type]) => (el === body || body.contains(el)) && type === 'click' && el === body,
      ),
      [],
      'nothing listens for clicks on the body itself',
    );
    assert.ok(
      listening.filter(([el, type]) => body.contains(el) && type === 'click').length > 20,
      'the elements in it listen for their own',
    );
  } finally {
    proto.addEventListener = add;
    panel.done();
  }
});

/** Every setTimeout the panel sets while this is on: its delay and whether it is still to run. */
function trackTimers() {
  const live = new Map<unknown, number>();
  const made: number[] = [];
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, millis: number, ...rest: unknown[]) => {
    const handle: unknown = set(() => {
      live.delete(handle);
      callback(...(rest as []));
    }, millis);
    live.set(handle, millis);
    made.push(millis);
    return handle;
  }) as never;
  globalThis.clearTimeout = ((handle: never) => {
    live.delete(handle);
    clear(handle);
  }) as never;
  return {
    made,
    pending: (millis: number) => [...live.values()].filter((one) => one === millis).length,
    stop() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}
const COPY_MS = 1500;
const MESSAGE_MS = 8000;

await test('closing the panel stops the copy labels’ timers, and answers that come after it set no timer and call nothing', async () => {
  startClock();
  const timers = trackTimers();
  clipboardEnv.mode = 'ok';
  const gate = deferred<DraftsAnswer>();
  const panel = await mount(
    story(),
    draftOptions(
      () => [],
      () => gate.promise,
      {
        requestRebuild: async () => {
          throw new Error('late');
        },
      },
    ),
    { n: 2 },
    { wait: pumpOnce },
  );
  try {
    const before = timers.pending(COPY_MS);
    fire($('.ou-comment[data-i="3"] .ou-copy'), 'click');
    await pump(100);
    assert.equal(timers.pending(COPY_MS), before + 1, 'the label goes back on a timer');
    // a clipboard answer, an Add, and a rebuild that are all still out when the panel closes
    let release!: () => void;
    clipboardEnv.gate = new Promise((resolve) => (release = resolve));
    fire($('.ou-comment[data-i="0"] .ou-copy'), 'click');
    fire(draftButton(2, 0, 'review'), 'click');
    fire($('.ou-rebuild-open'), 'click');
    fire($('.ou-rebuild-form'), 'submit');
    const acts = calling(panel.calls, 'drafts.act').length;
    const made = timers.made.length;
    panel.overlay.destroy();
    assert.equal(timers.pending(COPY_MS), before, 'closing clears the label timer');
    release();
    gate.resolve({
      drafts: [
        {
          chapter: 2,
          index: 0,
          status: 'pending',
          dismissed: false,
          added: { at: GITHUB_AT, url: 'u' },
        } as never,
      ],
      error: null,
      added: { at: GITHUB_AT, url: 'u', started: true },
    } as never);
    await pump(10000, 500);
    assert.equal(timers.made.length, made, 'no timer is set after closing');
    assert.equal(timers.pending(MESSAGE_MS), 0);
    assert.equal(
      calling(panel.calls, 'drafts.act').length,
      acts,
      'and nothing else is asked of the bridge',
    );
  } finally {
    clipboardEnv.gate = null;
    timers.stop();
    panel.done();
    stopClock();
  }
});

void window;
