import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmp, git, writeJson, startBridge, runCli, TOKEN, type TestBridge } from './helpers.ts';
import { checkout, prompt, ran, runHook, spoolLines, stop } from './spool-helpers.ts';
import { inboxKey, pageKey } from '../src/server/page-key.ts';
import { MAX_TURNS, TurnStore } from '../src/capture/turns.ts';
import { headerPaths, parseUnifiedDiff } from '../src/util/diff.ts';
import type { StoryData, Turn, InboxList } from '@once-upon-a-diff/shared/types';

/** Every bridge a test started, closed at the end so a failed test can't keep the process alive. */
const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

/** A bridge on its own home. The hook writes its spool there, and the bridge reads it. */
async function bridgeWithConfig() {
  const home = tmp('turns-home');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const port = Number(new URL(bridge.base).port);
  writeJson(path.join(home, 'config.json'), { port, token: TOKEN });
  return { home, bridge, port };
}

const turnsOf = async (bridge: TestBridge, query = '') =>
  (await bridge.call<InboxList>('GET', `/api/inbox${query}`)).body;

test('the hook snapshots a turn into the spool, the bridge makes the turn, and the repo is left alone', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  const head = git(repo, 'rev-parse', 'HEAD');
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\n');
  writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
  const indexBefore = readFileSync(path.join(repo, '.git/index'));

  const result = await ran(bridge, home, stop(repo));
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);

  // two short lines, one a prompt's and one a Stop's: ids and paths, never the prompt or Claude's message
  const lines = spoolLines(home);
  assert.deepEqual(
    lines.map((line) => [line.event, line.session, line.top, line.branch]),
    [
      ['prompt', 'sess-1', realpathSync(repo), 'main'],
      ['stop', 'sess-1', realpathSync(repo), 'main'],
    ],
  );
  assert.match(String(lines[1].tree), /^[0-9a-f]{40}$/);
  assert.notEqual(lines[0].tree, lines[1].tree);
  const spool = readFileSync(path.join(home, 'turns', 'incoming.jsonl'), 'utf8');
  assert.ok(spool.split('\n').every((line) => Buffer.byteLength(line) < 3500));
  assert.doesNotMatch(spool, /Rename b|Renamed it/);
  assert.equal(statSync(path.join(home, 'turns', 'incoming.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(home, 'turns')).mode & 0o777, 0o700);

  const { turns } = await turnsOf(bridge);
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.repo, 'acme/widgets');
  assert.equal(turn.branch, 'main');
  assert.equal(turn.session, 'sess-1');
  assert.equal(
    turn.prompt,
    'Rename b to B in one.txt',
    "the transcript's last prompt, not the tool result",
  );
  assert.equal(turn.summary, 'Renamed it.');
  assert.deepEqual(turn.files.map((file) => [file.path, file.kind]).sort(), [
    ['new.txt', 'created'],
    ['one.txt', 'modified'],
  ]);
  assert.equal(turn.reviewed_at, null);

  const read = await bridge.call<{ turn: Turn; diff: string }>(
    'GET',
    `/api/inbox/turn?id=${turn.id}`,
  );
  assert.match(read.body.diff, /^\+B$/m);
  assert.match(read.body.diff, /^\+hello$/m);
  assert.doesNotMatch(read.body.diff, /noise/, '.gitignore is respected');

  // nothing of the user's moved: HEAD, branch, index, stash, and the files themselves
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.ok(
    readFileSync(path.join(repo, '.git/index')).equals(indexBefore),
    'the real index is untouched',
  );
  assert.equal(git(repo, 'stash', 'list'), '');
  assert.equal(git(repo, 'status', '--porcelain'), 'M one.txt\n?? new.txt');
  await bridge.close();
});

test('each turn is compared with the session’s last snapshot', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'turn one\n');
  await ran(bridge, home, stop(repo));
  // a turn that changes nothing adds no turn
  await ran(bridge, home, stop(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 1);
  // the next turn's diff is against the first turn's snapshot, not HEAD
  writeFileSync(path.join(repo, 'two.txt'), 'turn two\n');
  await ran(bridge, home, stop(repo));
  const { turns } = await turnsOf(bridge);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns[0].files.map((file) => file.path),
    ['two.txt'],
    'newest first, and only what that turn changed',
  );
  assert.deepEqual(
    turns[1].files.map((file) => file.path),
    ['one.txt'],
  );
  // another session starts from the tree it first saw, which already has turn one and two in it
  await ran(bridge, home, prompt(repo, { session_id: 'sess-2' }));
  await ran(bridge, home, stop(repo, { session_id: 'sess-2' }));
  assert.equal((await turnsOf(bridge)).turns.length, 2);
  writeFileSync(path.join(repo, 'three.txt'), 'sess-2\n');
  await ran(bridge, home, stop(repo, { session_id: 'sess-2' }));
  const after = await turnsOf(bridge);
  assert.equal(after.turns.length, 3);
  assert.deepEqual(
    after.turns[0].files.map((file) => file.path),
    ['three.txt'],
  );
  await bridge.close();
});

test('changes already uncommitted when a session starts are not its turn', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'edited before the session\n');
  // the starting snapshot is recorded without a turn, and a later prompt doesn't move it
  await ran(bridge, home, prompt(repo));
  await ran(bridge, home, prompt(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 0);
  writeFileSync(path.join(repo, 'two.txt'), 'the session’s own work\n');
  await ran(bridge, home, stop(repo));
  const { turns } = await turnsOf(bridge);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].files.map((file) => file.path),
    ['two.txt'],
    'one.txt was already edited when the session began',
  );
  // a session with nothing else changed leaves the inbox alone
  await ran(bridge, home, stop(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 1);
  await bridge.close();
});

test('a Stop with no prompt before it uses the session’s last Stop; the first one only records it', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'before the hook was wired\n');
  // the session began without the prompt hook: its first Stop is only where it stands
  await ran(bridge, home, stop(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 0);
  writeFileSync(path.join(repo, 'two.txt'), 'next turn\n');
  await ran(bridge, home, stop(repo));
  const { turns } = await turnsOf(bridge);
  assert.deepEqual(
    turns.map((turn) => turn.files.map((file) => file.path)),
    [['two.txt']],
  );
  await bridge.close();
});

test('the hook does nothing, quietly, outside a repo or on bad input, and still spools with no bridge running', async () => {
  const home = tmp('turns-quiet');
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');

  // not a git repo
  assert.deepEqual(await runHook(home, stop(tmp('not-a-repo'))), {
    code: 0,
    stdout: '',
    stderr: '',
  });
  // garbage and empty input, an event it doesn't take, and a session id that isn't a safe file name
  assert.equal((await runHook(home, 'not json')).code, 0);
  assert.equal((await runHook(home, '')).code, 0);
  assert.equal((await runHook(home, stop(repo, { hook_event_name: 'SessionEnd' }))).code, 0);
  assert.equal((await runHook(home, stop(repo, { session_id: '../evil' }))).code, 0);
  assert.equal((await runHook(home, stop(repo, { cwd: '' }))).code, 0);
  assert.deepEqual(spoolLines(home), []);

  // no bridge, no config: the line is written all the same, and waits
  assert.deepEqual(await runHook(home, stop(repo)), { code: 0, stdout: '', stderr: '' });
  assert.equal(spoolLines(home).length, 1);
});

test('a bridge that was down catches up: what the hook spooled becomes turns when it starts', async () => {
  const home = tmp('turns-catchup');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'while the bridge was down\n');
  await runHook(home, stop(repo));
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'two.txt'), 'second turn\n');
  await runHook(home, stop(repo));
  assert.equal(spoolLines(home).length, 4);

  const bridge = await startBridge({ home });
  open.push(bridge);
  await bridge.server.spool.drain();
  const { turns } = await turnsOf(bridge);
  assert.deepEqual(
    turns.map((turn) => turn.files.map((file) => file.path)),
    [['two.txt'], ['one.txt']],
  );
  assert.equal(turns[1].prompt, 'Rename b to B in one.txt');
  await bridge.close();
});

test('the API lists by repo, reads, and marks reviewed; ids are checked, and turns can no longer be posted', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;

  const byRepo = await turnsOf(bridge, '?repo=acme/widgets');
  assert.equal(byRepo.turns.length, 1);
  assert.deepEqual(byRepo.repos, [{ repo: 'acme/widgets', count: 1, unreviewed: 1 }]);
  assert.equal((await turnsOf(bridge, '?repo=other/thing')).turns.length, 0);

  const marked = await bridge.call<{ turn: Turn }>('POST', '/api/inbox/reviewed', { id: turn.id });
  assert.ok(marked.body.turn.reviewed_at);
  assert.equal((await turnsOf(bridge)).repos[0].unreviewed, 0);
  const unmarked = await bridge.call<{ turn: Turn }>('POST', '/api/inbox/reviewed', {
    id: turn.id,
    reviewed: false,
  });
  assert.equal(unmarked.body.turn.reviewed_at, null);

  assert.equal((await bridge.call('GET', '/api/inbox/turn?id=../../config')).status, 404);
  assert.equal(
    (await bridge.call('POST', '/api/inbox/reviewed', { id: 't_nothere123' })).status,
    404,
  );
  // the hook's spool is the way in: there is no route that takes a turn
  assert.equal((await bridge.call('POST', '/api/inbox', {})).status, 404);
  await bridge.close();
});

test('the inbox page’s key reaches the turn routes and nothing else', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  const withKey = (key: string, method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${key}` });

  const key = inboxKey(TOKEN);
  assert.equal((await withKey(key, 'GET', '/api/inbox')).status, 200);
  assert.equal((await withKey(key, 'GET', `/api/inbox/turn?id=${turn.id}`)).status, 200);
  assert.equal((await withKey(key, 'POST', '/api/inbox/reviewed', { id: turn.id })).status, 200);
  const open = await withKey(key, 'POST', '/api/inbox/open', { id: turn.id });
  assert.equal(open.status, 200);
  assert.match((open.body as { url: string }).url, /\/local\/turn-t_[a-z0-9]+\/#key=page\./);
  // the link, the rest of the API and any story are the token's alone
  for (const [method, route, body] of [
    ['GET', '/api/inbox/link', undefined],
    ['GET', '/api/stories', undefined],
    ['GET', '/api/prefs', undefined],
    ['POST', '/api/builds', {}],
    ['GET', `/api/stories/turn-${turn.id}`, undefined],
  ] as const) {
    assert.equal((await withKey(key, method, route, body)).status, 403, `${method} ${route}`);
  }
  // and a story's key doesn't open the inbox, nor the inbox key a story
  const storyKey = pageKey(TOKEN, `turn-${turn.id}`);
  assert.equal((await withKey(storyKey, 'GET', '/api/inbox')).status, 403);
  assert.equal((await withKey(`${key}x`, 'GET', '/api/inbox')).status, 403);
  // the link the token asks for carries the key in the fragment, and the page itself carries none
  const link = await bridge.call<{ url: string }>('GET', '/api/inbox/link?repo=acme/widgets');
  assert.equal(link.body.url, `${bridge.base}/inbox/#key=${key}&repo=acme%2Fwidgets`);
  const page = await fetch(`${bridge.base}/inbox/`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(key));
  await bridge.close();
});

test('opening a turn makes a local story with the panel’s Ask, and Mark reviewed on its page', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;

  const open = await bridge.call<{ story: string }>('POST', '/api/inbox/open', { id: turn.id });
  const id = open.body.story;
  assert.equal(id, `turn-${turn.id}`);
  assert.equal(
    (await bridge.call<{ story: string }>('POST', '/api/inbox/open', { id: turn.id })).body.story,
    id,
    'opened again, it is the same story',
  );

  const story = (await bridge.call<StoryData>('GET', `/api/stories/${id}`)).body;
  assert.equal(story.kind, 'local');
  assert.match(story.title, /Rename b to B/);
  assert.deepEqual(
    story.files.map((file) => file.rel),
    ['one.txt'],
  );
  assert.equal(story.local!.files[0].hunks.length, 1);
  assert.equal(story.local!.branch, null, 'no Create pull request for a turn');
  assert.deepEqual(story.local!.turn, { id: turn.id, reviewed_at: null });
  assert.match(story.chapters[0].narrative, /You asked/);
  assert.equal(
    existsSync(path.join(repo, '.once-upon')),
    false,
    "nothing is written into the user's checkout",
  );

  // the page's own key reaches the story's routes: Ask lands in the inbox for the repo, Mark reviewed ticks the turn
  const key = pageKey(TOKEN, id);
  const asked = await bridge.call(
    'POST',
    `/api/stories/${id}/questions`,
    { text: 'why B?', step: 1 },
    { Authorization: `Bearer ${key}` },
  );
  assert.equal(asked.status, 200);
  const [entry] = bridge.server.inbox.unread('probe').filter((line) => line.type === 'question');
  assert.equal((entry as { text: string }).text, 'why B?');
  assert.equal(entry.repo, 'acme/widgets', 'a listener for the repo gets it');
  const marked = await bridge.call<{ reviewed_at: string }>(
    'POST',
    `/api/stories/${id}/turn`,
    { reviewed: true },
    { Authorization: `Bearer ${key}` },
  );
  assert.ok(marked.body.reviewed_at);
  assert.ok((await turnsOf(bridge)).turns[0].reviewed_at);
  // a turn is never pushed from the page
  const push = await bridge.call(
    'POST',
    `/api/stories/${id}/pr`,
    { action: 'push' },
    { Authorization: `Bearer ${key}` },
  );
  assert.equal(push.status, 400);
  await bridge.close();
});

test('a turn too big to keep whole keeps its counts, and files stay owner-only', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100).concat('\n').repeat(30000)); // ≈ 3 MB
  writeFileSync(path.join(repo, 'small.txt'), 'small\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  assert.equal(turn.truncated, true);
  const big = turn.files.find((file) => file.path === 'big.txt');
  assert.equal(big?.omitted, true);
  assert.equal(big?.added, 30000, 'the counts are still there');
  assert.equal(turn.files.find((file) => file.path === 'small.txt')?.omitted, undefined);
  const { diff } = (await bridge.call<{ diff: string }>('GET', `/api/inbox/turn?id=${turn.id}`))
    .body;
  assert.ok(diff.includes('small.txt') && !diff.includes('big.txt'));

  const dir = path.join(home, 'turns');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of readdirSync(dir)) {
    assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
  }
  await bridge.close();
});

test('a repo keeps its newest turns, and the older ones go with their story folders', () => {
  const home = tmp('turns-prune');
  const store = new TurnStore(home);
  const dir = path.join(home, 'turns');
  mkdirSync(dir, { recursive: true });
  const total = MAX_TURNS + 5;
  for (let i = 0; i < total; i++) {
    const id = `t_${String(i).padStart(6, '0')}`;
    const turn: Partial<Turn> = {
      id,
      repo_path: '/work/widgets',
      repo_name: 'widgets',
      repo: null,
      at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      files: [],
    };
    writeJson(path.join(dir, `${id}.json`), turn);
    writeFileSync(path.join(dir, `${id}.diff`), '');
  }
  mkdirSync(path.join(home, 'turn-t_000000'));
  writeJson(path.join(dir, 't_other00.json'), {
    id: 't_other00',
    repo_path: '/work/other',
    repo_name: 'other',
    repo: null,
    at: '2026-01-01T00:00:00.000Z',
    files: [],
  });
  store.prune('/work/widgets');
  const kept = store.all({ repo: 'widgets' });
  assert.equal(kept.length, MAX_TURNS);
  assert.equal(kept[0].id, `t_${String(total - 1).padStart(6, '0')}`);
  assert.equal(existsSync(path.join(dir, 't_000000.diff')), false);
  assert.equal(existsSync(path.join(home, 'turn-t_000000')), false);
  assert.equal(store.all({ repo: 'other' }).length, 1, 'another repo is left alone');
});

test('a turn is what changed between the prompt and the Stop: edits made between turns are not in it', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'claude.txt'), 'turn one\n');
  await ran(bridge, home, stop(repo));
  // between turns: a hand edit, and a branch switch with its own files
  writeFileSync(path.join(repo, 'one.txt'), 'edited by hand\n');
  git(repo, 'checkout', '-q', '-b', 'other');
  writeFileSync(path.join(repo, 'from-the-branch.txt'), 'x\n');
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'claude.txt'), 'turn two\n');
  await ran(bridge, home, stop(repo));
  const { turns } = await turnsOf(bridge);
  assert.deepEqual(
    turns.map((turn) => turn.files.map((file) => file.path)),
    [['claude.txt'], ['claude.txt']],
  );
  assert.equal(turns[0].branch, 'other');
});

test('a prompt followed by another prompt is a stopped turn: it ends at the next prompt’s snapshot', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'half done when I pressed Esc\n');
  // no Stop for it: the next prompt is what closes it
  await ran(bridge, home, prompt(repo));
  const [stopped] = (await turnsOf(bridge)).turns;
  assert.equal(stopped.interrupted, true);
  assert.deepEqual(
    stopped.files.map((file) => file.path),
    ['one.txt'],
  );
  assert.equal(stopped.prompt, 'Rename b to B in one.txt');
  writeFileSync(path.join(repo, 'two.txt'), 'the next turn\n');
  await ran(bridge, home, stop(repo));
  const { turns } = await turnsOf(bridge);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].interrupted, undefined, 'a turn that finished is not marked');
  assert.deepEqual(
    turns[0].files.map((file) => file.path),
    ['two.txt'],
  );
  // opened as a story, the stopped turn says it may hold later edits
  const opened = await bridge.call<{ story: string }>('POST', '/api/inbox/open', {
    id: stopped.id,
  });
  const story = (await bridge.call<StoryData>('GET', `/api/stories/${opened.body.story}`)).body;
  assert.match(story.chapters[0].narrative, /stopped before it finished/);
});

test('reading the spool again makes no second turn, and keeps what was marked reviewed', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  writeFileSync(path.join(repo, 'two.txt'), 'first\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  await bridge.call('POST', '/api/inbox/reviewed', { id: turn.id });
  const before = readdirSync(path.join(home, 'turns')).sort();

  // a lost offset (the state file deleted) reads every line again, and a restarted bridge does the same
  rmSync(path.join(home, 'turn-spool.json'));
  bridge.server.spool.state.offset = 0;
  bridge.server.spool.state.open = {};
  bridge.server.spool.state.last = {};
  await bridge.server.spool.drain();
  const again = await turnsOf(bridge);
  assert.equal(again.turns.length, 1);
  assert.ok(again.turns[0].reviewed_at, 'still reviewed');
  assert.deepEqual(readdirSync(path.join(home, 'turns')).sort(), before);
});

test('the inbox can list only the unreviewed turns, chosen before the limit', () => {
  const home = tmp('turns-unreviewed');
  const store = new TurnStore(home);
  const dir = path.join(home, 'turns');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const id = `t_${String(i).padStart(6, '0')}`;
    writeJson(path.join(dir, `${id}.json`), {
      id,
      repo_path: '/work/widgets',
      repo_name: 'widgets',
      repo: null,
      at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      files: [],
      // the newest three are reviewed
      reviewed_at: i >= 2 ? '2026-10-02T00:00:00.000Z' : null,
    });
  }
  assert.deepEqual(
    store.list({ limit: 2 }).turns.map((turn) => turn.id),
    ['t_000004', 't_000003'],
    'everything, newest first, is cut to the limit',
  );
  const unreviewed = store.list({ limit: 2, unreviewed: true });
  assert.deepEqual(
    unreviewed.turns.map((turn) => turn.id),
    ['t_000001', 't_000000'],
    'the older unreviewed turns are still reachable',
  );
  assert.deepEqual(unreviewed.repos, [{ repo: 'widgets', count: 5, unreviewed: 2 }]);
});

test('a path git quotes (a tab, a quote or a backslash) is read and kept like any other', async () => {
  assert.deepEqual(headerPaths('diff --git a/src/one.ts b/src/one.ts'), {
    from: 'src/one.ts',
    to: 'src/one.ts',
  });
  assert.deepEqual(headerPaths('diff --git "a/x\\ty" "b/x\\ty"'), { from: 'x\ty', to: 'x\ty' });
  assert.deepEqual(headerPaths('diff --git a/old.txt "b/we\\"ird\\\\n\\303\\251.txt"'), {
    from: 'old.txt',
    to: 'we"ird\\n\u00e9.txt',
  });
  assert.deepEqual(headerPaths('diff --git "a/q\\"s" b/plain.txt'), {
    from: 'q"s',
    to: 'plain.txt',
  });
  const parsed = parseUnifiedDiff(
    'diff --git "a/x\\ty" "b/x\\ty"\nrename from "x\\ty"\n--- "a/x\\ty"\n+++ "b/x\\ty"\n@@ -1 +1 @@\n-a\n+b\n',
  );
  assert.deepEqual([...parsed.keys()], ['x\ty']);
  assert.equal(parsed.get('x\ty')?.renamed_from, 'x\ty');

  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  const odd = 'we"ird\tname\\.txt';
  writeFileSync(path.join(repo, odd), 'quoted\n');
  await ran(bridge, home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  assert.deepEqual(
    turn.files.map((file) => [file.path, file.omitted]),
    [[odd, undefined]],
    'its lines were kept, so it isn’t "too big to keep"',
  );
  const { diff } = (await bridge.call<{ diff: string }>('GET', `/api/inbox/turn?id=${turn.id}`))
    .body;
  assert.match(diff, /^\+quoted$/m);
});

test('`once-upon review` prints the inbox link', async () => {
  const home = tmp('turns-cli');
  writeJson(path.join(home, 'config.json'), { port: 48999, token: TOKEN });
  const ran = await runCli(home, ['review', '--no-open']);
  assert.equal(ran.code, 0);
  // on the proxy's name by default, on the bridge's own address with --local
  assert.equal(ran.stdout.trim(), `https://once-upon.test/inbox/#key=${inboxKey(TOKEN)}`);
  assert.match(ran.stderr, /0 turns to review/);
  const local = await runCli(home, ['review', '--no-open', '--local']);
  assert.equal(local.stdout.trim(), `http://127.0.0.1:48999/inbox/#key=${inboxKey(TOKEN)}`);
});
