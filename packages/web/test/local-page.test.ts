import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askedOn,
  document,
  file,
  fire,
  held,
  mountApp,
  refuse,
  reply,
  requests,
  settle,
  store,
  story,
  window,
} from './local-env.ts';

const alerts: string[] = [];
const scrolls: unknown[] = [];
Object.assign(globalThis, {
  alert: (message: string) => alerts.push(message),
  CSS: { escape: (text: string) => text },
});
Object.assign(window, { scrollTo: (top: unknown) => scrolls.push(top), scrollY: 0 });
Object.assign(globalThis, { window });

const { page } = await import('../public/local/page.ts');
// `hidden` is set so that a redraw does not mount the real panel again (mount.ts); the bridge says the usage capture is off, so the counter's timer doesn't keep the process up
reply('POST usage', { on: false });
reply('GET version', () => ({
  version: (store.get().story as { version?: string } | null)?.version,
})); // the closed panel's poll finds nothing new
const { usage } = await import('../public/local/page.ts');
test.after(() => usage.flush());
const { reveal, narrow, unnarrow, setNotes } = await import('../public/local/actions.ts');

const fileA = () => file('a.ts', [' one', '-two', '+TWO', ' four']);
const fileB = () => file('b.ts', [' x', '+y']);
let app: Awaited<ReturnType<typeof mountApp>> | null = null;
let refreshes = 0;

async function open(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  page.overlay = { sendFixes: async () => {}, refreshFixes: () => void refreshes++ } as never;
  app = await mountApp(
    { files: [fileA(), fileB()], ...over },
    { panelOpen: true, hidden: true, ...state },
  );
  await settle();
  return app.host;
}
const all = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];
const one = (selector: string) => document.querySelector(selector) as HTMLElement;
const section = (rel: string) => one(`.ou-local-file[data-path="${rel}"]`);
const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  at: '2026-11-05T10:00:00Z',
  path: 'a.ts',
  side: 'R',
  line: 2,
  body: `body ${id}`,
  ...over,
});
const cell = (rel: string, side: string, line: number) =>
  one(
    `.ou-local-file[data-path="${rel}"] td.ou-local-num[data-side="${side}"][data-line="${line}"]`,
  );

test.beforeEach(() => {
  requests.length = 0;
  alerts.length = 0;
  scrolls.length = 0;
  refreshes = 0;
  store.set({ folds: {}, step: null, opened: {}, editors: [], pendingScroll: null });
});
test.afterEach(() => {
  app?.unmount();
  app = null;
});

test('the page keeps the DOM the panel reads: a region for each file, a tree, line anchors and the Viewed buttons', async () => {
  await open();
  assert.deepEqual(
    all('[role=region][id^="diff-"]').map((el) => el.getAttribute('data-path')),
    ['a.ts', 'b.ts'],
  );
  assert.equal(all('[role=tree] .ou-local-tree-file').length, 2);
  assert.equal(
    section('a.ts').querySelectorAll('td[data-line-anchor]').length,
    6,
    'a context line has two numbers, a removed or added one has one',
  );
  assert.equal(
    cell('a.ts', 'R', 2).getAttribute('data-line-anchor'),
    'diff-sha-a-tsR2',
    'the anchor is the file’s id and the side and number',
  );
  assert.equal(
    section('a.ts').querySelector('.ou-local-viewed')!.getAttribute('aria-pressed'),
    'false',
  );
});

test('Viewed folds the file, drops "changed since viewed", tells the bridge, and a second click undoes it', async () => {
  await open({ files: [file('a.ts', [' one'], { viewed_changed: true })] });
  assert.ok(one('.ou-local-changed'));
  const button = () => section('a.ts').querySelector('.ou-local-viewed') as HTMLElement;
  button().click();
  await settle();
  assert.equal(button().getAttribute('aria-pressed'), 'true');
  assert.ok(section('a.ts').classList.contains('ou-local-folded'));
  assert.equal(
    section('a.ts').querySelector('.ou-local-fold')!.getAttribute('aria-expanded'),
    'false',
  );
  assert.ok(one('.ou-local-changed') === null);
  assert.deepEqual(askedOn('POST viewed')[0].body, { path: 'a.ts', viewed: true });
  button().click();
  await settle();
  assert.equal(button().getAttribute('aria-pressed'), 'false');
  assert.ok(!section('a.ts').classList.contains('ou-local-folded'));
  assert.deepEqual(askedOn('POST viewed')[1].body, { path: 'a.ts', viewed: false });
});

test('a Viewed that the bridge refuses says so and stays marked', async () => {
  reply('POST viewed', refuse('disk full'));
  await open();
  (section('a.ts').querySelector('.ou-local-viewed') as HTMLElement).click();
  await settle();
  assert.deepEqual(alerts, ["Couldn't save: disk full"]);
  assert.equal(
    section('a.ts').querySelector('.ou-local-viewed')!.getAttribute('aria-pressed'),
    'true',
  );
});

test('the fold button folds and unfolds a file by hand', async () => {
  await open();
  const fold = section('a.ts').querySelector('.ou-local-fold') as HTMLElement;
  fold.click();
  await settle();
  assert.ok(section('a.ts').classList.contains('ou-local-folded'));
  assert.equal(
    section('a.ts').querySelector('.ou-local-fold')!.getAttribute('aria-expanded'),
    'false',
  );
  (section('a.ts').querySelector('.ou-local-fold') as HTMLElement).click();
  await settle();
  assert.ok(!section('a.ts').classList.contains('ou-local-folded'));
  assert.equal(askedOn('POST viewed').length, 0, 'folding is not Viewed');
});

test('a click on a file in the tree scrolls to it', async () => {
  await open();
  one('[data-goto="b.ts"]').click();
  assert.equal(scrolls.length, 1);
});

test('Split asks the bridge to save the view, reads the story again and draws the split table', async () => {
  await open();
  const asked: string[] = [];
  reply('POST prefs', () => void asked.push('prefs'));
  reply('GET /api/stories/story-1', () => story({ files: [fileA(), fileB()], diff_view: 'split' }));
  const buttons = all('[data-diff-view]');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  buttons[1].click();
  await settle();
  assert.deepEqual(askedOn('POST prefs')[0].body, { diffView: 'split' });
  assert.ok(one('table.ou-local-split'));
  assert.equal(all('[data-diff-view]')[1].getAttribute('aria-pressed'), 'true');
  assert.ok(store.get().generation >= 1, 'the panel is mounted again on the new DOM');
});

test('Hide whitespace is off while it is saved, and the page is drawn again with the new story', async () => {
  await open();
  const wait = held();
  reply('POST prefs', wait.answer);
  reply('GET /api/stories/story-1', () => story({ files: [fileA()], hide_whitespace: true }));
  const box = () => one('.ou-local-ws-toggle') as HTMLInputElement;
  box().checked = true;
  fire(box(), 'change');
  await settle();
  assert.ok(box().hasAttribute('disabled'));
  wait.release(() => ({}));
  await settle();
  assert.deepEqual(askedOn('POST prefs')[0].body, { hideWhitespace: true });
  assert.ok(!box().hasAttribute('disabled'));
  assert.equal(all('.ou-local-file').length, 1);
});

test('a preference the bridge refuses says so, and the box comes back on', async () => {
  await open();
  reply('POST prefs', refuse('nope'));
  const box = () => one('.ou-local-ws-toggle') as HTMLInputElement;
  box().checked = true;
  fire(box(), 'change');
  await settle();
  assert.deepEqual(alerts, ["Couldn't change Hide whitespace: nope"]);
  assert.ok(!box().hasAttribute('disabled'));
  assert.equal(box().checked, false, 'it shows what the story says again');
});

test('a line number opens the note form under its line, and a second click only focuses it', async () => {
  await open();
  cell('a.ts', 'R', 2).click();
  await settle();
  const forms = () => all('.ou-local-note-form');
  assert.equal(forms().length, 1);
  assert.ok(document.activeElement === forms()[0].querySelector('textarea'), 'focused');
  assert.equal(
    cell('a.ts', 'R', 2).closest('tr')!.nextElementSibling!.className,
    'ou-local-note-edit',
  );
  forms()[0].querySelector('textarea')!.blur();
  cell('a.ts', 'R', 2).click();
  await settle();
  assert.equal(forms().length, 1);
  assert.ok(document.activeElement === forms()[0].querySelector('textarea'), 'focused');
});

test('Add note saves it under its line, counts it, tells the panel and closes the form; an empty note does nothing', async () => {
  await open();
  reply('POST notes', () => note('n1', { body: 'fix this' }));
  cell('a.ts', 'R', 2).click();
  await settle();
  const form = one('.ou-local-note-form') as HTMLFormElement;
  fire(form, 'submit');
  await settle();
  assert.equal(askedOn('POST notes').length, 0, 'empty: nothing asked');
  assert.ok(one('.ou-local-note-form'), 'and the form stays');
  (form.querySelector('textarea') as HTMLTextAreaElement).value = '  fix this ';
  fire(form, 'submit');
  await settle();
  assert.deepEqual(askedOn('POST notes')[0].body, {
    path: 'a.ts',
    side: 'R',
    line: 2,
    body: 'fix this',
  });
  assert.ok(one('.ou-local-note-form') === null);
  const row = one('.ou-local-note-row');
  assert.ok(row.previousElementSibling === cell('a.ts', 'R', 2).closest('tr'), 'under its line');
  assert.match(row.textContent!, /fix this/);
  assert.equal(one('.ou-local-notes-toggle').textContent, 'Fix before push: 1 to send');
  assert.equal(refreshes, 1);
  assert.equal(one('.ou-local-send').textContent, 'Send 1 note');
});

test('a note the bridge refuses says so and keeps the form', async () => {
  await open();
  reply('POST notes', refuse('no'));
  cell('a.ts', 'R', 2).click();
  await settle();
  const form = one('.ou-local-note-form') as HTMLFormElement;
  (form.querySelector('textarea') as HTMLTextAreaElement).value = 'x';
  fire(form, 'submit');
  await settle();
  assert.deepEqual(alerts, ["Couldn't save the note: no"]);
  assert.ok(one('.ou-local-note-form'));
});

test('Cmd+Enter in the form sends it, and Cancel takes it away', async () => {
  await open();
  reply('POST notes', () => note('n1'));
  cell('a.ts', 'R', 2).click();
  await settle();
  const form = one('.ou-local-note-form') as HTMLFormElement;
  const text = form.querySelector('textarea') as HTMLTextAreaElement;
  text.value = 'go';
  fire(text, 'keydown', { key: 'Enter', metaKey: true });
  await settle();
  assert.equal(askedOn('POST notes').length, 1);
  cell('b.ts', 'R', 2).click();
  await settle();
  (one('[data-editor-cancel]') as HTMLElement).click();
  await settle();
  assert.ok(one('.ou-local-note-form') === null);
});

test('a note is checked done, deleted (unless it was sent), and its link unfolds the file and scrolls to it', async () => {
  await open({
    notes: [note('n1'), note('n2', { line: 3, sent: { request: 'r', to: 'x', at: 'y' } })],
  });
  assert.equal(all('.ou-local-note-row').length, 2);
  const rows = all('.ou-local-note-row');
  assert.ok(rows.some((row) => row.querySelector('[data-note-delete]')));
  assert.equal(all('.ou-local-note-row [data-note-delete]').length, 1, 'a sent note has no Delete');
  reply('POST notes/n1', () => note('n1', { done: true }));
  (rows[0].querySelector('[data-note-done]') as HTMLInputElement).checked = true;
  fire(rows[0].querySelector('[data-note-done]')!, 'change');
  await settle();
  assert.deepEqual(askedOn('POST notes/n1')[0].body, { done: true });
  assert.equal(one('.ou-local-notes-toggle').textContent, 'Fix before push: 1 sent');
  // its link in the list: the file unfolds and the page scrolls to the note
  section('a.ts').querySelector<HTMLElement>('.ou-local-fold')!.click();
  await settle();
  assert.ok(section('a.ts').classList.contains('ou-local-folded'));
  one('[data-note-goto="n1"]').click();
  await settle();
  assert.ok(!section('a.ts').classList.contains('ou-local-folded'));
  assert.ok(scrolls.length >= 1);
  one('.ou-local-note-row [data-note-delete]').click();
  await settle();
  assert.deepEqual(askedOn('POST notes/n1').at(-1)!.body, { delete: true });
  assert.equal(all('.ou-local-note-row').length, 1);
});

test('the notes list opens from the toggle', async () => {
  await open({ notes: [note('n1')] });
  const list = () => one('.ou-local-notes-list');
  assert.ok(list().hasAttribute('hidden'));
  one('.ou-local-notes-toggle').click();
  await settle();
  assert.ok(!list().hasAttribute('hidden'));
  assert.equal(one('.ou-local-notes-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(list().textContent!, /a\.ts:R2|a\.ts.*2/);
});

test('a note on a line this diff does not draw is under the first row and says so', async () => {
  await open({ notes: [note('n1', { line: 99 })] });
  const row = one('.ou-local-note-row');
  assert.match(row.textContent!, /on 99, a line this diff doesn't draw/);
  assert.equal(row.previousElementSibling!.className, 'ou-local-hunk');
});

const chapters = [
  { title: 'One', files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 1, end: 2 }] }] },
  { title: 'Two', files: [{ rel: 'a.ts', lines: [{ side: 'R', start: 3, end: 4 }] }] },
];
const wide = () => file('a.ts', [' a', ' b', ' c', ' d']);

test('the panel’s step folds the other chapters’ lines behind a row; Show opens it; the same step leaves it open', async () => {
  const withChapters = story({ files: [wide()] }) as { chapters: unknown };
  withChapters.chapters = chapters;
  page.overlay = { sendFixes: async () => {}, refreshFixes: () => {} } as never;
  app = await mountApp({ files: [wide()] }, { panelOpen: true, hidden: true });
  store.set({ story: { ...(store.get().story as object), chapters } as never });
  narrow({ n: 1, all: false });
  const hiddenRows = () => all('.ou-local-diff tr.ou-local-out').length;
  assert.equal(hiddenRows(), 2);
  const fold = one('tr.ou-local-narrow');
  assert.match(fold.textContent!, /⋯ 2 lines/);
  fold.querySelector<HTMLElement>('[data-narrow-open]')!.click();
  await settle();
  assert.equal(hiddenRows(), 0);
  assert.ok(one('tr.ou-local-narrow') === null);
  narrow({ n: 1, all: false });
  assert.equal(hiddenRows(), 0, 'the same step does not close what was opened');
  narrow({ n: 2, all: false });
  assert.equal(hiddenRows(), 2, 'a new step folds again');
  unnarrow();
  assert.equal(hiddenRows(), 0);
  assert.ok(one('tr.ou-local-narrow') === null);
});

test('reveal unfolds the file and the fold that holds a line before it returns, so the panel can scroll to it', async () => {
  page.overlay = { sendFixes: async () => {}, refreshFixes: () => {} } as never;
  app = await mountApp({ files: [wide()] }, { panelOpen: true, hidden: true });
  store.set({
    story: { ...(store.get().story as object), chapters } as never,
    folds: { 'a.ts': true },
  });
  narrow({ n: 1, all: false });
  const row = () => cell('a.ts', 'R', 4).closest('tr') as HTMLElement;
  assert.ok(row().classList.contains('ou-local-out'));
  assert.ok(section('a.ts').classList.contains('ou-local-folded'));
  reveal('a.ts', 'R', 4, 4);
  assert.ok(!row().classList.contains('ou-local-out'), 'drawn on return');
  assert.ok(!section('a.ts').classList.contains('ou-local-folded'));
});

test('the panel’s notes replace the diff’s, and a panel mark on a file or a tree row survives a redraw', async () => {
  await open();
  const wrap = section('a.ts').parentElement!;
  wrap.setAttribute('data-ou-hidden', '');
  wrap.setAttribute('hidden', '');
  const treeRow = one('[data-goto="a.ts"]');
  treeRow.setAttribute('hidden', '');
  setNotes([note('n9') as never]);
  store.flush();
  assert.equal(all('.ou-local-note-row').length, 1);
  assert.ok(
    section('a.ts').parentElement === wrap &&
      wrap.hasAttribute('data-ou-hidden') &&
      wrap.hasAttribute('hidden'),
  );
  assert.ok(one('[data-goto="a.ts"]') === treeRow && treeRow.hasAttribute('hidden'));
});

test('the moved-branch notice and the range show in the header', async () => {
  await open({ moved: { head_oid: 'c'.repeat(40), base_oid: null } });
  assert.match(
    one('.ou-local-top-main').textContent!,
    /acme\/widgets · main aaaaaaaaa → work bbbbbbbbb/,
  );
  assert.match(one('.ou-local-moved').textContent!, /Branch moved since this story was told/);
  // the browser test's pixel shot swaps the repo's folder in the first text node of this line
  const line = one('.ou-local-top-main > .ou-local-muted');
  assert.equal((line.firstChild as unknown as { data: string }).data, 'acme/widgets · ');
});

test('after the story is read again the page keeps its files’ nodes, and does not redraw under a note being written', async () => {
  await open();
  const before = section('a.ts');
  const gen = store.get().generation;
  const { reloadIfChanged } = await import('../public/local/actions.ts');
  cell('a.ts', 'R', 2).click();
  await settle();
  reply('GET /api/stories/story-1', () =>
    story({ files: [fileA(), fileB()], notes: [note('n1')] }),
  );
  await reloadIfChanged('v2');
  assert.equal(store.get().generation, gen, 'a note is being written: left alone');
  const { closeEditor } = await import('../public/local/actions.ts');
  closeEditor(store.get().editors[0].key);
  await reloadIfChanged('v2');
  await settle();
  assert.equal(store.get().generation, gen + 1);
  assert.ok(section('a.ts') === before, 'the same node');
  assert.equal(all('.ou-local-note-row').length, 1);
});

test('a panel jump that opens nothing changes nothing, so the tables are not drawn again', async () => {
  page.overlay = { sendFixes: async () => {}, refreshFixes: () => {} } as never;
  app = await mountApp({ files: [wide()] }, { panelOpen: true, hidden: true });
  const before = store.get();
  reveal('a.ts', 'R', 2, 2);
  assert.ok(store.get() === before, 'no step, nothing folded: the state is the same object');
  store.set({ story: { ...(store.get().story as object), chapters } as never });
  narrow({ n: 1, all: false });
  const narrowed = store.get();
  reveal('a.ts', 'R', 1, 2); // lines the chapter tells: already shown
  assert.ok(store.get() === narrowed);
  reveal('a.ts', 'R', 3, 3); // a folded line: opens it
  assert.ok(store.get() !== narrowed);
  const opened = store.get();
  reveal('a.ts', 'R', 3, 4);
  assert.ok(store.get() === opened, 'opened already: nothing more');
});
