/**
 * `once-upon dispatch` and `once-upon handback`, end to end through the CLI: an editor launches an author with one dispatch
 * (no `backlog claim`, no `agent start` typed), the Agent call's arguments and brief come back on stdout, and the author hands
 * back with the line the brief names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, runCli, tmp } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

const SID = 'abcdef01';
const EDITOR = { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` };
// a different session: the subagent's own, whose id is not the run's
const AGENT = { CLAUDE_CODE_SESSION_ID: '99999999-1111-4222-8333-444444444444' };

function world() {
  const home = tmp('dispatch-cli-home');
  const fixture = worktreeFixture();
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A card', note: 'The note.', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat-x', repo: 'acme/widgets' });
  const cli = (args: string[], env: Record<string, string> = EDITOR, cwd = fixture.main) =>
    runCli(home, args, env, cwd);
  const runs = () => new AgentRegistry(home).agents();
  return { home, fixture, store, card: item.id, cli, runs };
}

test('dispatch prints the Agent call first, then the brief, with the run’s name in the beat, heavy and handback lines', async () => {
  const ctx = world();
  const done = await ctx.cli([
    'dispatch',
    ctx.card,
    '--role',
    'author',
    '--check',
    'tests pass',
    '--task',
    'build it',
  ]);
  assert.equal(done.code, 0, done.stderr);
  const [call, blank, ...brief] = done.stdout.split('\n');
  assert.equal(
    call,
    `AGENT-CALL subagent_type=once-upon-author name=feat-x model=sonnet effort=high run_in_background=true description="feat-x: author for ${ctx.card}"`,
  );
  assert.equal(blank, '');
  const text = brief.join('\n');
  for (const line of [
    'once-upon beat feat-x <N>/6',
    'once-upon heavy feat-x <command>',
    `once-upon handback feat-x --sid ${SID} --outcome`,
    'Success check (work until it passes): tests pass',
  ]) {
    assert.ok(text.includes(line), line);
  }
  const [run] = ctx.runs();
  assert.equal(run.name, 'feat-x');
  assert.equal(run.card, ctx.card);
});

test('--json prints the call’s fields and the prompt; an unknown role and a missing card are refused', async () => {
  const ctx = world();
  const done = await ctx.cli([
    'dispatch',
    ctx.card,
    '--role',
    'helper',
    '--task',
    'look',
    '--json',
  ]);
  assert.equal(done.code, 0, done.stderr);
  const call = JSON.parse(done.stdout) as Record<string, unknown>;
  assert.equal(call.name, 'check-feat-x');
  assert.equal(call.subagent_type, 'once-upon-helper');
  assert.equal(call.run_in_background, true);
  assert.match(String(call.prompt), /You are check-feat-x, a helper/);
  const bad = await ctx.cli(['dispatch', ctx.card, '--role', 'boss']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /the role must be one of/);
  const none = await ctx.cli(['dispatch', 'bl_nothere1', '--role', 'critic']);
  assert.match(none.stderr, /no backlog item/);
  const usage = await ctx.cli(['dispatch']);
  assert.match(usage.stderr, /usage: once-upon dispatch CARD --role/);
});

test('long text goes through stdin (--task -)', async () => {
  const ctx = world();
  const task = 'x'.repeat(50) + '\nsecond line';
  const done = await runCli(
    ctx.home,
    ['dispatch', ctx.card, '--role', 'author', '--task', '-', '--check', 'ok'],
    EDITOR,
    ctx.fixture.main,
    task,
  );
  assert.equal(done.code, 0, done.stderr);
  assert.ok(done.stdout.includes(`Task: ${task}`));
});

test('dispatch, then handback from the agent’s own session: the finish row holds the branch tip, the branch and the card', async () => {
  const ctx = world();
  assert.equal(
    (await ctx.cli(['dispatch', ctx.card, '--role', 'author', '--check', 'ok'])).code,
    0,
  );
  const tree = ctx.fixture.add('feat-x');
  ctx.fixture.commit(tree, 'one');
  const tip = git(tree, 'rev-parse', 'HEAD');
  const back = await ctx.cli(['handback', 'feat-x', '--sid', SID, '--outcome', 'built'], AGENT);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /^feat-x finished/);
  const run = ctx.runs().find((one) => one.name === 'feat-x');
  assert.equal(run?.state, 'done');
  assert.deepEqual(run?.result, { commit: tip, branch: 'feat-x', card: ctx.card });
  assert.equal(run?.outcome, 'built');
  // the card's own status reads its runs
  const status = await ctx.cli(['card', 'status', ctx.card]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /feat-x/);
  // handing back twice prints the registry's message
  const twice = await ctx.cli(['handback', 'feat-x', '--sid', SID], AGENT);
  assert.match(twice.stderr, /already finished/);
});

test('handback --plan and --state waiting move the run; critic handback needs --findings', async () => {
  const ctx = world();
  assert.equal((await ctx.cli(['dispatch', ctx.card, '--role', 'author', '--plan'])).code, 0);
  const plan = await ctx.cli(['handback', 'feat-x', '--sid', SID, '--plan'], AGENT);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(ctx.runs()[0].state, 'plan');
  assert.equal(ctx.runs()[0].outcome, 'plan written');
  const ask = await ctx.cli(['handback', 'feat-x', '--sid', SID, '--state', 'waiting'], AGENT);
  assert.match(ask.stderr, /needs --outcome/);
  assert.equal((await ctx.cli(['dispatch', ctx.card, '--role', 'critic'])).code, 0);
  const noCount = await ctx.cli(['handback', 'review-feat-x', '--sid', SID], AGENT);
  assert.match(noCount.stderr, /findings count/);
  const ok = await ctx.cli(
    ['handback', 'review-feat-x', '--sid', SID, '--findings', '2', '--outcome', '2 findings'],
    AGENT,
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ctx.runs().find((one) => one.name === 'review-feat-x')?.findings, 2);
});

test('the command table and the help order list dispatch and handback', async () => {
  const ctx = world();
  const help = await ctx.cli(['nonsense']);
  assert.match(help.stderr, /once-upon dispatch CARD --role/);
  assert.match(help.stderr, /once-upon handback NAME/);
});

test('--general prints a general-purpose call whose brief carries the role’s standing rules', async () => {
  const ctx = world();
  const done = await ctx.cli([
    'dispatch',
    ctx.card,
    '--role',
    'helper',
    '--task',
    'check',
    '--general',
  ]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout.split('\n')[0], /subagent_type=general-purpose /);
  assert.match(done.stdout, /Standing rules for your role/);
  assert.match(done.stdout, /Never `git stash`/);
});
