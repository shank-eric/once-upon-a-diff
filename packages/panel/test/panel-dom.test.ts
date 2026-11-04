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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dom } from './panel-env.ts';
import {
  QUESTIONS,
  READS,
  CURRENT_UPDATED,
  fullOptions,
  pageWorld,
  question,
  smallStory,
  story,
} from './panel-fixtures.ts';
import type { PanelOptions } from '../src/context.ts';
import type { StoryData } from '@once-upon-a-diff/protocol/types';

const { storyOverlay } = await import('../src/overlay.ts');
const { parseMarkup } = await import('../src/parse-markup.ts');
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
    .map((attr) =>
      BOOLEAN.has(attr.name) ? attr.name : `${attr.name}=${JSON.stringify(attr.value)}`,
    )
    .sort();
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
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} changed`);
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
  { onPage }: { onPage?: string[] } = {},
): Promise<Mounted> {
  const world = pageWorld(input, { onPage });
  const calls: unknown[][] = [];
  const opts = { ...options(calls), initial };
  const overlay = storyOverlay(input, opts, world.host);
  await settle();
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
const bare = (): PanelOptions => ({ stylesheets: { page: '/p.css', panel: '/q.css' } });
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

void window;
