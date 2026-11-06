/**
 * The ADR-25 flip: a run's `card` is the only link between a card and its runs. A run on a card takes its repo and branch from the
 * card (the flags that say otherwise are refused), an author needs its card claimed first or a branch to name its own card, a
 * lane tag is read by nothing, and the claim-to-run guessing is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp } from './helpers.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import * as claims from '@once-upon-a-diff/state/queues/backlog/claims';
import * as phase from '@once-upon-a-diff/state/queues/backlog/phase';
import * as backlogQueue from '@once-upon-a-diff/state/queues/backlog/backlog';
import * as laneKey from '@once-upon-a-diff/terms/lane-key';

const SID = 'abcdef01';
const env = { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` };
const agent = (home: string, ...args: string[]) => runCli(home, ['agent', ...args], env);
const agentsFile = (home: string) => path.join(home, 'agents.jsonl');

/** A started card (repo and branch) and, when asked, its claim for `name`. */
function card(home: string, branch: string | null, claimFor: string | null = null) {
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A job', repo: 'acme/widgets' });
  if (branch) {
    store.start(item.id, { branch, repo: 'acme/widgets' });
  }
  if (claimFor) {
    store.claim(item.id, { agent: claimFor, sid: SID });
  }
  return item.id;
}

test('beside --card the flags the card answers are refused, each named, and nothing is written', async () => {
  const home = tmp('flip-refusals');
  const id = card(home, 'feat/x', 'ou-a');
  const typed = await agent(
    home,
    'start',
    'ou-a',
    '--card',
    id,
    '--role',
    'author',
    '--repo',
    'acme/widgets',
    '--branch',
    'feat/x',
    '--pr',
    '7',
    '--lane',
    'widgets',
    '--task',
    'build',
  );
  assert.notEqual(typed.code, 0);
  for (const flag of ['--repo', '--branch', '--pr', '--lane']) {
    assert.match(typed.stderr, new RegExp(`${flag}[ ,]`), flag);
  }
  assert.match(typed.stderr, /not taken with --card/);
  const kind = await agent(home, 'start', 'ou-a', '--card', id, '--kind', 'author', '--task', 'b');
  assert.notEqual(kind.code, 0);
  assert.match(kind.stderr, /--kind is not taken with --card/);
  const slots = await agent(home, 'start', 'ou-a', '--card', id, '--slots', '3', '--task', 'b');
  assert.notEqual(slots.code, 0);
  assert.match(slots.stderr, /--slots/);
  assert.equal(existsSync(agentsFile(home)), false, 'a refused start writes no row');
});

test('a card with no branch still takes --branch from the run, and --pr only while it has no branch', async () => {
  const home = tmp('flip-no-branch');
  const id = card(home, null, 'ou-a');
  const done = await agent(
    home,
    'start',
    'ou-a',
    '--card',
    id,
    '--role',
    'author',
    '--branch',
    'feat/y',
    '--task',
    'build',
  );
  assert.equal(done.code, 0, done.stderr);
  const withBranch = card(home, 'feat/z', 'ou-b');
  const pr = await agent(
    home,
    'start',
    'ou-b',
    '--card',
    withBranch,
    '--role',
    'author',
    '--pr',
    '7',
    '--task',
    'build',
  );
  assert.notEqual(pr.code, 0);
  assert.match(pr.stderr, /--pr is not taken with --card/);
});

test('--lane is ignored with a warning when no card is named, and nothing reads it', async () => {
  const home = tmp('flip-lane');
  const done = await agent(
    home,
    'start',
    'a-helper',
    '--kind',
    'helper',
    '--lane',
    'x',
    '--task',
    't',
  );
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /--lane is ignored/);
  const start = new AgentRegistry(home).events().find((one) => one.op === 'start');
  assert.equal(start?.lane ?? null, null);
});

test('an author with no card needs --branch, which mints its implicit card; a fixer needs a card', async () => {
  const home = tmp('flip-cardless');
  const bare = await agent(home, 'start', 'ou-a', '--role', 'author', '--task', 'build');
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--branch/);
  const kind = await agent(home, 'start', 'ou-a', '--kind', 'author', '--task', 'build');
  assert.notEqual(kind.code, 0);
  const fixer = await agent(home, 'start', 'ou-f', '--role', 'fixer', '--task', 'fix');
  assert.notEqual(fixer.code, 0);
  assert.match(fixer.stderr, /fixer works on a card/);
  const named = await agent(
    home,
    'start',
    'ou-a',
    '--role',
    'author',
    '--branch',
    'feat/q',
    '--task',
    'b',
  );
  assert.equal(named.code, 0, named.stderr);
  assert.match(named.stdout.trim().split(' ')[2], /^ic_/);
});

test('an author on a card with no claim is refused: the claim comes first, then the start, then a fix round', async () => {
  const home = tmp('flip-claim-first');
  const id = card(home, 'feat/x');
  const refused = await agent(
    home,
    'start',
    'ou-a',
    '--card',
    id,
    '--role',
    'author',
    '--task',
    'b',
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /has no claim/);
  assert.equal(existsSync(agentsFile(home)), false);
  const claimed = await runCli(
    home,
    ['backlog', 'claim', id, '--agent', 'ou-a', '--sid', SID],
    env,
  );
  assert.equal(claimed.code, 0, claimed.stderr);
  const started = await agent(
    home,
    'start',
    'ou-a',
    '--card',
    id,
    '--role',
    'author',
    '--task',
    'b',
  );
  assert.equal(started.code, 0, started.stderr);
  assert.equal((await agent(home, 'finish', 'ou-a')).code, 0);
  // a fixer is a fresh run on the same card; a restart of the same name stays on it too
  const fixer = await agent(
    home,
    'start',
    'fix-a',
    '--card',
    id,
    '--role',
    'fixer',
    '--task',
    'fix',
  );
  assert.equal(fixer.code, 0, fixer.stderr);
  assert.equal((await agent(home, 'finish', 'fix-a')).code, 0);
  const again = await agent(home, 'start', 'ou-a', '--task', 'second round');
  assert.equal(again.code, 0, again.stderr);
  const cards = new AgentRegistry(home)
    .events()
    .filter((one) => one.op === 'start')
    .map((one) => one.card);
  assert.deepEqual(cards, [id, id, id]);
});

test('backlog adopt claims the card it makes, so the adopted card’s author can start a fix round', async () => {
  const home = tmp('flip-adopt');
  const made = await agent(
    home,
    'start',
    'ou-a',
    '--role',
    'author',
    '--branch',
    'feat/x',
    '--task',
    'b',
  );
  assert.equal(made.code, 0, made.stderr);
  const implicit = made.stdout.trim().split(' ')[2];
  const adopted = await runCli(home, ['backlog', 'adopt', implicit, '--title', 'Adopted'], env);
  assert.equal(adopted.code, 0, adopted.stderr);
  const claim = new BacklogStore(home).items().find((one) => one.id === implicit)?.claim;
  assert.equal(claim?.agent, 'ou-a');
});

test('what the flip deleted is gone: the claim-to-run helpers, the lane resolver and the critic-hold guess', () => {
  const gone = [
    'claimedRun',
    'claimedAgents',
    'holdingRun',
    'criticHold',
    'claimedAgent',
    'agentColumn',
    'heldKeys',
    'resolveLane',
    'repoLanes',
  ];
  for (const mod of [claims, phase, backlogQueue, laneKey]) {
    for (const name of gone) {
      assert.equal(name in mod, false, `${name} is still exported`);
    }
  }
});

test('the relayed fix and approval text starts a new run with --card and no --branch', () => {
  const text = readFileSync(
    path.join(import.meta.dirname, 'fixtures/wait-golden/relay.txt'),
    'utf8',
  );
  const starts = text.match(/agent start [^\n.]*(?:--card <your card>)/g) ?? [];
  assert.ok(starts.length >= 2, 'the relay text names the start step');
  for (const line of starts) {
    assert.equal(line.includes('--branch'), false, line);
  }
});
