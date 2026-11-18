import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { dispatchRun, finishRun } from '../src/features/runs/service.ts';

/*
 * dispatchRun: claim (author and fixer), start the run and render the brief, in one call. The registry's own refusals
 * (a second open author, a critic with no branch) are not copied: a refused start after the claim leaves the claim.
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
const claimOf = (ctx: ReturnType<typeof world>) =>
  ctx.store.items().find((one) => one.id === ctx.card)!.claim;
const refused = (promise: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(promise, (err: Error) => pattern.test(err.message));

test('an author on an unclaimed card claims it, starts its run and prints a brief naming both', async () => {
  const ctx = world();
  const done = await ctx.dispatch();
  assert.equal(done.name, 'feat-x');
  assert.equal(done.subagentType, 'once-upon-author');
  assert.equal(claimOf(ctx)?.agent, 'feat-x');
  assert.equal(claimOf(ctx)?.sid, SID);
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
  assert.equal(claimOf(ctx), null);
  assert.equal(claimOf(dropped), null);
});

test('a card with no branch needs --branch, which stamps the card; a critic with no branch is refused before any write', async () => {
  const ctx = world(null);
  await refused(ctx.dispatch(), /no branch.*--branch/);
  await refused(ctx.dispatch({ role: 'critic' }), /no branch.*--branch/);
  assert.deepEqual(ctx.agents(), []);
  assert.equal(claimOf(ctx), null);
  await ctx.dispatch({ branch: 'feat-y' });
  assert.equal(ctx.store.items().find((one) => one.id === ctx.card)?.branch, 'feat-y');
  assert.equal(ctx.agents()[0].name, 'feat-y');
});

test('a card claimed by another live agent is refused; once that run is finished it may be taken', async () => {
  const ctx = world();
  ctx.store.claim(ctx.card, { agent: 'someone-else', sid: SID });
  await refused(ctx.dispatch(), /claimed by someone-else/);
  assert.deepEqual(ctx.agents(), []);
  assert.equal(claimOf(ctx)?.agent, 'someone-else', 'the refusal left the claim as it was');
  // its run is open: still live
  new AgentRegistry(ctx.home).start({
    name: 'someone-else',
    sid: SID,
    kind: 'author',
    task: 't',
    branch: 'feat-x',
    card: ctx.card,
    cwd: ctx.fixture.main,
    role: 'author',
  });
  await refused(ctx.dispatch(), /claimed by someone-else/);
  finishRun(ctx.home, 'someone-else', { sid: SID });
  await ctx.dispatch();
  assert.equal(claimOf(ctx)?.agent, 'feat-x');
});

test('a second open author under another name is the registry’s refusal; a card with no earlier claim keeps the new one, and the message says it has no run', async () => {
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
  await refused(
    ctx.dispatch({ name: 'other-author' }),
    /already has an open author|stays claimed by other-author/,
  );
  assert.equal(claimOf(ctx)?.agent, 'other-author');
  assert.match(
    await ctx.dispatch({ name: 'other-author' }).then(
      () => '',
      (err: Error) => err.message,
    ),
    /stays claimed by other-author/,
  );
  // the same name started again (a restart of the one open run) is not a second author
  finishRun(ctx.home, 'hand-started', { sid: SID });
  await ctx.dispatch({ name: 'other-author' });
  await ctx.dispatch({ name: 'other-author' });
});

test('a fixer starts under fix-<branch> after the author finished and renames the claim; its claim carries the worktree', async () => {
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
  assert.equal(claimOf(ctx)?.agent, 'fix-feat-x');
  assert.equal(claimOf(ctx)?.worktree, path.join(ctx.fixture.trees, 'feat-x'));
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

test('--from-notes is the fresh build author: <branch>-build, re-claimed for it, with the notes path in its brief', async () => {
  const ctx = world();
  const planner = await ctx.dispatch({ plan: true, check: undefined });
  assert.match(planner.prompt, /handback feat-x --sid abcdef01 --plan/);
  assert.match(planner.prompt, /Beats \(M=2\)/);
  finishRun(ctx.home, 'feat-x', { sid: SID });
  const notes = path.join(ctx.fixture.trees, 'feat-x.notes.md');
  const build = await ctx.dispatch({ fromNotes: notes });
  assert.equal(build.name, 'feat-x-build');
  assert.equal(claimOf(ctx)?.agent, 'feat-x-build');
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

test('a helper writes no claim; a critic names its findings file and finishes with --findings', async () => {
  const ctx = world();
  const helper = await ctx.dispatch({ role: 'helper', check: undefined, task: 'check the plan' });
  assert.equal(helper.name, 'check-feat-x');
  assert.equal(helper.subagentType, 'once-upon-helper');
  assert.equal(claimOf(ctx), null);
  const critic = await ctx.dispatch({ role: 'critic', check: undefined, task: undefined });
  assert.equal(critic.name, 'review-feat-x');
  assert.equal(critic.model, 'opus');
  assert.equal(claimOf(ctx), null);
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
  assert.equal(claimOf(ctx), null);
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

test('<home>/editor/brief-extra.md is appended to every brief and swaps the Agent call to general-purpose', async () => {
  const ctx = world();
  const plain = await ctx.dispatch({ role: 'helper', check: undefined, task: 'x' });
  assert.equal(plain.subagentType, 'once-upon-helper');
  mkdirSync(path.join(ctx.home, 'editor'), { recursive: true });
  writeFileSync(
    path.join(ctx.home, 'editor', 'brief-extra.md'),
    'Forward results to the relay by SendMessage.\n',
  );
  finishRun(ctx.home, 'check-feat-x', { sid: SID });
  const extra = await ctx.dispatch({ role: 'helper', check: undefined, task: 'x' });
  assert.ok(extra.prompt.trimEnd().endsWith('Forward results to the relay by SendMessage.'));
  assert.equal(extra.subagentType, 'general-purpose');
});

test('a worktree that is gone refuses a fixer’s claim and says so, leaving no claim', async () => {
  const ctx = world('feat-x');
  await refused(ctx.dispatch({ role: 'fixer', check: 'ok' }), /worktree/);
  assert.equal(claimOf(ctx), null);
  assert.deepEqual(ctx.agents(), []);
});

test('a general-purpose launch (brief-extra, or --general) carries the role’s standing rules in its prompt; a lean type does not', async () => {
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
  const author = await ctx.dispatch();
  assert.equal(author.subagentType, 'general-purpose');
  assert.match(author.prompt, /100 tool calls/);
  assert.ok(author.prompt.trimEnd().endsWith('Forward results.'), 'the extra stays last');
});

test('a start the registry refuses after the claim puts the earlier claim back, so the card is not blocked', async () => {
  const ctx = world();
  // an earlier author claimed the card and finished
  await ctx.dispatch({ name: 'first-author' });
  finishRun(ctx.home, 'first-author', { sid: SID });
  // a hand-started author is open, so the registry refuses a second one after the claim is written
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
  await refused(ctx.dispatch({ name: 'other-author' }), /already has an open author/);
  assert.equal(claimOf(ctx)?.agent, 'first-author', 'the earlier claim is back');
});

test('a claim whose start was refused (no run) does not block the same launcher’s next dispatch under another name', async () => {
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
  await refused(ctx.dispatch({ name: 'other-author' }), /already has an open author/);
  finishRun(ctx.home, 'hand-started', { sid: SID });
  await ctx.dispatch({ name: 'third-author' });
  assert.equal(claimOf(ctx)?.agent, 'third-author');
});
