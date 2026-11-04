import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { PartsStrip } = await import('../src/parts-strip.ts');

const parts = {
  groups: ['Code', 'Docs', 'Misc'],
  parts: [
    { id: 'src', name: 'Source', group: 'Code', note: 'the app' },
    { id: 'lib', name: 'Library', group: 'Code' },
    { id: 'docs', name: 'Docs', group: 'Docs' },
    { id: 'ci', name: 'CI', group: 'Misc' },
  ],
  by_chapter: [['src']],
  files: { src: 3, docs: 1 },
};

const draw = async (view: Parameters<typeof render>[0]) => {
  render(view, root);
  await tick();
  return root;
};
const cells = () =>
  [...root.querySelectorAll('.ou-ui-part')].map((item) => ({
    on: item.classList.contains('ou-ui-part-on'),
    text: item.textContent!.replace(/\s+/g, ' ').trim(),
  }));

test('in a chapter, the touched parts are lit by a mark and in words, and groups with nothing lit fold into one line', async () => {
  await draw(html`<${PartsStrip} parts=${parts} touched=${['src']} />`);
  const strip = root.querySelector('.ou-ui-parts') as HTMLElement;
  assert.equal(strip.getAttribute('role'), 'group');
  assert.equal(strip.getAttribute('aria-label'), 'Parts this chapter touches');
  assert.deepEqual(cells(), [
    { on: true, text: '● Source touched' },
    { on: false, text: '○ Library' },
  ]);
  assert.equal(root.querySelector('.ou-ui-part-on')?.getAttribute('title'), 'the app');
  assert.equal(root.querySelectorAll('.ou-ui-parts-row').length, 1);
  assert.equal(root.querySelector('.ou-ui-parts-rest')?.textContent, 'Not touched: Docs, Misc');
  assert.equal(root.querySelector('.ou-ui-parts-group')?.textContent, 'Code');
});

test('the marks are hidden from a screen reader, and an unlit part says nothing more than its name', async () => {
  await draw(html`<${PartsStrip} parts=${parts} touched=${['src']} />`);
  const marks = [...root.querySelectorAll('.ou-ui-part > [aria-hidden="true"]')];
  assert.equal(marks.length, 2);
  assert.equal(root.querySelectorAll('.ou-ui-parts-sr').length, 1);
});

test('the Overview shows every group, with each lit part’s file count', async () => {
  await draw(
    html`<${PartsStrip} parts=${parts} touched=${['src', 'docs']} counts=${parts.files} />`,
  );
  assert.equal(
    root.querySelector('.ou-ui-parts')?.getAttribute('aria-label'),
    'Parts this story touches',
  );
  assert.equal(root.querySelectorAll('.ou-ui-parts-row').length, 3);
  assert.equal(root.querySelector('.ou-ui-parts-rest'), null);
  assert.deepEqual(
    cells().map((cell) => cell.text),
    ['● Source touched, 3 files 3', '○ Library', '● Docs touched, 1 file 1', '○ CI'],
  );
  assert.equal(root.querySelector('.ou-ui-part-on')?.getAttribute('title'), 'the app · 3 files');
});

test('a step that touches nothing draws no strip', async () => {
  await draw(html`<${PartsStrip} parts=${parts} touched=${[]} />`);
  assert.equal(root.querySelector('.ou-ui-parts'), null);
  assert.ok(document);
});
