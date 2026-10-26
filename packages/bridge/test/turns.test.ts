import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, git, writeJson, startBridge, runCli, TOKEN, type TestBridge } from './helpers.ts';
import { inboxKey, pageKey } from '../src/server/page-key.ts';
import { MAX_TURNS, TurnStore } from '../src/turns/turns.ts';
import type { StoryData, Turn, TurnList } from '@once-upon-a-diff/shared/types';

const HOOK = fileURLToPath(
  new URL('../../../skills/once-upon/bin/capture-turn.sh', import.meta.url),
);

/** Every bridge a test started, closed at the end so a failed test can't keep the process alive. */
const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

/** A bridge whose home has the port and token the hook reads from config.json. */
async function bridgeWithConfig() {
  const home = tmp('turns-home');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const port = Number(new URL(bridge.base).port);
  writeJson(path.join(home, 'config.json'), { port, token: TOKEN });
  return { home, bridge, port };
}

/** A checkout with one commit, on branch main, whose origin is acme/widgets. */
function checkout() {
  const repo = tmp('turns-repo');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'one.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  return repo;
}

/** A Claude Code transcript: an earlier prompt, then this turn's prompt, a tool call and its result. */
function transcript(prompt: string): string {
  const file = path.join(tmp('turns-transcript'), 'session.jsonl');
  const line = (value: unknown) => JSON.stringify(value);
  writeFileSync(
    file,
    [
      line({ type: 'user', message: { role: 'user', content: 'an earlier prompt' } }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
        },
      }),
      'not json at all',
    ].join('\n') + '\n',
  );
  return file;
}

/** Runs the Stop hook the way Claude Code does: its JSON on stdin. */
function runHook(
  home: string,
  input: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [HOOK], { env: { ...process.env, ONCE_UPON_HOME: home } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const stop = (repo: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  cwd: repo,
  transcript_path: transcript('Rename b to B in one.txt'),
  last_assistant_message: 'Renamed it.',
  ...extra,
});

const turnsOf = async (bridge: TestBridge, query = '') =>
  (await bridge.call<TurnList>('GET', `/api/turns${query}`)).body;

test('the hook snapshots a turn, posts it, and leaves the repo alone', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\n');
  writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
  const indexBefore = readFileSync(path.join(repo, '.git/index'));

  const ran = await runHook(home, stop(repo));
  assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', '']);

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
    `/api/turns/read?id=${turn.id}`,
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
  writeFileSync(path.join(repo, 'one.txt'), 'turn one\n');
  await runHook(home, stop(repo));
  // a turn that changes nothing adds no turn
  await runHook(home, stop(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 1);
  // the next turn's diff is against the first turn's snapshot, not HEAD
  writeFileSync(path.join(repo, 'two.txt'), 'turn two\n');
  await runHook(home, stop(repo));
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
  // another session starts from HEAD again
  await runHook(home, stop(repo, { session_id: 'sess-2' }));
  assert.equal((await turnsOf(bridge)).turns.length, 3);
  await bridge.close();
});

test('the hook does nothing, quietly, without a bridge, outside a repo, or on bad input', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');

  // not a git repo
  assert.deepEqual(await runHook(home, stop(tmp('not-a-repo'))), {
    code: 0,
    stdout: '',
    stderr: '',
  });
  // garbage and empty input
  assert.equal((await runHook(home, 'not json')).code, 0);
  assert.equal((await runHook(home, '')).code, 0);
  assert.equal((await runHook(home, stop(repo, { session_id: '../evil' }))).code, 0);
  assert.equal((await turnsOf(bridge)).turns.length, 0);

  // no bridge answering: nothing is snapshotted, so no baseline is kept either
  await bridge.close();
  const down = await runHook(home, stop(repo));
  assert.deepEqual(down, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(path.join(home, 'turn-baselines', 'sess-1.json')), false);
  // and no config at all
  assert.equal((await runHook(tmp('no-config'), stop(repo))).code, 0);
});

test('a failed post keeps the baseline, so the next turn carries the change', async () => {
  const { home, bridge, port } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'lost post\n');
  // the bridge answers health but refuses the token for the post: a wrong token fails both, so use a repo path it rejects
  writeJson(path.join(home, 'config.json'), { port, token: 'wrong-token' });
  await runHook(home, stop(repo));
  assert.equal((await turnsOf(bridge)).turns.length, 0);
  writeJson(path.join(home, 'config.json'), { port, token: TOKEN });
  await runHook(home, stop(repo));
  assert.equal(
    (await turnsOf(bridge)).turns.length,
    1,
    'the change comes with the next turn that gets through',
  );
  await bridge.close();
});

test('the API lists by repo, reads, and marks reviewed; ids and trees are checked', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await runHook(home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;

  const byRepo = await turnsOf(bridge, '?repo=acme/widgets');
  assert.equal(byRepo.turns.length, 1);
  assert.deepEqual(byRepo.repos, [{ repo: 'acme/widgets', count: 1, unreviewed: 1 }]);
  assert.equal((await turnsOf(bridge, '?repo=other/thing')).turns.length, 0);

  const marked = await bridge.call<{ turn: Turn }>('POST', '/api/turns/reviewed', { id: turn.id });
  assert.ok(marked.body.turn.reviewed_at);
  assert.equal((await turnsOf(bridge)).repos[0].unreviewed, 0);
  const unmarked = await bridge.call<{ turn: Turn }>('POST', '/api/turns/reviewed', {
    id: turn.id,
    reviewed: false,
  });
  assert.equal(unmarked.body.turn.reviewed_at, null);

  assert.equal((await bridge.call('GET', '/api/turns/read?id=../../config')).status, 404);
  assert.equal(
    (await bridge.call('POST', '/api/turns/reviewed', { id: 't_nothere123' })).status,
    404,
  );
  const add = (body: Record<string, unknown>) => bridge.call('POST', '/api/turns', body);
  assert.equal((await add({ repo_path: 'relative', base_tree: 'a', head_tree: 'b' })).status, 400);
  assert.equal(
    (await add({ repo_path: path.join(repo, '..'), base_tree: 'a', head_tree: 'b' })).status,
    400,
  );
  assert.equal(
    (await add({ repo_path: repo, base_tree: '--output=x', head_tree: 'b' })).status,
    400,
  );
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
  assert.equal(
    (await add({ repo_path: repo, base_tree: tree, head_tree: tree })).body &&
      (await add({ repo_path: repo, base_tree: tree, head_tree: tree })).status,
    200,
    'same trees: nothing to keep',
  );
  // a subfolder of a checkout isn't a checkout's top
  mkdirSync(path.join(repo, 'sub'));
  assert.equal(
    (await add({ repo_path: path.join(repo, 'sub'), base_tree: tree, head_tree: tree })).status,
    400,
  );
  // adding needs the bridge's token
  const plain = await fetch(`${bridge.base}/api/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(plain.status, 401);
  await bridge.close();
});

test('the inbox page’s key reaches the turn routes and nothing else', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await runHook(home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  const withKey = (key: string, method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${key}` });

  const key = inboxKey(TOKEN);
  assert.equal((await withKey(key, 'GET', '/api/turns')).status, 200);
  assert.equal((await withKey(key, 'GET', `/api/turns/read?id=${turn.id}`)).status, 200);
  assert.equal((await withKey(key, 'POST', '/api/turns/reviewed', { id: turn.id })).status, 200);
  const open = await withKey(key, 'POST', '/api/turns/open', { id: turn.id });
  assert.equal(open.status, 200);
  assert.match((open.body as { url: string }).url, /\/local\/turn-t_[a-z0-9]+\/#key=page\./);
  // adding a turn, the link, the rest of the API and any story are the token's alone
  for (const [method, route, body] of [
    ['POST', '/api/turns', {}],
    ['GET', '/api/turns/link', undefined],
    ['GET', '/api/stories', undefined],
    ['GET', '/api/prefs', undefined],
    ['POST', '/api/builds', {}],
    ['GET', `/api/stories/turn-${turn.id}`, undefined],
  ] as const) {
    assert.equal((await withKey(key, method, route, body)).status, 403, `${method} ${route}`);
  }
  // and a story's key doesn't open the inbox, nor the inbox key a story
  const storyKey = pageKey(TOKEN, `turn-${turn.id}`);
  assert.equal((await withKey(storyKey, 'GET', '/api/turns')).status, 403);
  assert.equal((await withKey(`${key}x`, 'GET', '/api/turns')).status, 403);
  // the link the token asks for carries the key in the fragment, and the page itself carries none
  const link = await bridge.call<{ url: string }>('GET', '/api/turns/link?repo=acme/widgets');
  assert.equal(link.body.url, `${bridge.base}/inbox/#key=${key}&repo=acme%2Fwidgets`);
  const page = await fetch(`${bridge.base}/inbox/`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(key));
  await bridge.close();
});

test('opening a turn makes a local story with the panel’s Ask, and Mark reviewed on its page', async () => {
  const { home, bridge } = await bridgeWithConfig();
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'changed\n');
  await runHook(home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;

  const open = await bridge.call<{ story: string }>('POST', '/api/turns/open', { id: turn.id });
  const id = open.body.story;
  assert.equal(id, `turn-${turn.id}`);
  assert.equal(
    (await bridge.call<{ story: string }>('POST', '/api/turns/open', { id: turn.id })).body.story,
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
  writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100).concat('\n').repeat(30000)); // ≈ 3 MB
  writeFileSync(path.join(repo, 'small.txt'), 'small\n');
  await runHook(home, stop(repo));
  const [turn] = (await turnsOf(bridge)).turns;
  assert.equal(turn.truncated, true);
  const big = turn.files.find((file) => file.path === 'big.txt');
  assert.equal(big?.omitted, true);
  assert.equal(big?.added, 30000, 'the counts are still there');
  assert.equal(turn.files.find((file) => file.path === 'small.txt')?.omitted, undefined);
  const { diff } = (await bridge.call<{ diff: string }>('GET', `/api/turns/read?id=${turn.id}`))
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

test('`once-upon review` prints the inbox link', async () => {
  const home = tmp('turns-cli');
  writeJson(path.join(home, 'config.json'), { port: 48999, token: TOKEN });
  const ran = await runCli(home, ['review', '--no-open']);
  assert.equal(ran.code, 0);
  assert.equal(ran.stdout.trim(), `http://127.0.0.1:48999/inbox/#key=${inboxKey(TOKEN)}`);
  assert.match(ran.stderr, /0 turns to review/);
});
