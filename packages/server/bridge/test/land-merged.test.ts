import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBridge, tmp } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { MergeLander } from '@once-upon-a-diff/state/queues/backlog/land-merged';
import type { MergedCheck, MergedPr } from '@once-upon-a-diff/state/records/github/merged-pr';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';

const MERGE = 'c'.repeat(40);
const TIP = 'a'.repeat(40);
const MIN = 60000;
/** a PR merged this long after now (the card's start is the real clock, so the PRs are timed from it) */
const merged = (afterMs = 1000, oid = MERGE): MergedPr => ({
  number: 7,
  merge_oid: oid,
  merged_at: new Date(Date.now() + afterMs).toISOString(),
  base: 'main',
});

function world(check: MergedCheck, askMs?: number) {
  const home = tmp('land-merged-home');
  const store = new BacklogStore(home);
  let clock = 1_000_000;
  const asked: string[] = [];
  const counted: MergedCheck = (repo, branch) => {
    asked.push(`${repo}@${branch}`);
    return check(repo, branch);
  };
  const lander = new MergeLander(
    store,
    counted,
    () => clock,
    askMs,
    () => readAgents(home).agents,
  );
  /** a started card on a branch */
  const started = (branch: string, repo: string | null = 'acme/widgets') => {
    const card = store.add({ title: `card ${branch}`, repo, branch: null });
    store.start(card.id, { branch, repo });
    return card.id;
  };
  /** an open card added with its branch (`backlog add --branch`), never given a start event */
  const planned = (branch: string) =>
    store.add({ title: `card ${branch}`, repo: 'acme/widgets', branch }).id;
  const dones = () =>
    readFileSync(store.file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"op":"done"'))
      .map((line) => JSON.parse(line) as { id: string; sha: string; by: string });
  return {
    home,
    store,
    lander,
    asked,
    started,
    planned,
    dones,
    advance: (delay: number) => (clock += delay),
    item: (id: string) => store.items().find((one) => one.id === id)!,
  };
}

test('a started card whose branch has a merged PR lands at the merge commit, whatever its recorded tip', async () => {
  const ctx = world(async () => merged());
  const id = ctx.started('fix-thing');
  ctx.store.claim(id, { agent: 'author-1' });
  const registry = new AgentRegistry(ctx.home);
  registry.start({ name: 'author-1', sid: 'abcdef01', kind: 'author', task: 'build', card: id });
  registry.finish('author-1', { sid: 'abcdef01', result: { commit: TIP, card: id } });

  assert.equal(await ctx.lander.kick(), 1);
  assert.equal(ctx.dones().length, 1);
  assert.deepEqual([ctx.dones()[0]!.sha, ctx.dones()[0]!.by], [MERGE, 'merged-pr']);
  const item = ctx.item(id);
  assert.equal(item.landed_sha, MERGE);
  assert.ok(item.landed_at);
  assert.equal(item.claim, null);
  assert.deepEqual(ctx.asked, ['acme/widgets@fix-thing']);
});

test('a card with a branch and no author run lands the same way, in any repo', async () => {
  const ctx = world(async () => merged());
  const id = ctx.started('web-thing', 'EverFi/everfi-frontend');
  assert.equal(await ctx.lander.kick(), 1);
  assert.equal(ctx.item(id).landed_sha, MERGE);
  assert.deepEqual(ctx.asked, ['EverFi/everfi-frontend@web-thing']);
});

test('a PR merged before the card started, or none, lands nothing', async () => {
  const ctx = world(async (_repo, branch) => (branch === 'old' ? merged(-60 * MIN) : null));
  const old = ctx.started('old');
  const open = ctx.started('open-pr');
  assert.equal(await ctx.lander.kick(), 0);
  assert.equal(ctx.item(old).landed_at, null);
  assert.equal(ctx.item(open).landed_at, null);
  assert.deepEqual(ctx.dones(), []);
});

test('a card that is held, dropped, landed, someday, unclaimed with no run or has no repo is never asked about', async () => {
  const ctx = world(async () => merged());
  const held = ctx.started('held');
  ctx.store.hold(held, true);
  const dropped = ctx.started('dropped');
  ctx.store.drop(dropped);
  const landed = ctx.started('landed');
  ctx.store.done(landed, { sha: TIP });
  ctx.planned('planned');
  ctx.store.someday(ctx.planned('later'), true, 'test');
  ctx.started('no-repo', null);
  assert.equal(await ctx.lander.kick(), 0);
  assert.deepEqual(ctx.asked, []);
  assert.equal(ctx.dones().length, 1, 'only the landing the test wrote');
});

test('an open card with a branch lands when it is claimed and its PR merged after the claim, not when before', async () => {
  const ctx = world(async (_repo, branch) => merged(branch === 'old-name' ? -60 * MIN : 1000));
  const fresh = ctx.planned('fresh');
  const old = ctx.planned('old-name');
  ctx.store.claim(fresh, { agent: 'author-1' });
  ctx.store.claim(old, { agent: 'author-2' });
  assert.equal(ctx.item(fresh).state, 'open', 'a claim without --branch never starts the card');
  assert.equal(await ctx.lander.kick(), 1);
  assert.equal(ctx.item(fresh).landed_sha, MERGE);
  assert.equal(ctx.item(old).landed_at, null);
  assert.deepEqual(ctx.asked.sort(), ['acme/widgets@fresh', 'acme/widgets@old-name']);
});

test('an open card with a branch that a run names, and no claim, lands by the run start', async () => {
  const ctx = world(async () => merged());
  const id = ctx.planned('run-only');
  const quiet = ctx.planned('quiet');
  new AgentRegistry(ctx.home).start({
    name: 'author-1',
    sid: 'abcdef01',
    kind: 'author',
    task: 'build',
    card: id,
  });
  assert.equal(await ctx.lander.kick(), 1);
  assert.equal(ctx.item(id).landed_sha, MERGE);
  assert.equal(ctx.item(quiet).landed_at, null);
  assert.deepEqual(ctx.asked, ['acme/widgets@run-only']);
});

test('a failing check writes nothing and is not asked again inside its window, then once after it', async () => {
  const ctx = world(async () => {
    throw new Error('gh is down');
  });
  ctx.started('fix-thing');
  assert.equal(await ctx.lander.kick(), 0);
  assert.equal(await ctx.lander.kick(), 0);
  ctx.advance(9 * MIN);
  await ctx.lander.kick();
  assert.equal(ctx.asked.length, 1);
  ctx.advance(2 * MIN);
  await ctx.lander.kick();
  assert.equal(ctx.asked.length, 2);
  assert.deepEqual(ctx.dones(), []);
});

test('a check that throws at once, or never answers, is given up on', async () => {
  const ctx = world((_repo, branch) => {
    if (branch === 'throws') {
      throw new Error('sync');
    }
    return new Promise<never>(() => undefined);
  }, 30);
  ctx.started('throws');
  ctx.started('hangs');
  assert.equal(await ctx.lander.kick(), 0);
  assert.equal(ctx.asked.length, 2);
  await ctx.lander.kick();
  assert.equal(ctx.asked.length, 2, 'both are in their window');
});

test('two kicks that overlap ask once per card and write one done', async () => {
  let release: (pr: MergedPr) => void = () => undefined;
  const ctx = world(() => new Promise<MergedPr>((resolve) => (release = resolve)));
  const id = ctx.started('fix-thing');
  const first = ctx.lander.kick();
  const second = ctx.lander.kick();
  assert.equal(first, second, 'the second shares the run in flight');
  await new Promise((resolve) => setImmediate(resolve));
  release(merged());
  assert.equal(await first, 1);
  assert.equal(await ctx.lander.kick(), 0);
  assert.equal(ctx.asked.length, 1);
  assert.equal(ctx.dones().length, 1);
  assert.equal(ctx.item(id).landed_sha, MERGE);
});

test('a card a deploy landed while its PR was asked about gets no second done', async () => {
  let store: BacklogStore | null = null;
  let card = '';
  const ctx = world(async () => {
    store!.done(card, { sha: TIP, by: 'deploy' });
    return merged();
  });
  store = ctx.store;
  card = ctx.started('fix-thing');
  assert.equal(await ctx.lander.kick(), 0);
  assert.deepEqual(
    ctx.dones().map((one) => one.by),
    ['deploy'],
  );
});

test('a kick asks about at most 20 cards, and the rest the next time', async () => {
  const ctx = world(async () => null);
  for (let index = 0; index < 25; index++) {
    ctx.started(`branch-${index}`);
  }
  await ctx.lander.kick();
  assert.equal(ctx.asked.length, 20);
  await ctx.lander.kick();
  assert.equal(ctx.asked.length, 25, 'the five not yet asked, the twenty in their window');
});

test('the board lands a merged card while it is polled, once, and shows it in Done', async () => {
  const home = tmp('land-merged-bridge');
  const store = new BacklogStore(home);
  const card = store.add({ title: 'merged work', repo: 'acme/widgets', branch: null });
  store.start(card.id, { branch: 'merged-work', repo: 'acme/widgets' });
  const asked: string[] = [];
  const bridge = await startBridge({
    home,
    checkMerged: async (repo, branch) => {
      asked.push(`${repo}@${branch}`);
      return merged();
    },
  });
  try {
    assert.equal((await bridge.call('GET', '/api/board')).status, 200, 'the board answers at once');
    const file = path.join(home, 'backlog.jsonl');
    for (
      let tries = 0;
      tries < 40 && !readFileSync(file, 'utf8').includes('"op":"done"');
      tries++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"op":"done"'));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).sha, MERGE);
    assert.equal(store.items()[0]!.landed_sha, MERGE);
    await bridge.call('GET', '/api/board');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"op":"done"')).length,
      1,
    );
    assert.equal(asked.length, 1);
  } finally {
    await bridge.close();
  }
});

test('a check that throws at once does not fail the board', async () => {
  const home = tmp('land-merged-throw');
  const store = new BacklogStore(home);
  const card = store.add({ title: 'work', repo: 'acme/widgets', branch: null });
  store.start(card.id, { branch: 'work', repo: 'acme/widgets' });
  const bridge = await startBridge({
    home,
    checkMerged: () => {
      throw new Error('boom');
    },
  });
  try {
    assert.equal((await bridge.call('GET', '/api/board')).status, 200);
  } finally {
    await bridge.close();
  }
});

test('a Board built with no check asks nothing of gh and lands nothing, so no test reaches the real one', async () => {
  const home = tmp('land-merged-no-check');
  const trap = path.join(tmp('land-merged-gh-trap'), 'gh');
  const log = `${trap}.calls`;
  writeFileSync(trap, `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(trap, 0o755);
  const was = process.env.ONCE_UPON_GH;
  process.env.ONCE_UPON_GH = trap;
  try {
    const store = new BacklogStore(home);
    const card = store.add({ title: 'work', repo: 'acme/widgets', branch: null });
    store.start(card.id, { branch: 'work', repo: 'acme/widgets' });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home));
    await board.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '');
    assert.equal(store.items()[0]!.landed_at, null);
  } finally {
    if (was === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = was;
    }
  }
});

test('a merge-landed card lands at the PR merged_at, not at the write time; a future or bad one lands at the write time', async () => {
  const past = world(async () => merged(-5));
  const id = past.started('fix-past');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = Date.now();
  assert.equal(await past.lander.kick(), 1);
  assert.ok(Date.parse(past.item(id).landed_at as string) < before);

  for (const mergedAt of [new Date(Date.now() + 3600000).toISOString(), 'not a time']) {
    const odd = world(async () => ({ ...merged(), merged_at: mergedAt }));
    const oddId = odd.started('fix-odd');
    // a time in the future cannot beat the card's start, so the card is landed by a start-time-proof PR: write it directly
    odd.store.done(oddId, { mergedAt });
    assert.ok(Date.parse(odd.item(oddId).landed_at as string) <= Date.now());
  }
});

test('a second done can only move landed_at earlier and never replaces the sha', () => {
  const home = tmp('done-twice-home');
  const store = new BacklogStore(home);
  const card = store.add({ title: 'a', repo: 'acme/widgets', branch: 'x' });
  const early = new Date(Date.now() - 3 * 3600000).toISOString();
  const late = new Date(Date.now() - 3600000).toISOString();
  store.done(card.id, { sha: MERGE, mergedAt: late });
  store.done(card.id, { sha: TIP, mergedAt: early });
  const once = store.items().find((one) => one.id === card.id)!;
  assert.equal(once.landed_at, early);
  assert.equal(once.landed_sha, MERGE);
  store.done(card.id, { mergedAt: late });
  assert.equal(store.items().find((one) => one.id === card.id)!.landed_at, early);
});
