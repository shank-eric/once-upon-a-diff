import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { dispatchRun, finishRun } from '../src/features/runs/service.ts';

/*
 * dispatchRun: start the run and render the brief, in one call. The run is what takes the card (no claim row is written), and
 * the registry's own refusals (a second open author, a critic with no branch) are not copied: a refused start writes nothing.
 */

const SID = 'abcdef01';
const SESSION = `${SID}-1111-4222-8333-444444444444`;

function world(
  branch: string | null = 'feat-x',
  note: string | null = 'Do the thing.\nSecond line.',
) {
  const home = tmp('dispatch-home');
  const fixture = worktreeFixture();
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A card', note, repo: 'acme/widgets' });
  if (branch) {
    store.start(item.id, { branch, repo: 'acme/widgets' });
  }
  const dispatch = (over: Partial<Parameters<typeof dispatchRun>[1]> = {}) =>
    dispatchRun(home, {
      card: item.id,
      role: 'author',
      cwd: fixture.main,
      session: SESSION,
      check: 'yarn test passes',
      task: 'build it',
      ...over,
    });
  return {
    home,
    fixture,
    store,
    card: item.id,
    dispatch,
    agents: () => new AgentRegistry(home).agents(),
  };
}
/** The backlog file as written: a dispatch appends no claim row, and a refused one appends nothing. */
const backlogText = (ctx: ReturnType<typeof world>) => readFileSync(ctx.store.file, 'utf8');
const claimRows = (ctx: ReturnType<typeof world>) =>
  backlogText(ctx)
    .split('\n')
    .filter((line) => line.includes('"op":"claim"'));
const refused = (promise: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(promise, (err: Error) => pattern.test(err.message));

test('an author starts its run on the card, writes no claim and prints a brief naming both', async () => {
  const ctx = world();
  const done = await ctx.dispatch();
  assert.equal(done.name, 'feat-x');
  assert.equal(done.subagentType, 'once-upon-author');
  assert.deepEqual(claimRows(ctx), []);
  const [run] = ctx.agents();
  assert.equal(run.name, 'feat-x');
  assert.equal(run.card, ctx.card);
  assert.equal(run.branch, 'feat-x');
  assert.equal(run.role, 'author');
  assert.equal(run.cwd, ctx.fixture.main);
  assert.match(done.prompt, /Card .*: A card\./);
  assert.match(done.prompt, /Success check \(work until it passes\): yarn test passes/);
  assert.match(done.prompt, /Do the thing\.\nSecond line\./, 'the card note is verbatim');
  assert.ok(done.prompt.includes(path.join(ctx.fixture.trees, 'feat-x')), 'the worktree path');
  assert.ok(
    done.prompt.includes(path.join(ctx.fixture.trees, 'feat-x.notes.md')),
    'the notes file',
  );
});

test('a preflight refusal writes nothing: no card, a dropped or landed card, a held card for an author, an unknown role, no success check', async () => {
  const ctx = world();
  await refused(ctx.dispatch({ card: 'bl_nothere1' }), /no backlog item/);
  await refused(ctx.dispatch({ role: 'boss' as 'author' }), /the role must be one of/);
  await refused(ctx.dispatch({ check: undefined }), /success check/);
  ctx.store.hold(ctx.card, true);
  await refused(ctx.dispatch(), /held/);
  ctx.store.hold(ctx.card, false);
  ctx.store.done(ctx.card, {});
  await refused(ctx.dispatch(), /landed|done/);
  const dropped = world();
  dropped.store.drop(dropped.card);
  await refused(dropped.dispatch(), /dropped/);
  for (const one of [ctx, dropped]) {
    assert.deepEqual(one.agents(), []);
  }
  assert.deepEqual(claimRows(ctx), []);
  assert.deepEqual(claimRows(dropped), []);
});

test('a card with no branch needs --branch, which stamps the card; a critic with no branch is refused before any write', async () => {
  const ctx = world(null);
  await refused(ctx.dispatch(), /no branch.*--branch/);
  await refused(ctx.dispatch({ role: 'critic' }), /no branch.*--branch/);
  assert.deepEqual(ctx.agents(), []);
  await ctx.dispatch({ branch: 'feat-y' });
  assert.equal(ctx.store.items().find((one) => one.id === ctx.card)?.branch, 'feat-y');
  assert.equal(ctx.agents()[0].name, 'feat-y');
});

test('a second dispatch while the first author runs is refused naming it, writes nothing, and may go once that run is finished', async () => {
  const ctx = world();
  await ctx.dispatch({ name: 'first-author' });
  const before = backlogText(ctx);
  const agentsBefore = ctx.agents();
  await refused(
    ctx.dispatch({ name: 'second-author' }),
    /already has an open author run \(\w+:first-author\).*once-upon handback first-author/,
  );
  assert.equal(backlogText(ctx), before, 'the refusal left backlog.jsonl byte-equal');
  assert.deepEqual(ctx.agents(), agentsBefore);
  finishRun(ctx.home, 'first-author', { sid: SID });
  await ctx.dispatch({ name: 'second-author' });
  assert.deepEqual(
    ctx.agents().map((one) => one.name),
    ['first-author', 'second-author'],
  );
});

test('two dispatches of one card at once leave one open author', async () => {
  const ctx = world();
  const outcomes = await Promise.allSettled([
    ctx.dispatch({ name: 'one' }),
    ctx.dispatch({ name: 'two' }),
  ]);
  assert.equal(outcomes.filter((one) => one.status === 'fulfilled').length, 1);
  assert.equal(ctx.agents().length, 1);
});

test('an author parked at a question or a story review does not block the next dispatch (only a running one does)', async () => {
  const ctx = world();
  await ctx.dispatch({ name: 'first-author' });
  new AgentRegistry(ctx.home).state('first-author', {
    sid: SID,
    state: 'review',
    outcome: 'story ready',
  });
  await ctx.dispatch({ name: 'second-author' });
  assert.equal(ctx.agents().length, 2);
});

test('a second open author under another name is the registry’s refusal, and nothing is written for it', async () => {
  const ctx = world();
  new AgentRegistry(ctx.home).start({
    name: 'hand-started',
    sid: SID,
    kind: 'author',
    task: 't',
    branch: 'feat-x',
    card: ctx.card,
    cwd: ctx.fixture.main,
    role: 'author',
  });
  const before = backlogText(ctx);
  await refused(ctx.dispatch({ name: 'other-author' }), /already has an open author/);
  await refused(ctx.dispatch({ name: 'other-author' }), /once-upon handback hand-started/);
  assert.equal(backlogText(ctx), before);
  // the same name started again (a restart of the one open run) is not a second author
  finishRun(ctx.home, 'hand-started', { sid: SID });
  await ctx.dispatch({ name: 'other-author' });
  await ctx.dispatch({ name: 'other-author' });
});

test('a fixer starts under fix-<branch> after the author finished, and the card is linked to its worktree', async () => {
  const ctx = world('feat-x');
  ctx.fixture.add('feat-x');
  await ctx.dispatch();
  finishRun(ctx.home, 'feat-x', { sid: SID });
  const fixer = await ctx.dispatch({
    role: 'fixer',
    findingsFrom: '/tmp/findings.md',
    check: 'tests pass',
  });
  assert.equal(fixer.name, 'fix-feat-x');
  assert.deepEqual(claimRows(ctx), []);
  assert.equal(
    ctx.store.items().find((one) => one.id === ctx.card)?.worktree,
    path.join(ctx.fixture.trees, 'feat-x'),
  );
  const run = ctx.agents().find((one) => one.name === 'fix-feat-x');
  assert.equal(run?.role, 'fixer');
  assert.match(fixer.prompt, /\/tmp\/findings\.md/);
  assert.match(fixer.prompt, /Amend the branch’s one commit, never add a second/);
});

test('a branch with a slash names its run and worktree with a dash', async () => {
  const ctx = world('feat/x');
  const done = await ctx.dispatch();
  assert.equal(done.name, 'feat-x');
  assert.ok(done.prompt.includes(path.join(ctx.fixture.trees, 'feat-x')));
  assert.match(done.prompt, /git worktree add -b feat\/x /);
});

test('--from-notes is the fresh build author: <branch>-build, with the notes path in its brief', async () => {
  const ctx = world();
  const planner = await ctx.dispatch({ plan: true, check: undefined });
  assert.match(planner.prompt, /handback feat-x --sid abcdef01 --plan/);
  assert.match(planner.prompt, /Beats \(M=2\)/);
  finishRun(ctx.home, 'feat-x', { sid: SID });
  const notes = path.join(ctx.fixture.trees, 'feat-x.notes.md');
  const build = await ctx.dispatch({ fromNotes: notes });
  assert.equal(build.name, 'feat-x-build');
  assert.ok(build.prompt.includes(`Build from ${notes}`));
  assert.match(build.prompt, /Plan check/);
});

test('a plan and --from-notes together are refused', async () => {
  const ctx = world();
  await refused(
    ctx.dispatch({ plan: true, fromNotes: '/x.md' }),
    /plan.*from-notes|from-notes.*plan/,
  );
  assert.deepEqual(ctx.agents(), []);
});

test('a helper starts a run; a critic names its findings file and finishes with --findings', async () => {
  const ctx = world();
  const helper = await ctx.dispatch({ role: 'helper', check: undefined, task: 'check the plan' });
  assert.equal(helper.name, 'check-feat-x');
  assert.equal(helper.subagentType, 'once-upon-helper');
  const critic = await ctx.dispatch({ role: 'critic', check: undefined, task: undefined });
  assert.equal(critic.name, 'review-feat-x');
  assert.equal(critic.model, 'opus');
  assert.match(critic.prompt, /handback review-feat-x --sid abcdef01 --findings <N>/);
  assert.match(critic.prompt, /\/reviews\/\d{4}-\d{2}-\d{2}-feat-x-agent-review\.md/);
  assert.match(critic.prompt, /git diff main\.\.\.HEAD/);
});

test('fan-out chapter writers and the finisher register as storyteller runs and print their own briefs', async () => {
  const ctx = world();
  const dir = '/tmp/story-dir';
  const writer = await ctx.dispatch({ role: 'writer', key: 'k1', dir, check: undefined });
  assert.equal(writer.name, 'fw-feat-x-k1');
  assert.equal(writer.subagentType, 'once-upon-helper');
  assert.equal(ctx.agents().find((one) => one.name === 'fw-feat-x-k1')?.role, 'storyteller');
  assert.ok(writer.prompt.includes(`${dir}/fragments/k1.json`));
  finishRun(ctx.home, 'fw-feat-x-k1', { sid: SID, state: 'done' });
  const finisher = await ctx.dispatch({
    role: 'finisher',
    story: 'story-1',
    dir,
    failed: 'k2',
    check: undefined,
  });
  assert.equal(finisher.name, 'finish-feat-x');
  assert.equal(finisher.subagentType, 'once-upon-storyteller');
  assert.match(finisher.prompt, /Finish a fanned-out story/);
  assert.match(finisher.prompt, /k2/);
});

test('the storyteller brief carries Fan-out: yes only when asked', async () => {
  const ctx = world();
  const plain = await ctx.dispatch({ role: 'storyteller', check: undefined });
  assert.equal(plain.name, 'story-feat-x');
  assert.doesNotMatch(plain.prompt, /Fan-out: yes/);
  finishRun(ctx.home, 'story-feat-x', { sid: SID });
  const fan = await ctx.dispatch({ role: 'storyteller', fanOut: true, check: undefined });
  assert.match(fan.prompt, /^Fan-out: yes$/m);
});

test('a storyteller brief names pr-draft for a PR repo and not for one whose settings skip review', async () => {
  const ctx = world();
  const pr = await ctx.dispatch({ role: 'storyteller', check: undefined });
  assert.match(pr.prompt, /once-upon pr-draft/);
  finishRun(ctx.home, 'story-feat-x', { sid: SID });
  writeFileSync(
    path.join(ctx.home, 'config.json'),
    JSON.stringify({ repos: { 'acme/widgets': { skips_review: true } } }),
  );
  const skip = await ctx.dispatch({ role: 'storyteller', check: undefined });
  assert.doesNotMatch(skip.prompt, /pr-draft/);
});

test('<home>/editor/brief-extra.md never switches the type: a lean launch leaves it out, only --general appends it', async () => {
  const ctx = world();
  mkdirSync(path.join(ctx.home, 'editor'), { recursive: true });
  writeFileSync(
    path.join(ctx.home, 'editor', 'brief-extra.md'),
    'Forward results to the relay by SendMessage.\n',
  );
  const lean = await ctx.dispatch({ role: 'helper', check: undefined, task: 'x' });
  assert.equal(lean.subagentType, 'once-upon-helper');
  assert.doesNotMatch(lean.prompt, /Forward results to the relay/);
  assert.doesNotMatch(lean.prompt, /Standing rules/);
  finishRun(ctx.home, 'check-feat-x', { sid: SID });
  const general = await ctx.dispatch({
    role: 'helper',
    check: undefined,
    task: 'x',
    general: true,
  });
  assert.equal(general.subagentType, 'general-purpose');
  assert.ok(general.prompt.trimEnd().endsWith('Forward results to the relay by SendMessage.'));
});

test('a worktree that is gone refuses a fixer and says so, writing nothing', async () => {
  const ctx = world('feat-x');
  const before = backlogText(ctx);
  await refused(ctx.dispatch({ role: 'fixer', check: 'ok' }), /worktree/);
  assert.equal(backlogText(ctx), before);
  assert.deepEqual(ctx.agents(), []);
});

test('a general-purpose launch (--general) carries the role’s standing rules in its prompt; a lean type does not', async () => {
  const ctx = world();
  const lean = await ctx.dispatch({ role: 'helper', check: undefined, task: 'x' });
  assert.equal(lean.subagentType, 'once-upon-helper');
  assert.doesNotMatch(lean.prompt, /Standing rules/);
  finishRun(ctx.home, 'check-feat-x', { sid: SID });
  const general = await ctx.dispatch({
    role: 'helper',
    check: undefined,
    task: 'x',
    general: true,
  });
  assert.equal(general.subagentType, 'general-purpose');
  assert.match(general.prompt, /Standing rules/);
  assert.match(general.prompt, /Never `git stash`/);
  assert.match(general.prompt, /timeout 30/);
  assert.doesNotMatch(
    general.prompt,
    /^name: once-upon-helper$/m,
    'the frontmatter is not in the prompt',
  );
  finishRun(ctx.home, 'check-feat-x', { sid: SID });
  mkdirSync(path.join(ctx.home, 'editor'), { recursive: true });
  writeFileSync(path.join(ctx.home, 'editor', 'brief-extra.md'), 'Forward results.\n');
  const author = await ctx.dispatch({ general: true });
  assert.equal(author.subagentType, 'general-purpose');
  assert.match(author.prompt, /100 tool calls/);
  assert.ok(author.prompt.trimEnd().endsWith('Forward results.'), 'the extra stays last');
});
