import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, runCli, tmp } from './helpers.ts';
import { BacklogStore } from '../src/services/backlog/backlog.ts';
import { landItems, recordedTips } from '../src/services/backlog/landing.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';

const SID = 'abcdef01';
const minute = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);

/** A repo on main with a 30-line a.txt, and helpers to commit on a branch and pick onto another. */
function world() {
  const repo = tmp('land-repo');
  git(repo, 'init', '-q', '-b', 'main');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(path.join(repo, 'a.txt'), lines.join('\n') + '\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const home = tmp('land-home');
  /** commits line n := text on the checked-out branch */
  const edit = (line: number, text: string, subject = text) => {
    const file = path.join(repo, 'a.txt');
    const all = readFileSync(file, 'utf8').split('\n');
    all[line - 1] = text;
    writeFileSync(file, all.join('\n'));
    git(repo, 'commit', '-q', '-am', subject);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const branch = (name: string, from = base) => git(repo, 'checkout', '-q', '-B', name, from);
  const store = new BacklogStore(home);
  const registry = new AgentRegistry(home);
  let clock = 0;
  /** one agent run on a card: start (naming the card) then finish with a commit (and the card, unless `card` is false) */
  const run = (
    name: string,
    card: string,
    commit: string | null,
    { named = true }: { named?: boolean } = {},
  ) => {
    registry.start({
      name,
      sid: SID,
      kind: 'builder',
      task: 'build',
      card,
      at: minute(clock++),
    });
    registry.finish(name, {
      sid: SID,
      result: { commit, card: named ? card : null },
      at: minute(clock++),
    });
  };
  const land = (items: BacklogStore, from: string, head: string, picked: string[] = []) =>
    landItems(repo, 'acme/widgets', items.items(), recordedTips(registry.events()), {
      from,
      to: head,
      picked,
    });
  return { repo, base, home, edit, branch, store, registry, run, land };
}

test('a branch name that matches is not a landing: the card stays open when its commit did not deploy', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build x', repo: 'acme/widgets' });
  lab.store.start(item.id, { branch: 'feat/x', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-x', sid: SID });
  lab.branch('feat/x');
  const tip = lab.edit(3, 'x change');
  lab.run('ou-x', item.id, tip);
  // main gets some other commit, and another branch of the same name elsewhere would change nothing
  lab.branch('main');
  const other = lab.edit(20, 'other change');
  const found = lab.land(lab.store, lab.base, other);
  assert.deepEqual(found.landed, []);
  assert.match(found.open[0].why, /not in this deploy/);
  assert.equal(found.open[0].item.id, item.id);
});

test('a fast-forward deploy lands the card whose tip is in the range, a short sha as recorded', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build y', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-y', sid: SID });
  lab.branch('feat/y');
  const tip = lab.edit(3, 'y change');
  lab.run('ou-y', item.id, tip.slice(0, 9));
  const found = lab.land(lab.store, lab.base, tip);
  assert.deepEqual(
    found.landed.map((one) => [one.item.id, one.sha]),
    [[item.id, tip]],
    'a claimed card with no start lands too',
  );
  // a tip that was already live before the range is not this deploy's
  assert.deepEqual(lab.land(lab.store, tip, tip).landed, []);
});

test('a cherry-picked card lands as the picked commit, by patch', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build z', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-z', sid: SID });
  lab.branch('feat/z');
  const tip = lab.edit(3, 'z change');
  lab.run('ou-z', item.id, tip);
  lab.branch('main');
  lab.edit(25, 'unrelated');
  git(lab.repo, 'cherry-pick', tip);
  const picked = git(lab.repo, 'rev-parse', 'HEAD');
  assert.notEqual(picked, tip);
  const found = lab.land(lab.store, lab.base, 'HEAD');
  assert.deepEqual(
    found.landed.map((one) => [one.item.id, one.sha]),
    [[item.id, picked]],
  );
});

test('a rebased tip (same patch, new sha) in a fast-forward range lands', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build r', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-r', sid: SID });
  lab.branch('feat/r');
  const tip = lab.edit(3, 'r change');
  lab.run('ou-r', item.id, tip);
  lab.branch('main');
  lab.edit(25, 'moved on');
  git(lab.repo, 'checkout', '-q', 'feat/r');
  git(lab.repo, 'rebase', '-q', 'main');
  const rebased = git(lab.repo, 'rev-parse', 'HEAD');
  assert.notEqual(rebased, tip);
  const found = lab.land(lab.store, lab.base, rebased);
  assert.deepEqual(
    found.landed.map((one) => one.sha),
    [rebased],
  );
});

test('an amended tip is tracked: two runs, the newer commit is the card’s', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build a', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-a', sid: SID });
  lab.branch('feat/a');
  const first = lab.edit(3, 'a change');
  lab.run('ou-a', item.id, first);
  // a fix round: a new run amends the commit and finishes again
  git(lab.repo, 'commit', '-q', '--amend', '-m', 'a change, fixed', '--allow-empty');
  writeFileSync(path.join(lab.repo, 'b.txt'), 'fix\n');
  git(lab.repo, 'add', '.');
  git(lab.repo, 'commit', '-q', '--amend', '--no-edit');
  const second = git(lab.repo, 'rev-parse', 'HEAD');
  assert.notEqual(second, first);
  lab.run('ou-a', item.id, second);
  assert.equal(recordedTips(lab.registry.events()).get(item.id), second);
  // only the old commit is deployed: the card is not landed
  const old = lab.land(lab.store, lab.base, first);
  assert.deepEqual(old.landed, []);
  assert.match(old.open[0].why, /not in this deploy/);
  // the new one deployed: it is
  assert.equal(lab.land(lab.store, lab.base, second).landed[0].sha, second);
});

test('a finish with no --card takes its run’s start card; a finish with no commit clears nothing', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build c', repo: 'acme/widgets' });
  lab.branch('feat/c');
  const tip = lab.edit(3, 'c change');
  lab.run('ou-c', item.id, tip, { named: false });
  lab.run('ou-c', item.id, null, { named: false });
  assert.equal(recordedTips(lab.registry.events()).get(item.id), tip);
  assert.equal(lab.land(lab.store, lab.base, tip).landed[0].item.id, item.id);
});

test('a batch pick whose patch changed lands through the picked sha; an empty commit never matches an empty one', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build p', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-p', sid: SID });
  // the branch's change sits next to a line that main changes: the pick still applies, with different context
  lab.branch('feat/p');
  const tip = lab.edit(10, 'p change');
  lab.run('ou-p', item.id, tip);
  lab.branch('main');
  lab.edit(12, 'neighbour');
  git(lab.repo, 'cherry-pick', tip);
  const picked = git(lab.repo, 'rev-parse', 'HEAD');
  const byPatch = lab.land(lab.store, lab.base, picked);
  assert.equal(byPatch.landed.length, 0, 'the context changed, so the patch-id differs');
  const viaPicked = lab.land(lab.store, lab.base, picked, [tip]);
  assert.equal(viaPicked.landed[0].item.id, item.id);

  const empty = lab.store.add({ title: 'Build e', repo: 'acme/widgets' });
  lab.store.claim(empty.id, { agent: 'ou-e', sid: SID });
  lab.branch('feat/e');
  git(lab.repo, 'commit', '-q', '--allow-empty', '-m', 'empty one');
  const emptyTip = git(lab.repo, 'rev-parse', 'HEAD');
  lab.run('ou-e', empty.id, emptyTip);
  lab.branch('main', picked);
  git(lab.repo, 'commit', '-q', '--allow-empty', '-m', 'empty two');
  const found = lab.land(lab.store, picked, 'HEAD');
  assert.ok(
    !found.landed.some((one) => one.item.id === empty.id),
    'an empty commit is not a match',
  );
});

test('a held card is never marked by a deploy, hold --off clears it, and done closes it by hand', () => {
  const lab = world();
  const item = lab.store.add({ title: 'Cutover', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-h', sid: SID });
  assert.equal(lab.store.hold(item.id, true).hold, true);
  lab.branch('feat/h');
  const tip = lab.edit(3, 'h change');
  lab.run('ou-h', item.id, tip);
  const held = lab.land(lab.store, lab.base, tip);
  assert.deepEqual(held.landed, []);
  assert.deepEqual(
    held.held.map((one) => one.id),
    [item.id],
  );
  // hold is sticky across a new claim
  assert.equal(lab.store.claim(item.id, { agent: 'ou-h2' }).hold, true);
  assert.equal(lab.store.hold(item.id, false).hold, false);
  assert.equal(lab.land(lab.store, lab.base, tip).landed.length, 1);
  lab.store.hold(item.id, true);
  assert.equal(lab.store.done(item.id, { sha: tip.slice(0, 7) }).landed_sha, tip.slice(0, 7));
  // a drop then a reopen clears it
  const other = lab.store.add({ title: 'Other', repo: 'acme/widgets' });
  lab.store.hold(other.id, true);
  lab.store.drop(other.id);
  assert.equal(lab.store.reopen(other.id).hold, false);
});

test('a claimed card with no tip, or a tip from another repo, is reported and left alone', () => {
  const lab = world();
  const none = lab.store.add({ title: 'No tip', repo: 'acme/widgets' });
  lab.store.claim(none.id, { agent: 'ou-n', sid: SID });
  const foreign = lab.store.add({ title: 'Elsewhere', repo: 'acme/widgets' });
  lab.store.claim(foreign.id, { agent: 'ou-f', sid: SID });
  lab.run('ou-f', foreign.id, 'deadbeefdeadbeef');
  const other = lab.store.add({ title: 'Other repo', repo: 'acme/gadgets' });
  lab.store.claim(other.id, { agent: 'ou-g', sid: SID });
  lab.branch('feat/n');
  const tip = lab.edit(3, 'n change');
  const found = lab.land(lab.store, lab.base, tip);
  assert.deepEqual(found.landed, []);
  assert.deepEqual(
    found.open.map((one) => [one.item.id, one.why.split(' ')[0]]),
    [
      [none.id, 'no'],
      [foreign.id, 'tip'],
    ],
  );
  assert.match(found.open[1].why, /not a commit of this repo/);
});

test('the CLI: land marks and reports without a branch, --dry-run writes nothing, done --branch is gone', async () => {
  const lab = world();
  const item = lab.store.add({ title: 'Build cli', repo: 'acme/widgets' });
  lab.store.claim(item.id, { agent: 'ou-cli', sid: SID });
  const quiet = lab.store.add({ title: 'Quiet', repo: 'acme/widgets' });
  lab.store.claim(quiet.id, { agent: 'ou-q', sid: SID });
  lab.branch('feat/cli');
  const tip = lab.edit(3, 'cli change');
  lab.run('ou-cli', item.id, tip);
  const args = ['backlog', 'land', '--from', lab.base, '--to', tip, '--by', 'deploy-local'];
  const dry = await runCli(lab.home, [...args, '--dry-run'], {}, lab.repo);
  assert.match(dry.stdout, new RegExp(`${item.id} would be done at ${tip}`));
  assert.equal(lab.store.items().find((one) => one.id === item.id)?.landed_at, null);
  const real = await runCli(lab.home, args, {}, lab.repo);
  assert.match(real.stdout, new RegExp(`${item.id} done at ${tip}`));
  assert.match(real.stdout, new RegExp(`${quiet.id} still open, no recorded tip`));
  const landed = lab.store.items().find((one) => one.id === item.id);
  assert.equal(landed?.landed_sha, tip);
  assert.equal(landed?.state, 'open');
  const gone = await runCli(lab.home, ['backlog', 'done', '--branch', 'feat/cli'], {}, lab.repo);
  assert.notEqual(gone.code, 0);
  assert.match(gone.stderr, /by ID/);
  const hold = await runCli(lab.home, ['backlog', 'hold', quiet.id], {}, lab.repo);
  assert.match(hold.stdout, /held/);
  assert.equal(lab.store.items().find((one) => one.id === quiet.id)?.hold, true);
});

test('deploy-local.sh marks cards through backlog land, not a branch name', () => {
  const script = readFileSync(new URL('../../../scripts/deploy-local.sh', import.meta.url), 'utf8');
  assert.match(script, /backlog land /);
  assert.doesNotMatch(script, /done --branch/);
  assert.doesNotMatch(script, /--branch "\$name"/);
});
