/**
 * `agent start --self` (a parent session registers its own work under a fresh run name `self-XXXXXX`, its sid from the
 * environment), `state|beat|finish --self` (the session's newest open self run), and `card status ID`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp } from './helpers.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

const SID = 'abcdef01';
const env = { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` };
const agent = (home: string, ...args: string[]) => runCli(home, ['agent', ...args], env);
const cardCmd = (home: string, ...args: string[]) => runCli(home, ['card', ...args], env);
const agentsFile = (home: string) => path.join(home, 'agents.jsonl');

function startedCard(home: string, branch = 'feat/x', repo = 'acme/widgets') {
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A job', repo });
  store.start(item.id, { branch, repo });
  return item.id;
}

/** The run name a `--self` start printed: `<sid8>:self-XXXXXX r_...`. */
const nameOf = (stdout: string) => stdout.trim().split(' ')[0].split(':')[1];

test('--self registers the session under its sid with a fresh name, claims the card for it, and a second start lands on its own card', async () => {
  const home = tmp('self-start');
  const first = startedCard(home);
  const second = startedCard(home, 'feat/y');
  const one = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--card',
    first,
    '--task',
    'build',
  );
  assert.equal(one.code, 0, one.stderr);
  const oneName = nameOf(one.stdout);
  assert.match(oneName, /^self-[0-9a-f]{6}$/);
  assert.ok(one.stdout.startsWith(`${SID}:self-`), one.stdout);
  const store = new BacklogStore(home);
  assert.equal(
    new AgentRegistry(home).agents().find((run) => run.name === oneName)?.session,
    env.CLAUDE_CODE_SESSION_ID,
    'the run records the session; no claim row is written',
  );
  assert.equal(readFileSync(store.file, 'utf8').includes('"op":"claim"'), false);
  const two = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--card',
    second,
    '--task',
    'build 2',
  );
  assert.equal(two.code, 0, two.stderr);
  const twoName = nameOf(two.stdout);
  assert.notEqual(twoName, oneName);
  const runs = new AgentRegistry(home).agents();
  const byName = (name: string) => runs.find((run) => run.name === name);
  assert.equal(byName(oneName)?.card, first);
  assert.equal(byName(twoName)?.card, second);
  assert.equal(byName(oneName)?.kind, 'author');
  assert.equal(byName(oneName)?.sid, SID);
  assert.equal(byName(oneName)?.state, 'running');
});

test('finish --self --commit puts the card in Waiting, then Ready for your review once its critic is skipped, and card status prints the row', async () => {
  const home = tmp('self-finish');
  const id = startedCard(home);
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  assert.equal((await agent(home, 'beat', '--self', '1/2', 'code', 'going')).code, 0);
  assert.equal(
    (await agent(home, 'state', '--self', '--state', 'waiting', '--outcome', 'q?')).code,
    0,
  );
  assert.equal((await agent(home, 'state', '--self', '--state', 'running')).code, 0);
  const before = await cardCmd(home, 'status', id);
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /column: Working/);
  assert.match(before.stdout, /rule: 1 /);
  const done = await agent(
    home,
    'finish',
    '--self',
    '--state',
    'done',
    '--commit',
    'abc1234def',
    '--branch',
    'feat/x',
    '--card',
    id,
  );
  assert.equal(done.code, 0, done.stderr);
  const waiting = await cardCmd(home, 'status', id);
  assert.match(waiting.stdout, /column: Waiting/);
  assert.match(waiting.stdout, /rule: 5 /);
  const skip = await runCli(home, ['backlog', 'skip-critic', id], env);
  assert.equal(skip.code, 0, skip.stderr);
  assert.match(skip.stdout, /critic skipped/);
  const status = await cardCmd(home, 'status', id);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /column: Ready for your review/);
  assert.match(status.stdout, /rule: 6 /);
  assert.match(status.stdout, /phase\.ts/);
  assert.match(status.stdout, /self-[0-9a-f]{6}/);
  const json = JSON.parse((await cardCmd(home, 'status', id, '--json')).stdout);
  assert.equal(json.column, 'ready');
  assert.equal(json.row, '6');
  assert.equal(json.runs.length, 1);
  const missing = await cardCmd(home, 'status', 'bl_nope');
  assert.notEqual(missing.code, 0);
});

test("every repo's built card waits in Waiting (rule 5) until a critic has passed or the skip is recorded", async () => {
  const home = tmp('self-hold');
  const id = startedCard(home, 'feat/x', 'shank-eric/once-upon-a-diff');
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  assert.equal(
    (await agent(home, 'finish', '--self', '--state', 'done', '--commit', 'abc1234def')).code,
    0,
  );
  const status = await cardCmd(home, 'status', id);
  assert.match(status.stdout, /column: Waiting/);
  assert.match(status.stdout, /rule: 5 /);
  // the same in a repo with another name, and the skip can be taken back
  const other = startedCard(home, 'feat/y', 'acme/widgets');
  await agent(home, 'start', '--self', '--role', 'author', '--card', other, '--task', 'b');
  await agent(home, 'finish', '--self', '--state', 'done', '--commit', 'abc1234def');
  assert.match((await cardCmd(home, 'status', other)).stdout, /rule: 5 /);
  await runCli(home, ['backlog', 'skip-critic', other], env);
  assert.match((await cardCmd(home, 'status', other)).stdout, /rule: 6 /);
  await runCli(home, ['backlog', 'skip-critic', other, '--off'], env);
  assert.match((await cardCmd(home, 'status', other)).stdout, /rule: 5 /);
});

test('--self refusals each name their cause and write nothing', async () => {
  const home = tmp('self-refusals');
  const id = startedCard(home);
  const cases: Array<[string[], RegExp]> = [
    [
      ['start', 'a-name', '--self', '--role', 'author', '--card', id, '--task', 't'],
      /--self .*takes no NAME/,
    ],
    [
      ['start', '--self', '--sid', 'abcdef02', '--role', 'author', '--card', id, '--task', 't'],
      /--self .*--sid/,
    ],
    [['start', '--self', '--kind', 'author', '--card', id, '--task', 't'], /--self .*--kind/],
    [
      ['start', '--self', '--role', 'critic', '--card', id, '--task', 't'],
      /--role author, research or helper/,
    ],
    [['start', '--self', '--card', id, '--task', 't'], /--role author, research or helper/],
    [
      ['start', 'self-ab12cd', '--role', 'author', '--card', id, '--task', 't'],
      /register it with agent start --self/,
    ],
    [['start', '--self', '--role', 'author', '--task', 't'], /--branch/],
  ];
  for (const [args, message] of cases) {
    const result = await agent(home, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
  assert.equal(existsSync(agentsFile(home)), false);
  const noSession = await runCli(
    home,
    ['agent', 'start', '--self', '--role', 'research', '--task', 't'],
    {
      CLAUDE_CODE_SESSION_ID: '',
    },
  );
  assert.notEqual(noSession.code, 0);
  assert.match(noSession.stderr, /CLAUDE_CODE_SESSION_ID/);
  const none = await agent(home, 'finish', '--self');
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /no open self run/);
});

test('a card another session’s author is running is refused by the open-author check; once that run is finished it is taken', async () => {
  const home = tmp('self-claimed');
  const id = startedCard(home);
  const theirs = await runCli(
    home,
    ['agent', 'start', '--self', '--role', 'author', '--card', id, '--task', 't'],
    otherEnv,
  );
  assert.equal(theirs.code, 0, theirs.stderr);
  const refused = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--card',
    id,
    '--task',
    't',
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /already has an open author run/);
  assert.equal(new AgentRegistry(home).agents().length, 1);
  assert.equal(
    (await runCli(home, ['agent', 'finish', '--self', '--state', 'done'], otherEnv)).code,
    0,
  );
  const taken = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--card',
    id,
    '--task',
    't',
  );
  assert.equal(taken.code, 0, taken.stderr);
});

test('a session that finished one card starts the next on a card of its own: research mints an implicit card, an author on --branch another', async () => {
  const home = tmp('self-sequence');
  const id = startedCard(home);
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  assert.equal(
    (await agent(home, 'finish', '--self', '--state', 'done', '--commit', 'abc1234def')).code,
    0,
  );
  const research = await agent(home, 'start', '--self', '--role', 'research', '--task', 'look');
  assert.equal(research.code, 0, research.stderr);
  const implicit = research.stdout.trim().split(' ')[2];
  assert.match(implicit, /^bl_/);
  assert.equal((await agent(home, 'finish', '--self', '--state', 'done')).code, 0);
  const coded = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--branch',
    'feat/other',
    '--task',
    'b2',
  );
  assert.equal(coded.code, 0, coded.stderr);
  const other = coded.stdout.trim().split(' ')[2];
  assert.match(other, /^bl_/);
  assert.notEqual(other, implicit);
  // two --self runs open: state names the newest, --run picks one
  const runs = new AgentRegistry(home).agents();
  assert.equal(runs.filter((run) => run.name.startsWith('self-')).length, 3);
  assert.equal(runs.find((run) => run.name === nameOf(research.stdout))?.card, implicit);
});

const OTHER = 'abcdef09';
const otherEnv = { CLAUDE_CODE_SESSION_ID: `${OTHER}-1111-4222-8333-444444444444` };

/** This home's own Claude Code session registry, so no test sees another's sessions. */
function sessionsOf(home: string) {
  const dir = tmp('self-sessions');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ board_sessions_dir: dir }));
  return dir;
}

/** A live Claude Code session in the registry the CLI reads: this test's own pid is a running process. */
function liveSession(dir: string, sessionId: string) {
  writeFileSync(
    path.join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, cwd: '/tmp', status: 'idle' }),
  );
}

test('a self run whose session is gone is closed as stopped by the next start, and a new session takes the card', async () => {
  const home = tmp('self-gone');
  const dir = sessionsOf(home);
  const id = startedCard(home);
  const first = await agent(
    home,
    'start',
    '--self',
    '--role',
    'author',
    '--card',
    id,
    '--task',
    'b',
  );
  assert.equal(first.code, 0, first.stderr);
  const firstName = nameOf(first.stdout);
  liveSession(dir, `${OTHER}-1111-4222-8333-444444444444`);
  const second = await runCli(
    home,
    ['agent', 'start', '--self', '--role', 'author', '--card', id, '--task', 'again'],
    otherEnv,
  );
  assert.equal(second.code, 0, second.stderr);
  const runs = new AgentRegistry(home).agents();
  const old = runs.find((run) => run.name === firstName);
  assert.equal(old?.state, 'stopped');
  assert.equal(old?.outcome, 'its session ended');
  const mine = runs.find((run) => run.name === nameOf(second.stdout));
  assert.equal(mine?.state, 'running');
});

test('card status closes a gone session’s self run first, so it does not say Working', async () => {
  const home = tmp('self-gone-status');
  const dir = sessionsOf(home);
  const id = startedCard(home);
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  liveSession(dir, `${OTHER}-1111-4222-8333-444444444444`);
  const status = await cardCmd(home, 'status', id);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /stopped/);
  assert.doesNotMatch(status.stdout, /column: Working/);
});

test('an empty session scan closes nothing, so the old run stays open and a new --self is refused', async () => {
  const home = tmp('self-empty-scan');
  sessionsOf(home);
  const id = startedCard(home);
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  const second = await runCli(
    home,
    ['agent', 'start', '--self', '--role', 'author', '--card', id, '--task', 'again'],
    otherEnv,
  );
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already has an open author run \(\w+:self-/);
  assert.equal(new AgentRegistry(home).agents()[0]?.state, 'running');
});

test('a session file that cannot be read, whose pid runs, means the sweep closes nothing', async () => {
  const home = tmp('self-unknown-file');
  const dir = sessionsOf(home);
  const id = startedCard(home);
  assert.equal(
    (await agent(home, 'start', '--self', '--role', 'author', '--card', id, '--task', 'b')).code,
    0,
  );
  liveSession(dir, `${OTHER}-1111-4222-8333-444444444444`);
  // a second file, half-written, of a process that runs: that session may be the old one, so it is unknown, not gone
  writeFileSync(path.join(dir, `${process.ppid}.json`), '{"pid": 1, "sessionId": "abcdef0');
  const swept = await runCli(home, ['agent', 'sweep']);
  assert.equal(swept.code, 0, swept.stderr);
  assert.equal(new AgentRegistry(home).agents()[0]?.state, 'running');
});
