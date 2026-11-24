import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { agentsFile } from '@once-upon-a-diff/state/records/agents/read';
import {
  finishRun,
  moveBranch,
  startRun,
  type RunIo,
  type RunStartInput,
} from '../src/features/runs/service.ts';

/*
 * The ADR-25 rules for starting, moving and finishing a run, with no CLI: the module takes plain input and an injected gh.
 */

const SID = 'abcdef01';
const CWD = tmp('runs-cwd');

const home = (name: string) => tmp(`runs-${name}`);
const input = (over: Partial<RunStartInput> = {}): RunStartInput => ({
  name: 'ou-a',
  sid: SID,
  task: 'build it',
  cwd: CWD,
  ...over,
});
const warnings = () => {
  const lines: string[] = [];
  return { lines, io: { warn: (line: string) => lines.push(line) } satisfies RunIo };
};
/** A card with a repo and, unless `branch` is null, a branch. */
function card(dir: string, branch: string | null = 'feat/x') {
  const store = new BacklogStore(dir);
  const item = store.add({ title: 'A card', repo: 'acme/widgets' });
  if (branch) {
    store.start(item.id, { branch, repo: 'acme/widgets' });
  }
  return item.id;
}
const starts = (dir: string) => new AgentRegistry(dir).events().filter((one) => one.op === 'start');
const refused = (promise: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(promise, (err: Error) => pattern.test(err.message));

test('the role table: a fixer runs as an author and keeps its role on the start row', async () => {
  const dir = home('roles');
  const id = card(dir, 'feat/x');
  await startRun(dir, input({ card: id, role: 'author' }));
  finishRun(dir, 'ou-a', { sid: SID });
  await startRun(dir, input({ name: 'fix-a', card: id, role: 'fixer' }));
  finishRun(dir, 'fix-a', { sid: SID });
  await startRun(dir, input({ name: 'rev-a', card: id, role: 'critic' }));
  const rows = new AgentRegistry(dir).agents();
  assert.deepEqual(
    rows.map((one) => [one.name, one.kind]),
    [
      ['ou-a', 'author'],
      ['fix-a', 'author'],
      ['rev-a', 'critic'],
    ],
  );
  assert.deepEqual(
    starts(dir).map((one) => one.role),
    ['author', 'fixer', 'critic'],
  );
});

test('a role must be one, and a typed kind may not disagree with it', async () => {
  const dir = home('role-kind');
  await refused(startRun(dir, input({ role: 'boss' })), /the role must be one of author, fixer/);
  await refused(
    startRun(dir, input({ role: 'critic', kind: 'author', card: card(dir) })),
    /--role and --kind disagree/,
  );
  assert.equal(existsSync(agentsFile(dir)), false);
});

test('a critic or a fixer with no card, a bare storyteller and a story run with no shape are refused', async () => {
  const dir = home('needs-card');
  await refused(
    startRun(dir, input({ role: 'critic' })),
    /a critic works on a card: pass --card ID/,
  );
  await refused(startRun(dir, input({ role: 'fixer' })), /a fixer works on a card: pass --card ID/);
  await refused(
    startRun(dir, input({ role: 'storyteller' })),
    /a storyteller needs --pr N, --branch NAME or --card ID/,
  );
  await refused(
    startRun(dir, input({ name: 'story-9' })),
    /a story run needs --role storyteller with --pr N/,
  );
  await startRun(dir, input({ name: 'story-9', role: 'storyteller', branch: 'feat/y' }));
  assert.equal(starts(dir).length, 1);
});

test('an editor is not started here', async () => {
  const dir = home('editor');
  await refused(startRun(dir, input({ kind: 'editor' })), /once-upon editor start --slots N/);
  await refused(startRun(dir, input({ slots: '3' })), /once-upon editor start --slots N/);
});

test('flags a card answers are refused all at once, and nothing is written', async () => {
  const dir = home('flags');
  const id = card(dir);
  await refused(
    startRun(
      dir,
      input({ card: id, kind: 'author', repo: 'acme/widgets', branch: 'feat/z', lane: 'l' }),
    ),
    /--kind, --repo, --branch, --lane are not taken with --card/,
  );
  assert.equal(existsSync(agentsFile(dir)), false);
  assert.equal(new BacklogStore(dir).items()[0].branch, 'feat/x', 'the card is as it was');
});

test('an author starts on a card with no claim, and one author runs on a card at a time', async () => {
  const dir = home('claim');
  const id = card(dir);
  await startRun(dir, input({ card: id, role: 'author' }));
  assert.equal(
    readFileSync(new BacklogStore(dir).file, 'utf8').includes('"op":"claim"'),
    false,
    'no claim row is written',
  );
  await refused(
    startRun(dir, input({ name: 'ou-b', card: id, role: 'author' })),
    /already has an open author/,
  );
});

test('an unknown card is refused', async () => {
  const dir = home('unknown');
  await refused(
    startRun(dir, input({ role: 'critic', card: 'bl_nope0000000000' })),
    /no backlog card|not a backlog card|unknown card|no card/i,
  );
});

test('a typed branch stamps a card that has none, after the run is accepted', async () => {
  const dir = home('stamp-branch');
  const id = card(dir, null);
  const started = await startRun(dir, input({ card: id, role: 'author', branch: 'feat/typed' }));
  assert.deepEqual(started.stamped, { branch: 'feat/typed', repo: 'acme/widgets' });
  assert.equal(new BacklogStore(dir).items()[0].branch, 'feat/typed');
  assert.equal(new AgentRegistry(dir).agents()[0].branch, 'feat/typed');
});

test('--pr stamps the card with the PR head branch from gh', async () => {
  const dir = home('stamp-pr');
  const id = card(dir, null);
  const asked: unknown[] = [];
  const started = await startRun(dir, input({ card: id, role: 'author', pr: '42' }), {
    prHead: async (repo, pr) => {
      asked.push([repo, pr]);
      return 'feat/from-pr';
    },
  });
  assert.deepEqual(asked, [['acme/widgets', 42]]);
  assert.equal(started.stamped?.branch, 'feat/from-pr');
  assert.equal(new BacklogStore(dir).items()[0].branch, 'feat/from-pr');
});

test('gh failing warns and starts anyway, except for a storyteller with nothing else to read', async () => {
  const dir = home('gh-down');
  const { lines, io } = warnings();
  const prHead = async () => {
    throw new Error('offline');
  };
  await startRun(dir, input({ kind: 'helper', pr: '7', repo: 'acme/widgets' }), { ...io, prHead });
  assert.match(lines.join('\n'), /gh could not read #7: offline/);
  await refused(
    startRun(dir, input({ name: 'story-7', role: 'storyteller', pr: '7', repo: 'acme/widgets' }), {
      prHead,
    }),
    /gh could not read #7: offline; pass --branch NAME/,
  );
});

test('a refused start leaves the card untouched: the run is written first, the card second', async () => {
  const dir = home('write-order');
  const id = card(dir, null);
  await startRun(dir, input({ name: 'ou-a', card: id, role: 'author' }));
  // another author is open: the registry refuses the second before anything is written
  await refused(
    startRun(dir, input({ name: 'ou-b', card: id, role: 'author', branch: 'feat/typed' })),
    /already has an open author/,
  );
  assert.equal(new BacklogStore(dir).items()[0].branch, null);
  assert.equal(starts(dir).length, 1);
});

test('mirror none writes no ledger or progress line; ledger writes the ledger only', async () => {
  const dir = home('mirror');
  const notes = tmp('runs-notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(ledger, '');
  writeFileSync(progress, '');
  writeJson(path.join(dir, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
  });
  await startRun(dir, input({ name: 'quiet', kind: 'helper' }), { mirror: 'none' });
  assert.equal(readFileSync(ledger, 'utf8'), '');
  await startRun(dir, input({ name: 'loud', kind: 'helper' }));
  assert.match(readFileSync(ledger, 'utf8'), /loud/);
  finishRun(dir, 'loud', { sid: SID }, { mirror: 'ledger' });
  assert.match(readFileSync(ledger, 'utf8'), /\[done\].* loud/);
  assert.equal(readFileSync(progress, 'utf8').includes('[done]'), false);
});

test('moveBranch writes the card first, then each open run, and says unchanged when nothing moved', async () => {
  const dir = home('move');
  const id = card(dir, 'feat/old');
  await startRun(dir, input({ card: id, role: 'author' }));
  await startRun(dir, input({ name: 'rev-a', card: id, role: 'critic' }));
  finishRun(dir, 'rev-a', { sid: SID, findings: 0 });
  const moved = moveBranch(dir, id, 'feat/new', 'me');
  assert.deepEqual(moved, {
    id,
    from: 'feat/old',
    to: 'feat/new',
    runsMoved: 1,
    unchanged: false,
  });
  assert.equal(new BacklogStore(dir).items()[0].branch, 'feat/new');
  const byName = Object.fromEntries(new AgentRegistry(dir).agents().map((one) => [one.name, one]));
  assert.equal(byName['ou-a'].branch, 'feat/new');
  assert.equal(byName['rev-a'].branch, 'feat/old', 'a finished run is not touched');
  const eventsBefore = new AgentRegistry(dir).events().length;
  assert.equal(moveBranch(dir, id, 'feat/new').unchanged, true);
  assert.equal(new AgentRegistry(dir).events().length, eventsBefore, 'nothing written');
});

test('moveBranch refuses a missing card, a missing branch and a landed card', () => {
  const dir = home('move-refuse');
  const id = card(dir, 'feat/old');
  assert.throws(() => moveBranch(dir, 'bl_nope', 'x'), /no backlog item bl_nope/);
  assert.throws(() => moveBranch(dir, id, undefined), /a new branch is needed/);
  new BacklogStore(dir).done(id, { sha: 'abc1234' });
  assert.throws(() => moveBranch(dir, id, 'x'), /is done: its work landed/);
});

test('a critic on a card finishes with a findings count; 0 counts, stopped and uncarded runs do not need one', async () => {
  const dir = home('finish');
  const id = card(dir);
  await startRun(dir, input({ name: 'rev-a', card: id, role: 'critic' }));
  assert.throws(() => finishRun(dir, 'rev-a', { sid: SID }), /findings count: --findings N/);
  assert.equal(
    new AgentRegistry(dir).agents().find((one) => one.name === 'rev-a')?.state,
    'running',
    'still running',
  );
  assert.equal(finishRun(dir, 'rev-a', { sid: SID, findings: 0 }).state, 'done');
  await startRun(dir, input({ name: 'rev-b', card: id, role: 'critic' }));
  assert.equal(finishRun(dir, 'rev-b', { sid: SID, state: 'stopped' }).state, 'stopped');
  await startRun(dir, input({ name: 'helper-a', role: 'helper' }));
  assert.equal(finishRun(dir, 'helper-a', { sid: SID }).state, 'done');
});

/** A no-card helper start, as a research session fans them out. */
const helper = (over: Partial<RunStartInput> = {}) =>
  input({ name: 'flag-adr-2', kind: 'helper', repo: 'acme/widgets', ...over });
const onCard = (id: string, over: Partial<RunStartInput> = {}) =>
  input({ name: 'on-card', role: 'helper', card: id, ...over });
const HOUR = 3_600_000;

test('a second no-card start by the same session in the same repo names the earlier card', async () => {
  const dir = home('related');
  const first = await startRun(dir, helper({ name: 'flag-adr-1' }));
  assert.deepEqual(first.related, []);
  const second = await startRun(dir, helper());
  assert.notEqual(second.card, first.card);
  assert.deepEqual(
    second.related.map((one) => [one.run, one.card]),
    [['flag-adr-1', first.card]],
  );
  // a same-name restart carries its card over: no hint
  assert.deepEqual((await startRun(dir, helper())).related, []);
});

test('no related run for another session or repo, branches that differ, or a run on a backlog card', async () => {
  const dir = home('related-none');
  await startRun(dir, helper({ name: 'one', branch: 'feat/a' }));
  assert.deepEqual((await startRun(dir, helper({ sid: 'ffff0000' }))).related, [], 'other session');
  assert.deepEqual(
    (await startRun(dir, helper({ repo: 'acme/other', name: 'two' }))).related,
    [],
    'other repo',
  );
  assert.deepEqual(
    (await startRun(dir, helper({ branch: 'feat/b', name: 'three' }))).related,
    [],
    'two branches',
  );
  assert.equal(
    (await startRun(dir, helper({ name: 'four' }))).related.length,
    2,
    'a side with no branch matches feat/a and feat/b',
  );
  const backlogDir = home('related-backlog');
  await startRun(backlogDir, onCard(card(backlogDir, 'feat/x'), { name: 'one' }));
  assert.deepEqual((await startRun(backlogDir, helper())).related, [], 'a run on a backlog card');
});

test('an earlier run counts for four hours from its last activity', async () => {
  const now = Date.now();
  const old = home('related-old');
  await startRun(old, helper({ name: 'one', at: new Date(now - 5 * HOUR) }));
  assert.deepEqual((await startRun(old, helper())).related, [], 'five hours');
  const young = home('related-young');
  await startRun(young, helper({ name: 'one', at: new Date(now - 3 * HOUR) }));
  const [hit] = (await startRun(young, helper())).related;
  assert.equal(hit.run, 'one');
  assert.ok(hit.minutesAgo >= 179 && hit.minutesAgo <= 181, String(hit.minutesAgo));
});

test('no related run when the start named its card, asked for another, joined a card, or is a self, critic or standing run', async () => {
  const dir = home('related-skip');
  await startRun(dir, helper({ name: 'one' }));
  const id = card(dir, 'feat/x');
  assert.deepEqual((await startRun(dir, onCard(id, { name: 'two' }))).related, [], '--card');
  assert.deepEqual(
    (await startRun(dir, helper({ name: 'three', newCard: true }))).related,
    [],
    '--new-card',
  );
  const self = await startRun(dir, {
    name: '',
    task: 'mine',
    cwd: CWD,
    self: true,
    role: 'helper',
    session: `${SID}-1111-4222-8333-444444444444`,
  });
  assert.deepEqual(self.related, [], '--self');
  const critic = await startRun(dir, onCard(id, { name: 'rev-a', role: 'critic' }));
  assert.deepEqual(critic.related, [], 'a critic');
  assert.deepEqual(
    (await startRun(dir, helper({ name: 'five', standing: true }))).related,
    [],
    'a standing run',
  );
  const joined = await startRun(dir, helper({ name: 'four', branch: 'feat/x' }));
  assert.ok(joined.joined, 'joined the open card on feat/x');
  assert.deepEqual(joined.related, [], 'a start that joined a card');
});

test('the hint names the newest three earlier cards, one per card', async () => {
  const dir = home('related-three');
  for (const [index, name] of ['a1', 'a2', 'a3', 'a4'].entries()) {
    await startRun(dir, helper({ name, at: new Date(Date.now() - (5 - index) * 60_000) }));
  }
  const { related } = await startRun(dir, helper({ name: 'a5' }));
  assert.deepEqual(
    related.map((one) => one.run),
    ['a4', 'a3', 'a2'],
  );
});

test('no related run for an author the start itself swept after 24 silent hours', async () => {
  const dir = home('related-swept');
  await startRun(
    dir,
    helper({
      name: 'old-author',
      kind: 'author',
      branch: 'feat/a',
      at: new Date(Date.now() - 26 * HOUR),
    }),
  );
  const { related } = await startRun(dir, helper());
  assert.deepEqual(related, [], 'a run the sweep just stopped is not recent');
  assert.equal(
    new AgentRegistry(dir).agents().find((one) => one.name === 'old-author')?.state,
    'stopped',
  );
});

test("no related run for a run that joined another session's agent card with --card", async () => {
  const dir = home('related-foreign-card');
  const other = await startRun(
    dir,
    helper({ name: 'other-one', sid: 'ffff0000', branch: 'feat/z' }),
  );
  assert.ok(other.card);
  await startRun(dir, onCard(other.card, { name: 'rev-x', role: 'critic' }));
  assert.deepEqual((await startRun(dir, helper())).related, [], 'rev-x did not make the card');
});
