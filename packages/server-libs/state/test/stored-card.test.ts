/*
 * ADR-29, branch A: the stored card record. `link` writes a fact onto a card, `ensureCard` is the one place a card is found or made
 * (under the file's lock), a row with no `source` is a backlog card, and `listed()` is what the lists and the board see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { BacklogStore, cardLookup, foldBacklog } from '../src/queues/backlog/backlog.ts';
import { ensureCard } from '../src/queues/backlog/ensure.ts';

const REPO = 'acme/widgets';

test('link sets branch, worktree, pr and story and leaves the state, start time and landing alone', () => {
  const store = new BacklogStore(tmp('link-sets'));
  const card = store.add({ title: 'work', repo: REPO });
  const started = store.start(card.id, { branch: 'feat-a', repo: REPO });
  const linked = store.link(card.id, {
    worktree: '/work/feat-a',
    pr: 12,
    story: 'acme-widgets-12',
    session: 'session-1',
    by: 'test',
  });
  assert.equal(linked.worktree, '/work/feat-a');
  assert.equal(linked.pr, 12);
  assert.equal(linked.story, 'acme-widgets-12');
  assert.equal(linked.session, 'session-1');
  assert.equal(linked.branch, 'feat-a');
  assert.equal(linked.state, 'started');
  assert.equal(linked.started_at, started.started_at);
  assert.equal(linked.landed_at, null);
  // a repeat of what the card has writes nothing
  store.link(card.id, { worktree: '/work/feat-a', pr: 12 });
  assert.equal(rowsOf(store.file).filter((row) => row.op === 'link').length, 1);
});

/** The rows of a backlog file, as written. */
const rowsOf = (file: string): Array<{ op: string }> =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test('link on a dropped or a landed card changes nothing', () => {
  const store = new BacklogStore(tmp('link-closed'));
  const dropped = store.add({ title: 'dropped', repo: REPO });
  store.drop(dropped.id);
  const landed = store.add({ title: 'landed', repo: REPO });
  store.done(landed.id);
  assert.equal(store.link(dropped.id, { pr: 3, branch: 'x' }).pr, null);
  assert.equal(store.link(landed.id, { pr: 4, branch: 'y' }).pr, null);
  assert.equal(rowsOf(store.file).filter((row) => row.op === 'link').length, 0);
});

test('a link that gives nothing new writes no row, and a bad value is refused', () => {
  const store = new BacklogStore(tmp('link-refuse'));
  const card = store.add({ title: 'work', repo: REPO });
  store.link(card.id, {});
  assert.throws(() => store.link(card.id, { worktree: 'relative/path' }), /absolute/);
  assert.throws(() => store.link(card.id, { story: 'bad story id' }), /story/);
  assert.equal(rowsOf(store.file).length, 1);
});

test('ensureCard: one id for the same explicit id, PR, branch and session; main and no branch name no work', () => {
  const store = new BacklogStore(tmp('ensure-ids'));
  const first = ensureCard(store, {
    id: 'ic_aaaaaa1111',
    source: 'agent',
    title: 'an agent',
    repo: REPO,
    branch: 'feat-a',
  });
  assert.equal(first.made, true);
  assert.equal(first.item.id, 'ic_aaaaaa1111');
  assert.equal(first.item.source, 'agent');
  // the explicit id, again: the same card, and it gets the worktree it lacked
  const again = ensureCard(store, {
    id: 'ic_aaaaaa1111',
    source: 'agent',
    title: 'an agent',
    worktree: '/work/a',
  });
  assert.equal(again.made, false);
  assert.equal(again.item.worktree, '/work/a');
  // the branch, the PR number
  const byBranch = ensureCard(store, {
    source: 'pr',
    title: 'a PR',
    repo: REPO,
    branch: 'feat-a',
    pr: 9,
  });
  assert.equal(byBranch.item.id, 'ic_aaaaaa1111');
  assert.equal(byBranch.item.pr, 9);
  const byPr = ensureCard(store, { source: 'pr', title: 'a PR', repo: REPO, pr: 9 });
  assert.equal(byPr.item.id, 'ic_aaaaaa1111');
  // the same PR number in another repo is another card
  const other = ensureCard(store, { source: 'pr', title: 'a PR', repo: 'acme/other', pr: 9 });
  assert.equal(other.made, true);
  // a session's card
  const session = ensureCard(store, { source: 'session', title: 'a session', session: 'sess-1' });
  assert.equal(session.made, true);
  assert.equal(
    ensureCard(store, { source: 'session', title: 'a session', session: 'sess-1' }).item.id,
    session.item.id,
  );
  assert.notEqual(
    ensureCard(store, { source: 'session', title: 'a session', session: 'sess-2' }).item.id,
    session.item.id,
  );
  // main and no branch name no work: two cards, each with no branch
  const onMain = ensureCard(store, {
    source: 'session',
    title: 'on main',
    repo: REPO,
    branch: 'main',
  });
  assert.equal(onMain.made, true);
  assert.equal(onMain.item.branch, null);
  const detached = ensureCard(store, { source: 'session', title: 'detached', repo: REPO });
  assert.equal(detached.made, true);
  assert.notEqual(detached.item.id, onMain.item.id);
  // a card that landed is not found again
  const landed = ensureCard(store, {
    source: 'agent',
    title: 'old',
    repo: REPO,
    branch: 'feat-old',
  });
  store.done(landed.item.id);
  assert.equal(
    ensureCard(store, { source: 'agent', title: 'new', repo: REPO, branch: 'feat-old' }).made,
    true,
  );
});

test('ensureCard with joinBranch and an id no card has joins the open card on that repo and branch, and adds nothing', () => {
  const store = new BacklogStore(tmp('ensure-join'));
  const base = { source: 'agent' as const, title: 'again', repo: REPO, joinBranch: true };
  const first = ensureCard(store, { ...base, id: 'ic_aaaaaa1111', branch: 'feat-a' });
  assert.equal(first.made, true);
  assert.equal(first.joined, false);
  // a second start on the branch, with its own minted id, is on the first card
  const second = ensureCard(store, { ...base, id: 'ic_bbbbbb2222', branch: 'feat-a' });
  assert.equal(second.item.id, 'ic_aaaaaa1111');
  assert.equal(second.made, false);
  assert.equal(second.joined, true);
  assert.equal(store.items().length, 1);
  // without joinBranch it makes its own, as before
  const own = ensureCard(store, {
    source: 'agent',
    title: 'own',
    repo: REPO,
    branch: 'feat-a',
    id: 'ic_cccccc3333',
  });
  assert.equal(own.made, true);
  // no join on main, no branch, another repo, a landed card or a dropped one
  for (const input of [
    { branch: 'main' },
    { branch: null },
    { branch: 'feat-a', repo: 'acme/other' },
  ]) {
    assert.equal(
      ensureCard(store, { ...base, id: `ic_${Math.random().toString(36).slice(2, 12)}`, ...input })
        .made,
      true,
    );
  }
  const landed = ensureCard(store, { ...base, id: 'ic_dddddd4444', branch: 'feat-l' });
  store.done(landed.item.id);
  const dropped = ensureCard(store, { ...base, id: 'ic_eeeeee5555', branch: 'feat-d' });
  store.drop(dropped.item.id);
  assert.equal(ensureCard(store, { ...base, id: 'ic_ffffff6666', branch: 'feat-l' }).made, true);
  assert.equal(ensureCard(store, { ...base, id: 'ic_gggggg7777', branch: 'feat-d' }).made, true);
});

test('findCard on a branch with several open cards picks the one with a story, then a listed one, then the oldest', () => {
  const store = new BacklogStore(tmp('ensure-rank'));
  const old = ensureCard(store, { source: 'agent', title: 'old', repo: REPO, branch: 'feat-r' });
  const storied = ensureCard(store, {
    id: 'ic_hhhhhh8888',
    source: 'agent',
    title: 'storied',
    repo: REPO,
    branch: 'feat-r',
    story: 'acme-widgets-r',
  });
  assert.notEqual(old.item.id, storied.item.id);
  const pick = () =>
    ensureCard(store, { source: 'pr', title: 'x', repo: REPO, branch: 'feat-r' }).item.id;
  assert.equal(pick(), storied.item.id);
  // a listed card beats an unlisted one with no story, and the oldest of equals wins
  const listed = store.add({ title: 'listed', repo: REPO, branch: 'feat-s' });
  store.start(listed.id, { branch: 'feat-s', repo: REPO });
  const bare = ensureCard(store, {
    id: 'ic_iiiiii9999',
    source: 'agent',
    title: 'bare',
    repo: REPO,
    branch: 'feat-s',
  });
  assert.notEqual(bare.item.id, listed.id);
  assert.equal(
    ensureCard(store, { source: 'pr', title: 'x', repo: REPO, branch: 'feat-s' }).item.id,
    listed.id,
  );
});

test('a row with no source folds as a backlog card', () => {
  const rows = [
    { op: 'add', id: 'bl_old1111111', title: 'old row', by: 'cli', at: '2026-11-01T00:00:00.000Z' },
    {
      op: 'add',
      id: 'ic_agent111111',
      title: 'agent row',
      source: 'agent',
      by: 'x',
      at: '2026-11-01T00:00:00.000Z',
    },
  ];
  const [old, agent] = foldBacklog(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(old.source, 'backlog');
  assert.equal(agent.source, 'agent');
});

test('listed() drops every card another source made, and keeps one adopted into the backlog', () => {
  const store = new BacklogStore(tmp('listed'));
  const plain = store.add({ title: 'plain' });
  const made = ['agent', 'session', 'pr', 'story'].map(
    (source) => ensureCard(store, { source: source as 'agent', title: source }).item,
  );
  assert.deepEqual(
    store.listed().map((item) => item.id),
    [plain.id],
  );
  assert.equal(store.items().length, 5);
  store.link(made[0].id, { source: 'backlog' });
  assert.deepEqual(
    store.listed().map((item) => item.id),
    [plain.id, made[0].id],
  );
});

test('cardLookup answers for a stored agent card as it did for the implicit one: with its repo and branch', () => {
  const store = new BacklogStore(tmp('lookup'));
  ensureCard(store, {
    id: 'ic_aaaaaa1111',
    source: 'agent',
    title: 'x',
    repo: REPO,
    branch: 'feat-a',
  });
  const lookup = cardLookup(store);
  assert.deepEqual(lookup('ic_aaaaaa1111'), {
    id: 'ic_aaaaaa1111',
    closed: null,
    repo: REPO,
    branch: 'feat-a',
    worktree: null,
    agentMade: true,
  });
  assert.equal(lookup('ic_nothere1111'), null);
});

test('two processes asking for the card of one PR at once make one card', async () => {
  const home = tmp('ensure-race');
  const dir = tmp('ensure-race-child');
  const goFile = path.join(dir, 'go');
  const script = path.join(dir, 'child.ts');
  const src = (file: string) => JSON.stringify(path.resolve(import.meta.dirname, '../src', file));
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';
import { BacklogStore } from ${src('queues/backlog/backlog.ts')};
import { ensureCard } from ${src('queues/backlog/ensure.ts')};
const [go, home] = process.argv.slice(2);
process.stderr.write('ready\\n');
while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
process.stdout.write(ensureCard(new BacklogStore(home), { source: 'pr', title: 'a PR', repo: 'acme/widgets', pr: 5 }).item.id);
`,
  );
  let ready = 0;
  const procs = [1, 2, 3].map(() =>
    spawn(process.execPath, [script, goFile, home], { stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const timer = setTimeout(() => procs.forEach((child) => child.kill('SIGKILL')), 60_000);
  try {
    const ids = await Promise.all(
      procs.map(
        (child) =>
          new Promise<string>((resolve, reject) => {
            let out = '';
            child.stdout.on('data', (chunk) => (out += chunk));
            child.stderr.on('data', (chunk) => {
              if (String(chunk).includes('ready') && ++ready === procs.length) {
                writeFileSync(goFile, '');
              }
            });
            child.on('close', (code) =>
              code === 0 ? resolve(out) : reject(new Error(`child failed (${code})`)),
            );
          }),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    assert.equal(new BacklogStore(home).items().length, 1);
  } finally {
    clearTimeout(timer);
    procs.forEach((child) => child.kill());
  }
});

test('a done row with merged_at lands the card at that time', () => {
  const rows = [
    { op: 'add', id: 'bl_merged11111', title: 'merged', by: 'cli', at: '2026-11-01T00:00:00.000Z' },
    {
      op: 'done',
      id: 'bl_merged11111',
      merged_at: '2026-11-02T10:00:00.000Z',
      by: 'x',
      at: '2026-11-02T12:00:00.000Z',
    },
  ];
  const [item] = foldBacklog(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(item.landed_at, '2026-11-02T10:00:00.000Z');
});
