/*
 * `once-upon doctor --fix` (core/src/orchestration/bridge/compact-logs.ts): agents.jsonl and inbox.jsonl rewritten smaller, the
 * old ones kept, and what the board reads from them unchanged. A plain doctor writes nothing. It also folds a story's old
 * reviewed.json and approved.json into review.json (convert-review-files.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmp, runCli, writeJson } from './helpers.ts';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { recordedTips } from '@once-upon-a-diff/state/queues/backlog/landing';
import { agentEventsIn } from '@once-upon-a-diff/state/records/agents/events-file';

const DAY = 24 * 3600 * 1000;
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * DAY + hours * 3600_000).toISOString();

const row = (
  kind: string,
  name: string,
  run: string,
  time: string,
  more: Record<string, unknown> = {},
) =>
  JSON.stringify({
    op: kind,
    v: 1,
    id: `abcd1234:${name}`,
    sid8: 'abcd1234',
    name,
    run,
    at: time,
    ...more,
  }) + '\n';

/** A home with one card landed 35 days ago, one open card, an old run on each, a recent run, and old and new reads. */
function build() {
  const home = tmp('doctor-fix');
  const backlog = new BacklogStore(home);
  const landed = backlog.add({ title: 'landed card' });
  backlog.start(landed.id, { branch: 'landed-branch' });
  backlog.done(landed.id, { sha: 'abc1234', mergedAt: ago(35) });
  const open = backlog.add({ title: 'open card' });
  backlog.start(open.id, { branch: 'open-branch' });
  const rows = [
    row('start', 'old-landed', 'r_0000000001', ago(41), {
      kind: 'author',
      task: 't',
      card: landed.id,
    }),
    ...[1, 2, 3].map((count) =>
      row('beat', 'old-landed', 'r_0000000001', ago(41, count), { n: count, of: 5, step: 'code' }),
    ),
    row('finish', 'old-landed', 'r_0000000001', ago(40), {
      state: 'done',
      result: { commit: 'abc1234', card: landed.id },
    }),
    row('start', 'old-open', 'r_0000000002', ago(41), { kind: 'author', task: 't', card: open.id }),
    ...[1, 2, 3].map((count) =>
      row('beat', 'old-open', 'r_0000000002', ago(41, count), { n: count, of: 5, step: 'code' }),
    ),
    row('finish', 'old-open', 'r_0000000002', ago(40), {
      state: 'done',
      result: { commit: 'def5678', card: open.id },
    }),
    row('start', 'now', 'r_0000000003', ago(0, -2), { kind: 'helper', task: 't' }),
    ...[1, 2, 3].map((count) =>
      row('beat', 'now', 'r_0000000003', ago(0, -1), { n: count, of: 5, step: 'code' }),
    ),
  ];
  writeFileSync(path.join(home, 'agents.jsonl'), rows.join(''));
  const inbox = new Inbox(home);
  inbox.append({ type: 'question', story: 's', text: 'q1', at: ago(40) });
  appendFileSync(
    inbox.file,
    JSON.stringify({
      type: 'read',
      id: 'rd_1',
      at: ago(35),
      story: 's',
      chapter: 'c',
      reason: 'time',
    }) + '\n',
  );
  inbox.append({ type: 'question', story: 's', text: 'q2', at: ago(1) });
  inbox.setCursor('l', Buffer.byteLength(readFileSync(inbox.file, 'utf8')));
  return { home, landed, open, inbox };
}
const run = async (home: string, options: { fix?: boolean; keepDays?: number } = {}) => {
  const lines: string[] = [];
  await doctor(home, { token: 't', port: 1 }, { out: (line) => lines.push(line), ...options });
  return lines;
};
const board = (home: string) =>
  JSON.stringify({ agents: readAgents(home), cards: new BacklogStore(home).items() });
const files = (home: string) =>
  readdirSync(home)
    .filter((name) => /\.jsonl$/.test(name))
    .sort();

test('plain doctor changes no file', async () => {
  const { home } = build();
  const before = files(home).map((name) => [
    name,
    readFileSync(path.join(home, name), 'utf8'),
    statSync(path.join(home, name)).mtimeMs,
  ]);
  await run(home);
  assert.deepEqual(
    files(home).map((name) => [
      name,
      readFileSync(path.join(home, name), 'utf8'),
      statSync(path.join(home, name)).mtimeMs,
    ]),
    before,
  );
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith('.bak')),
    [],
  );
});

test('doctor --fix drops the old run on the landed card and the old read, keeps the old files, and the board reads the same', async () => {
  const { home, landed, open, inbox } = build();
  const oldAgents = readFileSync(path.join(home, 'agents.jsonl'), 'utf8');
  const oldInbox = readFileSync(inbox.file, 'utf8');
  const before = readAgents(home).agents;
  const lines = await run(home, { fix: true });
  assert.ok(
    lines.some((line) => /^PASS\s+Logs: agents\.jsonl .* -> .*inbox\.jsonl/.test(line)),
    lines.join('\n'),
  );
  const names = readAgents(home).agents.map((agent) => agent.name);
  assert.deepEqual(names.sort(), ['now', 'old-open']);
  // what stays reads the same
  const same = (name: string) =>
    JSON.stringify(readAgents(home).agents.find((agent) => agent.name === name));
  assert.equal(same('old-open'), JSON.stringify(before.find((agent) => agent.name === 'old-open')));
  assert.equal(same('now'), JSON.stringify(before.find((agent) => agent.name === 'now')));
  // the old logs are kept as they were
  const baks = readdirSync(home).filter((name) => name.endsWith('.bak'));
  assert.equal(baks.length, 2);
  assert.equal(
    readFileSync(
      path.join(
        home,
        baks.find((name) => name.startsWith('agents'))!,
      ),
      'utf8',
    ),
    oldAgents,
  );
  assert.equal(
    readFileSync(
      path.join(
        home,
        baks.find((name) => name.startsWith('inbox'))!,
      ),
      'utf8',
    ),
    oldInbox,
  );
  // a deploy still finds the open card's commit, and the cards are as they were
  assert.equal(
    recordedTips(agentEventsIn(path.join(home, 'agents.jsonl'))).get(open.id),
    'def5678',
  );
  assert.equal(
    new BacklogStore(home).items().find((card) => card.id === landed.id)?.landed_sha,
    'abc1234',
  );
  // the inbox kept the questions, lost the read, and the listener at the end is still at the end
  assert.deepEqual(
    new Inbox(home).all().map((entry) => entry.type),
    ['question', 'question'],
  );
  assert.deepEqual(inbox.unread('l'), []);
  inbox.append({ type: 'question', story: 's', text: 'q3' });
  assert.equal(inbox.unread('l').length, 1);
});

test('doctor --fix twice, and with nothing old, drops nothing more and keeps no second copy', async () => {
  const { home } = build();
  await run(home, { fix: true });
  const once = board(home);
  const lines = await run(home, { fix: true });
  assert.equal(board(home), once);
  assert.ok(
    lines.some((line) =>
      /Logs: nothing in agents\.jsonl, backlog\.jsonl or inbox\.jsonl to drop/.test(line),
    ),
  );
  assert.equal(readdirSync(home).filter((name) => name.endsWith('.bak')).length, 2);
});

test('--keep-days keeps what is newer; the command takes --fix and --keep-days', async () => {
  const { home } = build();
  const result = await runCli(home, ['doctor', '--port', '1', '--fix', '--keep-days', '45']);
  assert.match(
    result.stdout,
    /Logs: agents\.jsonl [\d.]+ MB -> [\d.]+ MB/,
    'the extra beats still go',
  );
  assert.match(result.stdout, /inbox\.jsonl [\d.]+ MB ->/, 'a read goes whatever its age');
  assert.equal(readAgents(home).agents.length, 3, 'nothing is 45 days old');
  const bad = await runCli(home, ['doctor', '--port', '1', '--fix', '--keep-days', 'soon']);
  assert.notEqual(bad.code, 0);
  const real = await runCli(home, ['doctor', '--port', '1', '--fix']);
  assert.match(real.stdout, /Logs: agents\.jsonl/);
  assert.equal(readAgents(home).agents.length, 2);
});

test('a plain doctor warns about a big log and names the fix', async () => {
  const home = tmp('doctor-fix');
  writeFileSync(path.join(home, 'agents.jsonl'), row('beat', 'x', 'r_1', ago(1)).repeat(36000));
  const lines = await run(home);
  assert.ok(
    lines.some((line) => /^WARN\s+Logs: agents\.jsonl \d\.\d\d MB/.test(line)),
    lines.join('\n'),
  );
  assert.ok(lines.some((line) => /fix: Run: once-upon compact/.test(line)));
});

test('doctor says when a story still has the old review files, and --fix folds them into review.json', async () => {
  const home = tmp('doctor-fix');
  const state = path.join(home, 'state', 's1');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'reviewed.json'), JSON.stringify({ at: ago(2), by: 'review' }));
  const plain = (await run(home)).join('\n');
  assert.match(plain, /WARN\s+Review files: 1 stories still have reviewed\.json/);
  assert.match(plain, /fix: Run: once-upon doctor --fix/);
  assert.ok(existsSync(path.join(state, 'reviewed.json')), 'a plain doctor writes nothing');
  const fixed = (await run(home, { fix: true })).join('\n');
  assert.match(fixed, /PASS\s+Review files: 1 stories' reviewed\.json and approved\.json folded/);
  assert.equal(existsSync(path.join(state, 'reviewed.json')), false);
  assert.equal(JSON.parse(readFileSync(path.join(state, 'review.json'), 'utf8')).mark.by, 'review');
  assert.match((await run(home, { fix: true })).join('\n'), /Review files: no story has/);
  assert.doesNotMatch((await run(home)).join('\n'), /Review files/);
});

/** Stored cards of agents and sessions, old and new, with the facts a run or a story would give them. */
function storedHome() {
  const home = tmp('doctor-fix-stored');
  const file = path.join(home, 'backlog.jsonl');
  const line = (event: Record<string, unknown>) => JSON.stringify({ by: 'test', ...event }) + '\n';
  const add = (id: string, days: number, more: Record<string, unknown> = {}) =>
    line({
      op: 'add',
      id,
      title: id,
      note: null,
      repo: null,
      branch: null,
      at: ago(days),
      ...more,
    });
  writeFileSync(
    file,
    [
      add('bl_listed0', 60),
      add('ic_oldidle0', 40, { source: 'agent' }),
      line({ op: 'link', id: 'ic_oldidle0', branch: 'old-branch', at: ago(39) }),
      add('ic_oldnamed', 40, { source: 'agent' }),
      add('ic_recent00', 1, { source: 'session' }),
    ].join(''),
  );
  writeFileSync(
    path.join(home, 'agents.jsonl'),
    row('start', 'on-old', 'r_0000000009', ago(1), {
      kind: 'author',
      task: 't',
      card: 'ic_oldnamed',
    }),
  );
  return { home, file };
}

test('doctor --fix drops an old stored card no run names, keeps the rest, and the listed cards read the same', async () => {
  const { home, file } = storedHome();
  const store = new BacklogStore(home);
  const listedBefore = JSON.stringify(store.listed());
  assert.equal(store.items().length, 4);
  const lines = await run(home, { fix: true });
  assert.ok(
    lines.some((line) => /^PASS\s+Logs: backlog\.jsonl .* -> /.test(line)),
    lines.join('\n'),
  );
  // the reader that already parsed the file starts over on the new one
  assert.deepEqual(
    store.items().map((card) => card.id),
    ['bl_listed0', 'ic_oldnamed', 'ic_recent00'],
  );
  assert.equal(JSON.stringify(store.listed()), listedBefore);
  assert.equal(
    readdirSync(home).filter((name) => /^backlog\.jsonl\..*\.bak$/.test(name)).length,
    1,
  );
  assert.ok(readFileSync(file, 'utf8').includes('bl_listed0'));
  // a second run drops nothing and keeps no second copy
  const again = await run(home, { fix: true });
  assert.ok(again.some((line) => /nothing in agents\.jsonl, backlog\.jsonl/.test(line)));
  assert.equal(readdirSync(home).filter((name) => name.endsWith('.bak')).length, 1);
});

test('doctor --fix keeps the idle card of a session that is still running, and drops the one of a session that is gone', async () => {
  const { home, file } = storedHome();
  const liveId = '11111111-2222-4333-8444-555555555555';
  const goneId = '99999999-2222-4333-8444-555555555555';
  appendFileSync(
    file,
    [
      { id: 'ic_livesess0', session: liveId },
      { id: 'ic_gonesess0', session: goneId },
    ]
      .map(
        (one) =>
          JSON.stringify({
            op: 'add',
            ...one,
            title: one.id,
            note: null,
            repo: null,
            branch: null,
            source: 'session',
            by: 'test',
            at: ago(40),
          }) + '\n',
      )
      .join(''),
  );
  const sessions = tmp('doctor-fix-sessions');
  // this test process is the running session: its pid is alive
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: liveId,
    cwd: home,
  });
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  await run(home, { fix: true });
  const kept = new BacklogStore(home).items().map((card) => card.id);
  assert.ok(kept.includes('ic_livesess0'), kept.join(' '));
  assert.ok(!kept.includes('ic_gonesess0'), kept.join(' '));
  assert.ok(!kept.includes('ic_oldidle0'));
});

test('doctor --fix with no session registry to trust keeps every idle session card', async () => {
  const { home, file } = storedHome();
  appendFileSync(
    file,
    JSON.stringify({
      op: 'add',
      id: 'ic_sessnoreg',
      session: '99999999-2222-4333-8444-555555555555',
      title: 'x',
      note: null,
      repo: null,
      branch: null,
      source: 'session',
      by: 'test',
      at: ago(40),
    }) + '\n',
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: path.join(home, 'no-such-registry'),
  });
  await run(home, { fix: true });
  const kept = new BacklogStore(home).items().map((card) => card.id);
  assert.ok(kept.includes('ic_sessnoreg'), kept.join(' '));
});

test('doctor --fix keeps a half-written last line of backlog.jsonl and a card made after it', async () => {
  const { home, file } = storedHome();
  appendFileSync(file, '{"op":"add","id":"ic_halfline');
  await run(home, { fix: true });
  assert.ok(readFileSync(file, 'utf8').endsWith('{"op":"add","id":"ic_halfline'));
  const store = new BacklogStore(home);
  appendFileSync(file, '0","title":"x","by":"test","at":"2026-11-18T00:00:00.000Z"}\n');
  assert.ok(store.items().some((card) => card.id === 'ic_halfline0'));
});
