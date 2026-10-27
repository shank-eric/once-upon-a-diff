import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmp, git, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import {
  HOOK,
  checkout,
  prompt,
  ran,
  runHook,
  spoolLines,
  stop,
  transcriptFile,
} from './spool-helpers.ts';
import {
  TurnSpool,
  emptyState,
  isExcluded,
  pairRecord,
  parseRecord,
  spoolFile,
  spoolStatus,
  type SpoolRecord,
} from '../src/capture/spool.ts';
import { Transcript, textOfTurn } from '../src/capture/transcript.ts';
import { TurnStore } from '../src/capture/turns.ts';
import { doctor } from '../src/cli/doctor.ts';
import { portState } from '../src/cli/commands/bridge.ts';
import type { Turn } from '@once-upon-a-diff/shared/types';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

const TREE = (letter: string) => letter.repeat(40);
const record = (over: Partial<SpoolRecord>): SpoolRecord => ({
  v: 1,
  event: 'prompt',
  session: 'sess-1',
  top: '/work/widgets',
  tree: TREE('a'),
  branch: 'main',
  at: '2026-10-27T15:00:00Z',
  transcript: '',
  ...over,
});

/** A spool reader on its own home, with the log kept, that waits for no Stop to settle. */
function reader(home = tmp('spool-home'), opts = {}) {
  const logs: string[] = [];
  const made: Turn[] = [];
  const turns = new TurnStore(home);
  const spool = new TurnSpool(
    home,
    turns,
    (line) => logs.push(line),
    (turn) => made.push(turn),
    {
      settleMs: 0,
      ...opts,
    },
  );
  return { home, logs, made, turns, spool };
}

/** Writes a spool line by hand. */
const append = (home: string, line: unknown) => {
  mkdirSync(path.join(home, 'turns'), { recursive: true });
  appendFileSync(spoolFile(home), (typeof line === 'string' ? line : JSON.stringify(line)) + '\n');
};

test('a record is checked: its version, event, session, checkout, tree and time', () => {
  const good = record({});
  assert.deepEqual(parseRecord(JSON.stringify(good)), { record: good });
  const bad = (over: Record<string, unknown>) => parseRecord(JSON.stringify({ ...good, ...over }));
  for (const over of [
    { v: 2 },
    { event: 'end' },
    { session: '../evil' },
    { top: 'relative/path' },
    { tree: '--output=x' },
    { tree: 'abc123' },
    { at: 'yesterday' },
  ]) {
    assert.ok('error' in bad(over), JSON.stringify(over));
  }
  assert.ok('error' in parseRecord('not json'));
  assert.ok('error' in parseRecord('[]'));
});

test('prompts and Stops pair per session and checkout into turns', () => {
  const state = emptyState();
  const turn = (rec: Partial<SpoolRecord>) => pairRecord(state, record(rec));
  // a Stop with nothing before it is only where the session stands
  assert.equal(turn({ event: 'stop', tree: TREE('a') }), null);
  // and with no prompt before the next Stop, a turn from that last Stop
  const fromLast = turn({ event: 'stop', tree: TREE('b'), at: '2026-10-27T15:01:00Z' });
  assert.deepEqual(
    [fromLast?.base_tree, fromLast?.head_tree, fromLast?.interrupted],
    [TREE('a'), TREE('b'), false],
  );
  // prompt, then its Stop
  assert.equal(turn({ event: 'prompt', tree: TREE('c'), at: '2026-10-27T15:02:00Z' }), null);
  const done = turn({ event: 'stop', tree: TREE('d'), at: '2026-10-27T15:03:00Z' });
  assert.deepEqual(
    [done?.base_tree, done?.head_tree, done?.started_at],
    [TREE('c'), TREE('d'), '2026-10-27T15:02:00Z'],
  );
  assert.deepEqual(state.open, {}, 'the prompt is closed');
  // a Stop that changed nothing is no turn
  turn({ event: 'prompt', tree: TREE('d'), at: '2026-10-27T15:04:00Z' });
  assert.equal(turn({ event: 'stop', tree: TREE('d'), at: '2026-10-27T15:05:00Z' }), null);
  // prompt, prompt: the first was stopped, and ends at the second's snapshot
  turn({ event: 'prompt', tree: TREE('e'), at: '2026-10-27T15:06:00Z', branch: 'one' });
  const stopped = turn({
    event: 'prompt',
    tree: TREE('f'),
    at: '2026-10-27T15:07:00Z',
    branch: 'two',
  });
  assert.deepEqual(
    [stopped?.base_tree, stopped?.head_tree, stopped?.interrupted, stopped?.branch],
    [TREE('e'), TREE('f'), true, 'one'],
  );
  assert.equal(
    state.open['sess-1\n/work/widgets'].tree,
    TREE('f'),
    'the second prompt is open now',
  );
  // another checkout and another session don't mix with these
  assert.equal(turn({ event: 'prompt', top: '/work/other', tree: TREE('1') }), null);
  assert.equal(turn({ event: 'prompt', session: 'sess-2', tree: TREE('2') }), null);
  const other = turn({ event: 'stop', top: '/work/other', tree: TREE('3') });
  assert.deepEqual([other?.top, other?.base_tree], ['/work/other', TREE('1')]);
  const second = turn({ event: 'stop', session: 'sess-2', tree: TREE('4') });
  assert.deepEqual([second?.session, second?.base_tree], ['sess-2', TREE('2')]);
});

test('capture_exclude matches a repo by owner/name in any case, or a checkout by its folder', () => {
  const repo = checkout();
  assert.equal(isExcluded([], repo), false);
  assert.equal(isExcluded(['Acme/Widgets'], repo), true);
  assert.equal(isExcluded(['acme/widgets'], repo), true);
  assert.equal(isExcluded(['acme/gadgets', 'other/widgets'], repo), false);
  assert.equal(isExcluded([repo], repo), true);
  assert.equal(isExcluded([realpathSync(repo)], repo), true);
  assert.equal(isExcluded([path.join(repo, 'sub')], repo), false);
  assert.equal(isExcluded(['acme/widgets'], tmp('no-remote')), false);
});

test('the transcript gives the turn’s prompt and Claude’s last message, and only real prompts count', async () => {
  const session = 'sess-t';
  const file = transcriptFile(session, [
    { kind: 'prompt', ago: 600000, text: 'an old prompt' },
    { kind: 'assistant', ago: 590000, text: 'old answer', message: 'msg_0' },
    { kind: 'meta', ago: 20000, text: '<local-command-caveat>ignore</local-command-caveat>' },
    { kind: 'prompt', ago: 19000, text: '<system-reminder>not typed</system-reminder>' },
    { kind: 'prompt', ago: 18000, text: 'Please rename it' },
    { kind: 'sidechain', ago: 17000, text: 'a subagent was told this' },
    { kind: 'tool_use', ago: 16000, message: 'msg_1' },
    { kind: 'tool_result', ago: 15000 },
    { kind: 'assistant', ago: 10000, text: 'First part', message: 'msg_2' },
    { kind: 'assistant', ago: 9000, text: 'Second part', message: 'msg_2' },
    { kind: 'interrupt', ago: 8000 },
  ]);
  const entries = Transcript.open(file, session)!.entriesSince(0);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['prompt', 'assistant', 'prompt', 'assistant', 'assistant', 'interrupt'],
    'meta, system-reminder and sidechain lines are left out; an Esc is its own kind, not a prompt',
  );
  const now = Date.now();
  const said = textOfTurn(entries, now - 18500, now - 5000);
  assert.equal(
    said.prompt,
    'Please rename it',
    'the latest real prompt before the turn started, not the old one',
  );
  assert.equal(said.summary, 'First part\n\nSecond part', 'the last message, all its blocks');
  assert.equal(said.stopped, true);
  // a window with nothing in it
  assert.deepEqual(textOfTurn(entries, now + 400000, now + 401000), {
    prompt: null,
    summary: null,
    stopped: false,
  });
  // not this session's transcript, or not a file: unread
  assert.equal(Transcript.open(file, 'another-session'), null);
  assert.equal(
    Transcript.open(path.join(path.dirname(file), 'nothing', `${session}.jsonl`), session),
    null,
  );
  assert.equal(Transcript.open('relative.jsonl', 'relative'), null);
  assert.equal(Transcript.open(path.dirname(file), session), null);
});

test('the reader keeps its place across a restart, leaves a half-written line, and reads a replaced file again', async () => {
  const home = tmp('spool-offsets');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'turn\n');
  await runHook(home, stop(repo));
  let first = reader(home);
  await first.spool.drain();
  assert.equal(first.made.length, 1);
  const size = statSync(spoolFile(home)).size;
  assert.equal(JSON.parse(readFileSync(path.join(home, 'turn-spool.json'), 'utf8')).offset, size);
  assert.equal(statSync(path.join(home, 'turn-spool.json')).mode & 0o777, 0o600);

  // a restart reads nothing again
  first = reader(home);
  await first.spool.drain();
  assert.equal(first.made.length, 0);

  // a line that is still being written is left until it has its end
  const lines = spoolLines(home);
  const next = JSON.stringify({ ...lines[0], tree: TREE('9') });
  appendFileSync(spoolFile(home), next.slice(0, 40));
  await first.spool.drain();
  assert.equal(first.logs.length, 0, 'half a line is not an error');
  assert.equal(first.spool.state.offset, size);
  appendFileSync(spoolFile(home), next.slice(40) + '\n');
  await first.spool.drain();
  assert.equal(first.spool.state.offset, statSync(spoolFile(home)).size);
  assert.equal(
    Object.keys(first.spool.state.open).length,
    1,
    'it was read once whole: a prompt is open',
  );

  // the file emptied: the place is lost, and the read starts over (turns already kept are skipped)
  writeFileSync(spoolFile(home), '');
  await first.spool.drain();
  assert.equal(first.spool.state.offset, 0);
  assert.equal(first.turns.all().length, 1);
});

test('a prompt still waiting for its Stop survives a restart', async () => {
  const home = tmp('spool-open');
  const repo = checkout();
  await runHook(home, prompt(repo));
  const before = reader(home);
  await before.spool.drain();
  assert.equal(before.made.length, 0);
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  await runHook(home, stop(repo));
  const after = reader(home);
  await after.spool.drain();
  assert.equal(after.made.length, 1);
  assert.equal(after.made[0].prompt, 'Rename b to B in one.txt');
  assert.equal(after.made[0].summary, 'Renamed it.');
});

test('a Stop waits a moment before it is read, for the transcript to be written', async () => {
  const home = tmp('spool-settle');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  await runHook(home, stop(repo));
  let clock = Date.now();
  const held = reader(home, { settleMs: 5000, now: () => clock });
  await held.spool.drain();
  assert.equal(held.made.length, 0, 'the Stop is not old enough');
  assert.equal(
    JSON.parse(readFileSync(path.join(home, 'turn-spool.json'), 'utf8')).offset > 0,
    true,
    'the prompt before it was read',
  );
  clock += 6000;
  await held.spool.drain();
  assert.equal(held.made.length, 1);
});

test('a line no one can use is logged and skipped, and the lines after it are still read', async () => {
  const home = tmp('spool-bad');
  const repo = checkout();
  append(home, 'not json');
  append(home, record({ top: 'relative' }));
  append(home, record({ top: path.join(repo, 'sub') }));
  append(home, { ...record({}), tree: '--output=x' });
  append(home, { ...record({}), event: 'other' });
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  await runHook(home, stop(repo));
  // a prompt for a folder that is not a checkout's top, then its Stop
  mkdirSync(path.join(repo, 'sub'));
  append(
    home,
    record({ top: path.join(repo, 'sub'), tree: git(repo, 'rev-parse', 'HEAD^{tree}') }),
  );
  append(home, record({ top: path.join(repo, 'sub'), event: 'stop', tree: TREE('c') }));
  const run = reader(home);
  await run.spool.drain();
  assert.equal(run.made.length, 1, 'the real turn');
  assert.equal(run.logs.filter((line) => line.includes('skipped a line')).length, 4);
  assert.ok(
    run.logs.some(
      (line) => line.includes('the turn of session') && line.includes('top of a git checkout'),
    ),
  );
});

test('trees git has pruned (after about 2 weeks) skip that turn with a log line, and the next one is made', async () => {
  const home = tmp('spool-gc');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'turn one\n');
  await runHook(home, stop(repo));
  // an edit of your own between the turns, so the second turn starts from a tree of its own
  writeFileSync(path.join(repo, 'between.txt'), 'by hand\n');
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'two.txt'), 'turn two\n');
  await runHook(home, stop(repo));
  const [, firstStop] = spoolLines(home);
  const tree = String(firstStop.tree);
  rmSync(path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  const run = reader(home);
  await run.spool.drain();
  assert.ok(
    run.logs.some((line) => /snapshot trees are gone \(git gc prunes them/.test(line)),
    run.logs.join('\n'),
  );
  assert.deepEqual(
    run.made.map((turn) => turn.files.map((file) => file.path)),
    [['two.txt']],
  );
});

test('the bridge leaves out a repo capture_exclude names, even from lines already in the spool', async () => {
  const home = tmp('spool-scope-bridge');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  await runHook(home, stop(repo));
  writeJson(path.join(home, 'config.json'), { capture_exclude: ['ACME/Widgets'] });
  const run = reader(home);
  await run.spool.drain();
  assert.equal(run.made.length, 0);
  writeJson(path.join(home, 'config.json'), { capture_exclude: ['acme/other'] });
  rmSync(path.join(home, 'turn-spool.json'));
  const again = reader(home);
  await again.spool.drain();
  assert.equal(again.made.length, 1, 'a different repo in the list leaves this one alone');
});

test('the hook skips the snapshot for an excluded repo, by owner/name or folder', async () => {
  const home = tmp('spool-scope-hook');
  const repo = checkout();
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  const exclude = async (entries: unknown) => {
    writeJson(path.join(home, 'config.json'), { token: 'x', capture_exclude: entries });
    const before = spoolLines(home).length;
    const result = await runHook(home, prompt(repo));
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
    return spoolLines(home).length - before;
  };
  assert.equal(await exclude([]), 1, 'nothing excluded');
  assert.equal(await exclude(['Acme/WIDGETS']), 0, 'by owner/name, in any case');
  assert.equal(await exclude([repo]), 0, 'by folder');
  assert.equal(await exclude([realpathSync(repo)]), 0, 'by the folder it really is');
  assert.equal(await exclude(['acme/other', '/work/elsewhere']), 1, 'others in the list');
  assert.equal(await exclude('acme/widgets'), 1, 'not a list: ignored');
  // an excluded checkout leaves no snapshot behind either
  const objects = readdirSync(path.join(repo, '.git', 'objects')).length;
  await exclude(['acme/widgets']);
  assert.equal(readdirSync(path.join(repo, '.git', 'objects')).length, objects);
});

test('the hook’s line stays short with long paths, and the hook is quiet without jq or git', async () => {
  const home = tmp('spool-hook');
  const deep = path.join(tmp('deep'), 'a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120));
  mkdirSync(deep, { recursive: true });
  git(deep, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(deep, 'x.txt'), 'x\n');
  const long = transcriptFile('sess-1', []);
  await runHook(home, prompt(deep, { transcript_path: long }));
  const [line] = spoolLines(home);
  assert.equal(line.top, realpathSync(deep));
  assert.ok(Buffer.byteLength(readFileSync(spoolFile(home), 'utf8')) < 3500);
  // a transcript path so long the line would pass 3,500 bytes is not written
  await runHook(home, prompt(deep, { transcript_path: '/' + 'z'.repeat(3600) + '/sess-1.jsonl' }));
  assert.equal(spoolLines(home).length, 1);

  // no jq and no git on PATH: nothing, quietly
  const empty = tmp('empty-path');
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn('/bin/bash', [HOOK], { env: { PATH: empty, ONCE_UPON_HOME: home } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(prompt(deep)));
  });
  assert.deepEqual(result, { code: 0, out: '' });
  assert.equal(spoolLines(home).length, 1);
});

test('sessions that finish together write whole lines: parallel hooks do not interleave', async () => {
  const home = tmp('spool-parallel');
  const repo = checkout();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => runHook(home, prompt(repo, { session_id: `sess-${i}` }))),
  );
  const lines = spoolLines(home); // each line parsed: a torn one would throw
  assert.equal(lines.length, 12);
  assert.equal(new Set(lines.map((line) => line.session)).size, 12);
});

test('a fully read spool over the size limit is rotated, and an append that raced the rename is still read', async () => {
  const home = tmp('spool-rotate');
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'turn one\n');
  await runHook(home, stop(repo));
  let clock = Date.now();
  const run = reader(home, { rotateBytes: 100, rotateGraceMs: 3000, now: () => clock });
  await run.spool.drain();
  assert.equal(run.made.length, 1);
  const dir = path.join(home, 'turns');
  const old = readdirSync(dir).find((name) => /^incoming\.\d+\.old$/.test(name));
  assert.ok(old, 'the file was renamed');
  assert.equal(existsSync(spoolFile(home)), false, 'and the next hook starts a new one');
  assert.equal(run.spool.state.offset, 0);

  // a hook that had the old file open writes to it after the rename; another starts the new file
  assert.equal(spoolLines(home).length, 0, 'the new file does not exist yet');
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'two.txt'), 'turn two\n');
  const late = JSON.stringify({
    ...record({}),
    event: 'prompt',
    top: realpathSync(repo),
    tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
    session: 'late-one',
  });
  appendFileSync(path.join(dir, old!), late + '\n');
  await run.spool.drain();
  assert.ok(existsSync(path.join(dir, old!)), 'kept through its grace time');
  assert.ok(run.spool.state.open['late-one\n' + realpathSync(repo)], 'the late line was read');
  assert.equal(Object.keys(run.spool.state.open).length, 2, 'and so was the new file’s prompt');
  clock += 4000;
  run.spool.opts.rotateBytes = 1e9; // (not again, in this test)
  await run.spool.drain();
  assert.equal(existsSync(path.join(dir, old!)), false, 'then deleted');
  assert.equal(run.spool.state.rotated, null);
  // the Stop that closes the prompt still makes its turn
  await runHook(home, stop(repo));
  await run.spool.drain();
  assert.equal(run.made.length, 2);
});

test('a bridge reads the spool when it changes, with no one asking', async () => {
  const home = tmp('spool-watch');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const repo = checkout();
  await runHook(home, prompt(repo));
  writeFileSync(path.join(repo, 'one.txt'), 'edited\n');
  await runHook(home, stop(repo));
  const deadline = Date.now() + 8000;
  let turns: Turn[] = [];
  while (Date.now() < deadline && !turns.length) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    turns = bridge.server.turns.all();
  }
  assert.equal(turns.length, 1);
  assert.equal(turns[0].summary, 'Renamed it.');
  await bridge.close();
});

test('the bridge removes the older hook’s baselines when it starts', async () => {
  const home = tmp('spool-legacy');
  mkdirSync(path.join(home, 'turn-baselines'), { recursive: true });
  writeFileSync(path.join(home, 'turn-baselines', 'sess.json'), '{}');
  const bridge = await startBridge({ home });
  open.push(bridge);
  assert.equal(existsSync(path.join(home, 'turn-baselines')), false);
  await bridge.close();
});

test('doctor says whether the spool is being read, its size and the last record’s time', async () => {
  const home = tmp('spool-doctor');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const port = Number(new URL(bridge.base).port);
  const run = async () => {
    const lines: string[] = [];
    await doctor(home, { token: TOKEN, port }, { out: (line) => lines.push(line) });
    const found = lines.findIndex((line) => line.includes('Turn capture'));
    return lines.slice(found, found + 2).join('\n');
  };
  assert.match(await run(), /PASS.*no spool yet/);
  assert.deepEqual(spoolStatus(home), {
    exists: false,
    size: 0,
    unreadRecords: 0,
    lastAt: null,
    readAt: null,
  });

  const repo = checkout();
  await ran(bridge, home, prompt(repo));
  assert.match(
    await run(),
    /PASS.*Turn capture: spool \d+ bytes, last record .*, all read by the bridge/,
  );

  // lines the bridge hasn't read (here, written under its nose and not yet drained)
  bridge.server.spool.stop();
  await runHook(home, prompt(repo));
  const status = spoolStatus(home);
  assert.equal(status.unreadRecords, 1);
  assert.ok(status.lastAt && status.readAt);
  const text = await run();
  assert.match(text, /WARN.*1 not read yet/);
  assert.match(text, /fix: The bridge reads new lines within a few seconds/);
  await bridge.close();
});

test('`once-upon local` knows its own bridge on the port from a stranger, without calling it', async () => {
  const home = tmp('spool-port');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const port = Number(new URL(bridge.base).port);
  const file = path.join(home, 'bridge.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.pid, process.pid);
  assert.equal(written.port, port);
  assert.ok(
    !JSON.stringify(written).includes(TOKEN),
    'the file holds a fingerprint, never the token',
  );
  assert.equal(await portState(home, port, TOKEN), 'ours');
  assert.equal(
    await portState(home, String(port)),
    'ours',
    'a port given as text, and no token to compare',
  );
  assert.equal(
    await portState(home, port, 'a-newer-token'),
    'old-token',
    'a bridge that started before `once-upon token --rotate` is not the one this config opens',
  );
  assert.equal(
    await portState(tmp('spool-other-home'), port, TOKEN),
    'foreign',
    'another home’s bridge (or one with no file) is not ours',
  );
  // a file whose process is gone, over a port something else holds, is not a bridge either
  const gone = spawnSync('true').pid!;
  writeFileSync(file, JSON.stringify({ ...written, pid: gone }));
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  writeFileSync(file, JSON.stringify({ ...written, port: port + 1 }));
  assert.equal(await portState(home, port, TOKEN), 'foreign', 'the file names another port');
  writeFileSync(file, JSON.stringify(written));

  await bridge.close();
  assert.equal(existsSync(file), false, 'the file goes when the bridge closes');
  assert.equal(await portState(home, port, TOKEN), 'free');

  // some other program on the port, with a file left behind by a bridge that was killed
  const stranger = net.createServer();
  await new Promise<void>((resolve) => stranger.listen(port, '127.0.0.1', resolve));
  writeFileSync(file, JSON.stringify({ ...written, pid: gone }));
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  rmSync(file);
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  await new Promise((resolve) => stranger.close(resolve));
});

/** A tree id for a checkout holding only one.txt with this text, made without touching the checkout's index or files. */
function treeOf(repo: string, text: string): string {
  const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
    input: text,
    encoding: 'utf8',
  }).trim();
  return execFileSync('git', ['-C', repo, 'mktree'], {
    input: `100644 blob ${blob}\tone.txt\n`,
    encoding: 'utf8',
  }).trim();
}

/** A record for a checkout, `ago` ms before `clock`, with the time cut to the second as the hook writes it. */
const stamped = (
  repo: string,
  event: 'prompt' | 'stop',
  text: string,
  clock: number,
  ago = 0,
  session = 'sess-1',
): SpoolRecord =>
  record({
    event,
    session,
    top: realpathSync(repo),
    tree: treeOf(repo, text),
    at: new Date(Math.floor((clock - ago) / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  });

test('twenty sessions appending long lines at once write whole lines, even under macOS’s own bash', async () => {
  const home = tmp('spool-torn');
  const repo = checkout();
  // A stand-in for chmod, which the hook runs just before it appends, that holds every hook there until all have
  // arrived and then lets them go together, so the appends overlap.
  const bin = tmp('spool-torn-bin');
  const barrier = tmp('spool-torn-barrier');
  const chmod = path.join(bin, 'chmod');
  writeFileSync(
    chmod,
    `#!/bin/sh\n: >"${barrier}/ready.$$"\nwhile [ ! -e "${barrier}/go" ]; do :; done\nexec /bin/chmod "$@"\n`,
    { mode: 0o755 },
  );
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const shell = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  const rounds = 4;
  for (let round = 0; round < rounds; round++) {
    rmSync(path.join(barrier, 'go'), { force: true });
    for (const name of readdirSync(barrier)) {
      rmSync(path.join(barrier, name), { force: true });
    }
    // lines of about 3.3 KB: bash 3.2's printf writes a line over 1 KB in pieces, and pieces from two hooks interleave
    const hooks = Array.from({ length: 20 }, (_, index) =>
      runHook(
        home,
        prompt(repo, {
          session_id: `sess-${index}`,
          transcript_path: `/${'t'.repeat(3000)}/sess-${index}.jsonl`,
        }),
        env,
        shell,
      ),
    );
    const deadline = Date.now() + 30000;
    while (readdirSync(barrier).length < 20 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(path.join(barrier, 'go'), '');
    await Promise.all(hooks);
  }
  const lines = readFileSync(spoolFile(home), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 20 * rounds, 'every record was written');
  for (const line of lines) {
    const written = JSON.parse(line); // a torn or merged line is not JSON
    assert.ok(line.length > 3000, 'the lines are long enough to need more than one 1 KB write');
    assert.equal(written.event, 'prompt');
  }
  assert.equal(new Set(lines.map((line) => JSON.parse(line).session)).size, 20);
});

test('the snapshot runs none of the repo’s git hooks, and still runs its clean filters', async () => {
  const home = tmp('spool-hooks');
  const repo = checkout();
  const marker = path.join(tmp('hook-marker'), 'ran');
  const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho ran >>${marker}\n`, { mode: 0o755 });
  writeFileSync(path.join(repo, 'new.txt'), 'abc\n');
  // a clean filter, as git-lfs installs one: it changes what git stores for the file
  git(repo, 'config', 'filter.shout.clean', 'tr a-z A-Z');
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=shout\n');

  // the hook does run when git is left to itself, so the check below means something
  const control = path.join(tmp('control-index'), 'index');
  execFileSync('git', ['-C', repo, 'add', '-A'], {
    env: { ...process.env, GIT_INDEX_FILE: control },
  });
  if (!existsSync(marker)) {
    return; // this git doesn't run post-index-change, so there is nothing to keep out
  }
  rmSync(marker);

  await runHook(home, prompt(repo));
  assert.equal(existsSync(marker), false, 'the snapshot ran the repo’s post-index-change hook');
  const [line] = spoolLines(home);
  assert.equal(git(repo, 'show', `${line.tree}:new.txt`), 'ABC', 'the clean filter ran');
});

test('lines read again from the start do not make reversed or second turns', async () => {
  const home = tmp('spool-replay');
  const repo = checkout();
  const start = Date.now() - 600000;
  const lines = [
    stamped(repo, 'prompt', 'one\n', start),
    stamped(repo, 'stop', 'two\n', start, -1000),
    stamped(repo, 'prompt', 'three\n', start, -5000), // a prompt still open at the end of the file
  ];
  for (const line of lines) {
    append(home, line);
  }
  const first = reader(home);
  await first.spool.drain();
  assert.equal(first.turns.all().length, 1);
  const open = { ...first.spool.state.open };
  assert.equal(Object.keys(open).length, 1);

  // the bridge died between renaming the file and saving its place: an .old file and no mention of it in the state
  renameSync(spoolFile(home), path.join(home, 'turns', 'incoming.1700000000000.old'));
  const second = reader(home);
  await second.spool.drain();
  assert.equal(second.made.length, 0, 'read again, the lines make nothing new (nothing reversed)');
  assert.equal(second.turns.all().length, 1);
  assert.deepEqual(second.spool.state.open, open, 'and the prompt still open is still open');
  assert.equal(second.spool.state.rotated, null, 'the old file was read and removed');
  assert.equal(
    readdirSync(path.join(home, 'turns')).some((name) => name.endsWith('.old')),
    false,
  );
  // the Stop that closes it arrives in the new file
  append(home, stamped(repo, 'stop', 'four\n', start, -9000));
  await second.spool.drain();
  assert.equal(second.made.length, 1);
  assert.equal(second.turns.all().length, 2);
  assert.equal(second.made[0].base_tree, treeOf(repo, 'three\n'));

  // a spool that shrank (emptied, replaced) starts the pairing over: what is in it is paired with itself
  const third = reader(tmp('spool-replay-2'));
  append(third.home, stamped(repo, 'prompt', 'one\n', start));
  append(third.home, stamped(repo, 'prompt', 'two\n', start, -2000)); // a stopped turn
  append(third.home, stamped(repo, 'prompt', 'five\n', start, -4000)); // open
  await third.spool.drain();
  assert.equal(third.turns.all().length, 2);
  assert.equal(third.spool.state.offset, statSync(spoolFile(third.home)).size);
  writeFileSync(
    spoolFile(third.home),
    JSON.stringify(stamped(repo, 'prompt', 'one\n', start)) + '\n',
  );
  await third.spool.drain();
  assert.equal(
    third.made.length,
    2,
    'the first prompt of the new file is not paired with the old end',
  );
  assert.equal(third.turns.all().length, 2);
  assert.deepEqual(Object.keys(third.spool.state.open).length, 1);
});

test('a held Stop in a rotated file holds the main spool too, so records pair in the order they were written', async () => {
  const home = tmp('spool-rotated-hold');
  const repo = checkout();
  const clock = Date.now();
  const dir = path.join(home, 'turns');
  mkdirSync(dir, { recursive: true });
  // the retired file: a prompt and a Stop that is too new to read yet. The main file: the next prompt and its Stop.
  const old = [
    stamped(repo, 'prompt', 'one\n', clock, 60000),
    stamped(repo, 'stop', 'two\n', clock, 1000),
  ];
  writeFileSync(
    path.join(dir, 'incoming.1.old'),
    old.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  append(home, stamped(repo, 'prompt', 'three\n', clock, 500));
  append(home, stamped(repo, 'stop', 'four\n', clock, 0));
  writeFileSync(
    path.join(home, 'turn-spool.json'),
    JSON.stringify({
      offset: 0,
      open: {},
      last: {},
      rotated: { name: 'incoming.1.old', offset: 0, at: clock },
    }),
  );
  let now = clock;
  const run = reader(home, { settleMs: 5000, now: () => now });
  await run.spool.drain();
  assert.equal(run.made.length, 0, 'the Stop in the old file is not old enough');
  assert.equal(run.spool.state.offset, 0, 'so the main file waits behind it');
  assert.equal(Object.keys(run.spool.state.open).length, 1);
  now += 6000;
  await run.spool.drain();
  assert.deepEqual(
    run.made.map((turn) => [turn.base_tree, turn.head_tree]),
    [
      [treeOf(repo, 'one\n'), treeOf(repo, 'two\n')],
      [treeOf(repo, 'three\n'), treeOf(repo, 'four\n')],
    ],
    'the old file’s turn, then the main file’s; not a stopped turn from the one to the other',
  );
  assert.equal(
    run.made.some((turn) => turn.interrupted),
    false,
  );
});

test('only one bridge reads a home’s spool: a second logs it and stays off, and a dead one’s lock is taken over', async () => {
  const home = tmp('spool-lock');
  const repo = checkout();
  const start = Date.now() - 600000;
  append(home, stamped(repo, 'prompt', 'one\n', start));
  append(home, stamped(repo, 'stop', 'two\n', start, -1000));
  const first = reader(home);
  const second = reader(home);
  first.spool.start();
  second.spool.start();
  try {
    assert.equal(first.logs.length, 0);
    assert.match(
      second.logs.join('\n'),
      /already reads this home's spool, so this one leaves it alone/,
    );
    await second.spool.drain();
    assert.equal(second.made.length, 0, 'the second reader reads nothing');
    assert.equal(second.spool.state.offset, 0, 'and keeps no place');
    await first.spool.drain();
    assert.equal(first.made.length, 1);
    second.spool.stop(); // leaves the first one's lock alone
    assert.equal(
      readFileSync(path.join(home, 'turn-spool.lock'), 'utf8').trim(),
      String(process.pid),
    );
  } finally {
    first.spool.stop();
    second.spool.stop();
  }
  assert.equal(
    existsSync(path.join(home, 'turn-spool.lock')),
    false,
    'the lock goes with the reader',
  );

  // another process holding the lock
  writeFileSync(path.join(home, 'turn-spool.lock'), `${process.ppid}\n`);
  const blocked = reader(home);
  blocked.spool.start();
  assert.match(blocked.logs.join('\n'), new RegExp(`pid ${process.ppid}`));
  blocked.spool.stop();
  assert.equal(
    readFileSync(path.join(home, 'turn-spool.lock'), 'utf8').trim(),
    String(process.ppid),
  );

  // a lock left by a bridge that is gone
  writeFileSync(path.join(home, 'turn-spool.lock'), `${spawnSync('true').pid}\n`);
  const taken = reader(home);
  taken.spool.start();
  try {
    assert.equal(taken.logs.length, 0, taken.logs.join('\n'));
    assert.equal(
      readFileSync(path.join(home, 'turn-spool.lock'), 'utf8').trim(),
      String(process.pid),
    );
  } finally {
    taken.spool.stop();
  }
});

test('a Stop stamped in the future does not hold up the spool', async () => {
  const home = tmp('spool-future');
  const repo = checkout();
  const clock = Date.now();
  append(home, stamped(repo, 'prompt', 'one\n', clock, 60000));
  // a clock that was an hour wrong, or years
  append(home, stamped(repo, 'stop', 'two\n', clock, -3600000));
  append(home, stamped(repo, 'prompt', 'three\n', clock, 50000, 'sess-2'));
  append(home, stamped(repo, 'stop', 'four\n', clock, -10 * 365 * 86400000, 'sess-2'));
  const run = reader(home, { settleMs: 2000, now: () => clock });
  await run.spool.drain();
  assert.equal(run.made.length, 2, 'both Stops were read right away');
  assert.equal(run.spool.state.offset, statSync(spoolFile(home)).size);
  // a Stop only a moment ahead still waits its settle time
  append(home, stamped(repo, 'prompt', 'five\n', clock, 5000, 'sess-3'));
  append(home, stamped(repo, 'stop', 'six\n', clock, -1000, 'sess-3'));
  await run.spool.drain();
  assert.equal(run.made.length, 2);
});
