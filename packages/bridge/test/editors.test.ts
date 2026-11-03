/**
 * Editors and their authors: the board shows each editor (a session that registered with `agent start --kind editor`)
 * with the builders launched under its session, and says on each author which editor controls it. No overall agent
 * count: the header's builder chip is gone, and a slot is the editor's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { BacklogStore } from '../src/services/backlog/backlog.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import type { BoardAgent, BoardData } from '@once-upon-a-diff/protocol/types';

const EDITOR_SID = 'abcdef01';
const EDITOR_SESSION = `${EDITOR_SID}-1111-4222-8333-444444444444`;
const OTHER = '12345678';
const NOW = new Date('2026-11-03T20:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60000);

const EDITOR = {
  name: 'editor-widgets',
  sid: EDITOR_SID,
  session: EDITOR_SESSION,
  kind: 'editor',
  task: 'editor for widgets',
  repo: 'acme/widgets',
} as const;
const build = (name: string, sid = EDITOR_SID) =>
  ({ name, sid, kind: 'builder', task: `build ${name}` }) as const;

interface World {
  home: string;
  registry: AgentRegistry;
  /** the live-session file for a session id: the test process itself is the live pid */
  live: (session: string, name?: string, pid?: number) => void;
  snapshot: () => Promise<BoardData>;
  ledger: string;
}

/** A checkout of acme/widgets, where the editor's session works (so its lane is acme/widgets, as its registered repo says). */
function checkout(): string {
  const dir = tmp('editors-checkout');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  return dir;
}

function world(): World {
  const cwd = checkout();
  const home = tmp('editors-home');
  const sessions = tmp('editors-sessions');
  const ledger = path.join(tmp('editors-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_ledger_file: ledger,
    board_ledger_time_zone: 'UTC',
  });
  return {
    home,
    ledger,
    registry: new AgentRegistry(home),
    live: (session, name = 'the editor', pid = process.pid) =>
      writeJson(path.join(sessions, `${pid}.json`), {
        pid,
        sessionId: session,
        cwd,
        name,
        status: 'busy',
      }),
    snapshot: () =>
      new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => NOW,
      }).snapshot(),
  };
}

/** Every agent view on the board's cards, by name. */
const viewsOf = (data: BoardData): Map<string, BoardAgent> =>
  new Map(
    data.lanes
      .flatMap((lane) => lane.cards.flatMap((card) => card.agents))
      .map((one) => [one.name, one]),
  );

test('an editor shows with the authors it controls: running ones hold its slots, the other kinds and sessions are no authors', async () => {
  const { registry, live, snapshot, ledger, home } = world();
  registry.start({ ...EDITOR, slots: 3, at: ago(300) });
  live(EDITOR_SESSION);
  registry.start({ ...build('ou-a'), at: ago(60) });
  registry.beat('ou-a', { n: 3, of: 6, step: 'code', at: ago(5) });
  // at its plan: an author, but it holds no slot
  registry.start({ ...build('ou-b'), at: ago(50) });
  registry.state('ou-b', { state: 'plan', outcome: 'plan ready', at: ago(40) });
  // at a question, and parked on a story review: authors, holding no slot
  registry.start({ ...build('ou-q'), at: ago(45) });
  registry.state('ou-q', { state: 'waiting', outcome: 'which one?', at: ago(44) });
  registry.start({ ...build('ou-r'), at: ago(45) });
  registry.state('ou-r', { state: 'review', outcome: 'story abc', at: ago(44) });
  // a critic, a lookup, another session's builder and a finished one are no authors of this editor
  registry.start({
    name: 'review-x',
    sid: EDITOR_SID,
    kind: 'reviewer',
    task: 'review',
    at: ago(30),
  });
  registry.start({ name: 'look-x', sid: EDITOR_SID, kind: 'research', task: 'look', at: ago(30) });
  registry.start({ ...build('ou-f', OTHER), at: ago(30) });
  registry.start({ ...build('ou-done'), at: ago(25) });
  registry.finish('ou-done', { outcome: 'ok', result: { commit: 'abc1234' }, at: ago(20) });
  // a ledger agent has no kind: it is a builder by its claim, and its launching session is the ledger's sid
  writeFileSync(
    ledger,
    `- [running] sid:${EDITOR_SID} legacy-claimer (sonnet, high) — a card — started 2:50 PM ET, 11/3\n` +
      `- [running] sid:${EDITOR_SID} legacy-text (sonnet, high) — card bl_aaaaaa111, no claim — started 2:51 PM ET, 11/3\n`,
  );
  const store = new BacklogStore(home);
  store.claim(store.add({ title: 'A card' }).id, { agent: 'legacy-claimer', sid: EDITOR_SID });

  const data = await snapshot();
  assert.equal('builders' in data, false, 'no overall builder count');
  assert.equal(data.editors.length, 1);
  const [editor] = data.editors;
  assert.equal(editor.name, 'editor-widgets');
  assert.equal(editor.session, EDITOR_SESSION);
  assert.equal(editor.lane, 'acme/widgets');
  assert.equal(editor.label, 'widgets');
  assert.equal(editor.slots, 3);
  assert.deepEqual(editor.authors.map((one) => one.name).sort(), [
    'legacy-claimer',
    'ou-a',
    'ou-b',
    'ou-q',
    'ou-r',
  ]);
  assert.equal(
    editor.in_use,
    2,
    'running authors hold a slot; one at its plan, a question or a story review does not',
  );
  assert.deepEqual(editor.authors.find((one) => one.name === 'ou-a')?.beat, {
    n: 3,
    of: 6,
    step: 'code',
    note: '',
  });
  assert.equal(editor.authors.find((one) => one.name === 'ou-b')?.state, 'plan');
  // the editor is no agent: no card, and no agent anywhere on the board
  const views = viewsOf(data);
  assert.equal(views.has('editor-widgets'), false);
  assert.equal(
    data.lanes.some((lane) => lane.cards.some((card) => card.title === 'editor-widgets')),
    false,
  );
  // each author says which editor controls it (by its session); the others have none
  for (const name of ['ou-a', 'ou-b', 'ou-done', 'legacy-claimer']) {
    assert.equal(views.get(name)?.editor?.session, EDITOR_SESSION, name);
    assert.equal(views.get(name)?.editor?.label, 'widgets', name);
  }
  for (const name of ['review-x', 'look-x', 'ou-f', 'legacy-text']) {
    assert.equal(views.get(name)?.editor ?? null, null, name);
  }
  // an author's own card says "from Editor · widgets", as the voice session's says "Voice session"
  const card = data.lanes
    .flatMap((lane) => lane.cards)
    .find((one) => one.kind === 'agent' && one.title === 'ou-b');
  assert.equal(card?.parent, 'Editor · widgets');
  // and "from" brings the editor's registered session forward
  assert.equal(card?.focus_session, EDITOR_SESSION);
});

test('an editor is shown only while its registered session is live and its run is open; a restart in the session shows it once', async () => {
  const { registry, live, snapshot } = world();
  registry.start({ ...EDITOR, slots: 2, at: ago(300) });
  registry.start({ ...build('ou-a'), at: ago(60) });
  // no live session at all
  let data = await snapshot();
  assert.deepEqual(data.editors, []);
  assert.equal(viewsOf(data).get('ou-a')?.editor, null);
  // a session whose id only shares the editor's first 8 characters is not the editor's session
  live(`${EDITOR_SID}-9999-4999-8999-999999999999`);
  assert.deepEqual((await snapshot()).editors, []);
  live(EDITOR_SESSION);
  data = await snapshot();
  assert.equal(data.editors.length, 1);
  assert.equal(data.editors[0].slots, 2);
  // /once-upon-editor run again in the same session: one editor, the newer slots
  registry.start({ ...EDITOR, slots: 5, at: ago(10) });
  data = await snapshot();
  assert.equal(data.editors.length, 1);
  assert.equal(data.editors[0].slots, 5);
  assert.equal(data.editors[0].authors.length, 1);
  // told to stop: gone, and its authors say no editor
  registry.finish('editor-widgets', { state: 'stopped', at: ago(1) });
  data = await snapshot();
  assert.deepEqual(data.editors, []);
  assert.equal(viewsOf(data).get('ou-a')?.editor, null);
});

test('an editor with no --slots has three; slots are for an editor only, 1 to 99', () => {
  const { registry } = world();
  registry.start({ ...EDITOR, at: ago(5) });
  assert.equal(registry.agents().find((one) => one.name === 'editor-widgets')?.slots, 3);
  assert.throws(() => registry.start({ ...EDITOR, name: 'e0', slots: 0 }), /slots/);
  assert.throws(() => registry.start({ ...EDITOR, name: 'e100', slots: 100 }), /slots/);
  assert.throws(() => registry.start({ ...build('ou-a'), slots: 3 }), /slots/);
});

test('a silent author is no author: one with no event for a day is likely dead, a beat is a sign of life', async () => {
  const { registry, live, snapshot } = world();
  registry.start({ ...EDITOR, at: ago(3000) });
  live(EDITOR_SESSION);
  registry.start({ ...build('ou-silent'), at: ago(30 * 60) });
  registry.start({ ...build('ou-beating'), at: ago(31 * 60) });
  registry.beat('ou-beating', { n: 2, of: 6, step: 'read', at: ago(20 * 60) });
  const [editor] = (await snapshot()).editors;
  assert.deepEqual(
    editor.authors.map((one) => one.name),
    ['ou-beating'],
  );
});

test('a resumed builder for a fix round is an author again once the editor starts it again; its earlier run is kept', async () => {
  const home = tmp('editors-fix-home');
  const env = { CLAUDE_CODE_SESSION_ID: EDITOR_SESSION };
  const run = (...args: string[]) => runCli(home, ['agent', ...args], env);
  assert.equal(
    (
      await run(
        'start',
        'editor-widgets',
        '--kind',
        'editor',
        '--slots',
        '3',
        '--task',
        'editor',
        '--repo',
        'acme/widgets',
      )
    ).code,
    0,
  );
  assert.equal((await run('start', 'ou-a', '--kind', 'builder', '--task', 'build it')).code, 0);
  assert.equal((await run('finish', 'ou-a', '--state', 'done', '--outcome', 'built')).code, 0);
  // the builder is over: a fix round cannot be announced on it
  const refused = await run('state', 'ou-a', '--state', 'fixing');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no open run/);
  // the editor starts it again (same name, kind and session), and the fix round can be announced
  assert.equal((await run('start', 'ou-a', '--kind', 'builder', '--task', 'fix round')).code, 0);
  assert.equal((await run('state', 'ou-a', '--state', 'fixing', '--findings', '2')).code, 0);
  const registry = new AgentRegistry(home);
  const again = registry.agents().find((one) => one.name === 'ou-a');
  assert.equal(again?.state, 'fixing');
  assert.equal(again?.earlier?.length, 1);
  assert.equal(again?.earlier?.[0].state, 'done');
  // and the board counts it as an author, working on its fix round: it holds a slot
  const sessions = tmp('editors-fix-live');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: EDITOR_SESSION,
    cwd: '/work/widgets',
  });
  const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(),
  }).snapshot();
  assert.deepEqual(
    data.editors[0].authors.map((one) => [one.name, one.state]),
    [['ou-a', 'fixing']],
  );
  assert.equal(
    data.editors[0].in_use,
    1,
    'an author fixing findings is working: it holds its slot',
  );
});

test('an editor registers through the CLI without a ledger line (it is no agent), `agent list` shows it, --slots is refused for a builder', async () => {
  const home = tmp('editors-cli');
  const ledger = path.join(tmp('editors-cli-notes'), 'ledger.md');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_ledger_time_zone: 'UTC',
  });
  const run = (...args: string[]) => runCli(home, ['agent', ...args]);
  const started = await run(
    'start',
    'editor-widgets',
    '--kind',
    'editor',
    '--slots',
    '4',
    '--sid',
    EDITOR_SID,
    '--task',
    'editor for widgets',
  );
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`^${EDITOR_SID}:editor-widgets r_`));
  const built = await run(
    'start',
    'ou-a',
    '--kind',
    'builder',
    '--sid',
    EDITOR_SID,
    '--task',
    'build it',
  );
  assert.equal(built.code, 0, built.stderr);
  // only the builder's `[running]` line is in the ledger: a line for the editor would read as a running agent
  const lines = readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ou-a/);
  const listed = JSON.parse((await run('list', '--json')).stdout) as {
    name: string;
    kind: string;
    slots: number | null;
  }[];
  assert.deepEqual(
    listed.map((one) => [one.name, one.kind, one.slots]),
    [
      ['editor-widgets', 'editor', 4],
      ['ou-a', 'builder', null],
    ],
  );
  const refused = await run(
    'start',
    'ou-b',
    '--kind',
    'builder',
    '--slots',
    '2',
    '--sid',
    EDITOR_SID,
    '--task',
    'x',
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /slots/);
});

test('two editors on one repo are told apart by their sessions, each with its own authors and slots', async () => {
  const { registry, live, snapshot } = world();
  const second = '22222222-1111-4222-8333-444444444444';
  registry.start({ ...EDITOR, slots: 3, at: ago(300) });
  registry.start({
    ...EDITOR,
    name: 'editor-two',
    sid: '22222222',
    session: second,
    slots: 2,
    at: ago(299),
  });
  // the sorting is by label, not by who registered first
  live(EDITOR_SESSION, 'beta');
  // the parent process is the other live session
  live(second, 'alpha', process.ppid);
  registry.start({ ...build('ou-a'), at: ago(60) });
  registry.start({ ...build('ou-b', '22222222'), at: ago(60) });
  registry.start({ ...build('ou-c', '22222222'), at: ago(60) });
  const data = await snapshot();
  assert.deepEqual(
    data.editors.map((one) => [
      one.label,
      one.slots,
      one.in_use,
      one.authors.map((author) => author.name),
    ]),
    [
      ['widgets (alpha)', 2, 2, ['ou-b', 'ou-c']],
      ['widgets (beta)', 3, 1, ['ou-a']],
    ],
  );
  const views = viewsOf(data);
  assert.equal(views.get('ou-a')?.editor?.label, 'widgets (beta)');
  assert.equal(views.get('ou-b')?.editor?.label, 'widgets (alpha)');
  assert.equal(views.get('ou-b')?.editor?.session, second);
});

test('two editor tabs with one name are told apart by the first 8 of their session ids', async () => {
  const { registry, live, snapshot } = world();
  const second = '22222222-1111-4222-8333-444444444444';
  registry.start({ ...EDITOR, at: ago(300) });
  registry.start({ ...EDITOR, name: 'editor-two', sid: '22222222', session: second, at: ago(299) });
  live(EDITOR_SESSION, 'editor');
  live(second, 'editor', process.ppid);
  const data = await snapshot();
  assert.deepEqual(
    data.editors.map((one) => one.label),
    ['widgets (22222222)', 'widgets (abcdef01)'],
  );
});
