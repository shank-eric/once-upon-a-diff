import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { claimAt, git, localRepo, runCli, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { approvalOf, forgetTips, readApproval } from '@once-upon-a-diff/stories/approval';
import { REVIEW_FILE, readReviewRecord } from '@once-upon-a-diff/stories/review-record';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import { localEntries } from '@once-upon-a-diff/core/features/review/story-lists';
import { columnOf } from '@once-upon-a-diff/board/columns';
import { markLandedWorks, nestClaimedAgents } from '@once-upon-a-diff/board/stages/backlog';

// The card's side of Approve: approving finishes the card's story run, and a fixer's finish carries the approval to its
// commit. (The landed card going to Done is the 8-landed-ship board world.)
const SID = 'abcd1234';

/** A local story on `feature` (following HEAD, or pinned to the branch with `--head feature`), and the backlog card started on that branch. */
function world(told = 'HEAD') {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      {
        refs: [],
        title: 'Chapter 1',
        narrative: 'Told.',
        files: ['one.txt', 'lib/two.js', 'gone.txt'],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: told, chapters });
  const backlog = new BacklogStore(home);
  const item = backlog.add({ title: 'The work', repo: 'acme/widgets' });
  backlog.start(item.id, { branch: 'feature' });
  claimAt(backlog, item.id, 'ship-author', new Date().toISOString(), SID);
  const store = new StoryStore({ home });
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const commit = (name: string) => {
    writeFileSync(path.join(repo, name), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    return head();
  };
  const cli = (...args: string[]) => runCli(home, args);
  const runs = () => new AgentRegistry(home).agents();
  const startRun = (name: string, role: string, card = item.id) =>
    cli('agent', 'start', name, '--role', role, '--card', card, '--task', 't', '--sid', SID);
  return { home, repo, id, card: item.id, store, head, commit, cli, runs, startRun, backlog };
}

test('approve finishes the card’s open story run, once, and --undo leaves it', async () => {
  const { id, cli, runs, startRun } = world();
  assert.equal((await startRun('tell-it', 'storyteller')).code, 0);
  assert.equal(
    (
      await cli(
        'agent',
        'state',
        'tell-it',
        '--state',
        'review',
        '--outcome',
        'story',
        '--sid',
        SID,
      )
    ).code,
    0,
  );
  const other = await startRun('someone-else', 'critic');
  assert.equal(other.code, 0, other.stderr);
  const approved = await cli('approve', id);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /approved at .*1 story run finished/);
  const told = runs().find((run) => run.name === 'tell-it');
  assert.equal(told?.state, 'done');
  assert.match(told?.outcome ?? '', /^story approved at [0-9a-f]{7}$/);
  assert.equal(
    runs().find((run) => run.name === 'someone-else')?.state,
    'running',
    'a critic stays',
  );

  // already approved at that head: nothing more is finished, and a new run is left by --undo
  assert.equal((await startRun('tell-again', 'storyteller')).code, 0);
  assert.match((await cli('approve', id)).stdout, /already approved/);
  assert.equal(runs().find((run) => run.name === 'tell-again')?.state, 'running');
  assert.equal((await cli('approve', id, '--undo')).code, 0);
  assert.equal(runs().find((run) => run.name === 'tell-again')?.state, 'running');
});

test('no finish but a fixer’s own commit at the branch tip carries the approval', async () => {
  const { id, card, store, head, commit, cli, startRun, home } = world();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  const second = commit('two.txt');
  assert.notEqual(first, second);
  assert.equal(approvalOf(store, id, second), null, 'the new head is not approved on its own');

  // an author's commit on the card carries nothing
  assert.equal(
    (
      await cli(
        'agent',
        'start',
        'plain-author',
        '--role',
        'author',
        '--card',
        card,
        '--task',
        't',
        '--sid',
        SID,
      )
    ).code,
    0,
  );
  const plain = await cli(
    'agent',
    'finish',
    'plain-author',
    '--commit',
    second,
    '--card',
    card,
    '--sid',
    SID,
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(readApproval(store, id)?.head_oid, first);
  assert.doesNotMatch(plain.stdout, /carried/);

  // a fixer on another card carries nothing
  const elsewhere = new BacklogStore(home).add({ title: 'Else', repo: 'acme/widgets' });
  new BacklogStore(home).start(elsewhere.id, { branch: 'other' });
  claimAt(new BacklogStore(home), elsewhere.id, 'fix-else', new Date().toISOString(), SID);
  const fixerElse = await startRun('fix-else', 'fixer', elsewhere.id);
  assert.equal(fixerElse.code, 0, fixerElse.stderr);
  await cli(
    'agent',
    'finish',
    'fix-else',
    '--commit',
    second,
    '--card',
    elsewhere.id,
    '--sid',
    SID,
  );
  assert.equal(readApproval(store, id)?.head_oid, first);

  // a fixer's commit that is not the branch tip carries nothing
  assert.equal((await startRun('fix-stale', 'fixer')).code, 0);
  await cli('agent', 'finish', 'fix-stale', '--commit', first, '--card', card, '--sid', SID);
  assert.equal(readApproval(store, id)?.head_oid, first);
});

const finishArgs = (name: string, commit: string, card: string) => [
  'agent',
  'finish',
  name,
  '--commit',
  commit,
  '--card',
  card,
  '--sid',
  SID,
];

for (const head of ['HEAD', 'feature']) {
  test(`a fixer’s finish --commit carries the approval to its commit (story told over --head ${head})`, async () => {
    const { id, card, store, head: tipOf, commit, cli, runs, startRun } = world(head);
    assert.equal((await cli('approve', id)).code, 0);
    const first = tipOf();
    assert.equal((await startRun('fix-it', 'fixer')).code, 0);
    const second = commit('two.txt');
    const fixed = await cli(...finishArgs('fix-it', second, card));
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(fixed.stdout, /approval carried/);
    const carried = readApproval(store, id);
    assert.equal(carried?.head_oid, second);
    assert.equal(carried?.carried?.from, first);
    assert.equal(carried?.carried?.run, runs().find((run) => run.name === 'fix-it')?.run);
    // what the board and the page read: the story's own head (a pinned story keeps the one it was told over)
    forgetTips(); // the CLI ran in another process: this one still knows the branch's old tip for 2 s
    const entry = localEntries(store, { now: Date.now() })[0];
    assert.ok(entry.story.approved_at, 'still approved, so still Ready to ship');
    assert.equal(entry.story.approved_head, second);
    assert.match((await cli('approve', id)).stdout, /already approved/);

    // a second fixer round on top carries it on again
    assert.equal((await startRun('fix-again', 'fixer')).code, 0);
    const third = commit('three.txt');
    assert.match((await cli(...finishArgs('fix-again', third, card))).stdout, /approval carried/);
    assert.equal(readApproval(store, id)?.head_oid, third);
    assert.equal(readApproval(store, id)?.carried?.from, first);
    forgetTips();
    assert.ok(localEntries(store, { now: Date.now() })[0].story.approved_at);
  });
}

test('a commit made before the fixer’s run is not carried, even when the fixer is at the tip', async () => {
  const { id, card, store, head, commit, cli, startRun } = world();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  commit('someone-else.txt');
  // git stamps commits to the second: the fixer starts in a later one
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await startRun('fix-it', 'fixer')).code, 0);
  const second = commit('two.txt');
  const done = await cli(...finishArgs('fix-it', second, card));
  assert.doesNotMatch(done.stdout, /carried/);
  assert.equal(readApproval(store, id)?.head_oid, first);
});

test('a fixer on an implicit card (no backlog row) carries by its own repo and branch', async () => {
  const { id, store, head, commit, cli, home, startRun } = world();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  // ad-hoc work on the story's branch: an author run with no backlog card of its own mints the implicit one
  const author = await cli(
    'agent',
    'start',
    'adhoc-author',
    '--role',
    'author',
    '--repo',
    'acme/widgets',
    '--branch',
    'feature',
    '--task',
    't',
    '--sid',
    SID,
  );
  assert.equal(author.code, 0, author.stderr);
  const adhoc = new AgentRegistry(home).agents().find((run) => run.name === 'adhoc-author')
    ?.card as string;
  const ended = await cli('agent', 'finish', 'adhoc-author', '--sid', SID);
  assert.equal(ended.code, 0, ended.stderr);
  const started = await startRun('fix-adhoc', 'fixer', adhoc);
  assert.equal(started.code, 0, started.stderr);
  assert.match(adhoc, /^ic_/);
  const second = commit('two.txt');
  const done = await cli(...finishArgs('fix-adhoc', second, adhoc));
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /approval carried/);
  assert.equal(readApproval(store, id)?.head_oid, second);
  assert.notEqual(first, second);
});

/** A repo on `main` (a.txt, b.txt) with `feature` one commit ahead (it edits a.txt's first line), the story told main..HEAD over it, and a card on `feature`. */
function rebaseWorld(extra = 0) {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const repo = tmp('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  writeFileSync(path.join(repo, 'a.txt'), '1\n2\n3\n4\n5\n6\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  const edit = (file: string, text: string, message: string) => {
    writeFileSync(path.join(repo, file), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', message);
  };
  edit('a.txt', 'one\n2\n3\n4\n5\n6\n', 'edit the top');
  for (let one = 0; one < extra; one += 1) {
    edit(`more${one}.txt`, 'more\n', `more ${one}`);
  }
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'One commit',
    chapters: [
      {
        refs: [],
        title: 'Chapter 1',
        narrative: 'Told.',
        files: ['a.txt', ...Array.from({ length: extra }, (_, one) => `more${one}.txt`)],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base: 'main', head: 'HEAD', chapters });
  const backlog = new BacklogStore(home);
  const item = backlog.add({ title: 'The work', repo: 'acme/widgets' });
  backlog.start(item.id, { branch: 'feature' });
  claimAt(backlog, item.id, 'ship-author', new Date().toISOString(), SID);
  const store = new StoryStore({ home });
  const cli = (...args: string[]) => runCli(home, args);
  const startRun = (name: string, role: string) =>
    cli('agent', 'start', name, '--role', role, '--card', item.id, '--task', 't', '--sid', SID);
  /** main moves on: a new commit on it (touching `file`), as a deploy's cherry-pick or another merge would */
  const moveMain = (file: string, text: string) => {
    git(repo, 'checkout', '-q', 'main');
    edit(file, text, `main moves ${file}`);
    git(repo, 'checkout', '-q', 'feature');
  };
  const head = () => git(repo, 'rev-parse', 'HEAD');
  return { home, repo, id, card: item.id, store, cli, startRun, moveMain, head, edit };
}

/** git stamps commits to the second: a run starts in a later one than the commits before it */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

test('a fixer’s rebase of the approved commit onto a moved main carries the approval, recorded as a rebase', async () => {
  const { id, card, store, cli, startRun, moveMain, head, repo } = rebaseWorld();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  const approvedAt = readApproval(store, id)?.at;
  moveMain('b.txt', 'b2\n');
  await nextSecond();
  assert.equal((await startRun('rebase-it', 'fixer')).code, 0);
  git(repo, 'rebase', 'main');
  const second = head();
  assert.notEqual(first, second);
  const done = await cli(...finishArgs('rebase-it', second, card));
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /approval carried .*rebase/);
  const carried = readApproval(store, id);
  assert.equal(carried?.head_oid, second);
  assert.equal(carried?.base_oid, git(repo, 'rev-parse', 'main'));
  assert.equal(carried?.at, approvedAt);
  assert.equal(carried?.carried?.from, first);
  assert.equal(carried?.carried?.via, 'rebase');
  assert.ok(localEntries(store, { now: Date.now() })[0].story.approved_at, 'still Ready to ship');
});

test('a fixer’s rebase onto another unlanded branch (a stack above main) carries the approval too', async () => {
  const { id, card, store, cli, startRun, head, repo, edit } = rebaseWorld();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  // another branch, not landed in main, with a commit of its own
  git(repo, 'checkout', '-q', '-b', 'other', 'main');
  edit('b.txt', 'other\n', 'other work');
  git(repo, 'checkout', '-q', 'feature');
  await nextSecond();
  assert.equal((await startRun('rebase-it', 'fixer')).code, 0);
  git(repo, 'rebase', 'other');
  const second = head();
  assert.notEqual(first, second);
  const done = await cli(...finishArgs('rebase-it', second, card));
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /approval carried .*rebase/, done.stderr);
  const carried = readApproval(store, id);
  assert.equal(carried?.head_oid, second);
  assert.equal(carried?.base_oid, git(repo, 'rev-parse', 'other'));
  assert.equal(carried?.carried?.from, first);
});

test('a fixer’s rebase with a conflict resolved in the commit carries the approval too', async () => {
  const { id, card, store, cli, startRun, moveMain, head, repo } = rebaseWorld();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  moveMain('a.txt', 'uno\n2\n3\n4\n5\n6\n');
  await nextSecond();
  assert.equal((await startRun('rebase-it', 'fixer')).code, 0);
  assert.throws(() => git(repo, 'rebase', 'main'));
  writeFileSync(path.join(repo, 'a.txt'), 'one\n2\n3\n4\n5\n6\nseven\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'core.editor=true', 'rebase', '--continue');
  const second = head();
  assert.notEqual(first, second);
  const done = await cli(...finishArgs('rebase-it', second, card));
  assert.match(done.stdout, /approval carried .*rebase/, done.stderr);
  const carried = readApproval(store, id);
  assert.equal(carried?.head_oid, second);
  assert.equal(carried?.carried?.via, 'rebase');
});

test('a rebase by a run that is not a fixer carries nothing', async () => {
  const { id, card, store, cli, startRun, moveMain, head, repo } = rebaseWorld();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  moveMain('b.txt', 'b2\n');
  await nextSecond();
  assert.equal((await startRun('rebase-it', 'author')).code, 0);
  git(repo, 'rebase', 'main');
  const done = await cli(...finishArgs('rebase-it', head(), card));
  assert.doesNotMatch(done.stdout, /carried/);
  assert.equal(readApproval(store, id)?.head_oid, first);
});

test('a fixer’s rebase that also adds a commit carries nothing', async () => {
  const world = rebaseWorld();
  assert.equal((await world.cli('approve', world.id)).code, 0);
  const first = world.head();
  world.moveMain('b.txt', 'b2\n');
  await nextSecond();
  assert.equal((await world.startRun('rebase-add', 'fixer')).code, 0);
  git(world.repo, 'rebase', 'main');
  world.edit('extra.txt', 'x\n', 'something else');
  const done = await world.cli(...finishArgs('rebase-add', world.head(), world.card));
  assert.doesNotMatch(done.stdout, /carried/);
  assert.equal(readApproval(world.store, world.id)?.head_oid, first);
});

test('a fixer’s rebase that also drops a commit carries nothing', async () => {
  const world = rebaseWorld(1);
  assert.equal((await world.cli('approve', world.id)).code, 0);
  const first = world.head();
  world.moveMain('b.txt', 'b2\n');
  await nextSecond();
  assert.equal((await world.startRun('rebase-drop', 'fixer')).code, 0);
  git(world.repo, 'rebase', 'main');
  git(world.repo, 'reset', '-q', '--hard', 'HEAD~1');
  const done = await world.cli(...finishArgs('rebase-drop', world.head(), world.card));
  assert.doesNotMatch(done.stdout, /carried/);
  assert.equal(readApproval(world.store, world.id)?.head_oid, first);
});

test('approve leaves a storyteller that is still running, and finishes an implicit card’s parked one', async () => {
  const { id, card, cli, runs, startRun } = world();
  assert.equal((await startRun('still-writing', 'storyteller')).code, 0);
  const parked = await cli(
    'agent',
    'start',
    'parked-adhoc',
    '--role',
    'storyteller',
    '--new-card',
    '--repo',
    'acme/widgets',
    '--branch',
    'feature',
    '--task',
    't',
    '--sid',
    SID,
  );
  assert.equal(parked.code, 0, parked.stderr);
  const state = await cli(
    'agent',
    'state',
    'parked-adhoc',
    '--state',
    'review',
    '--outcome',
    'story',
    '--sid',
    SID,
  );
  assert.equal(state.code, 0, state.stderr);
  assert.notEqual(runs().find((run) => run.name === 'parked-adhoc')?.card, card);
  assert.equal((await cli('approve', id)).code, 0);
  assert.equal(runs().find((run) => run.name === 'still-writing')?.state, 'running');
  assert.equal(runs().find((run) => run.name === 'parked-adhoc')?.state, 'done');
});

/** Approves, moves the branch, lets the background check lapse the approval, and marks the story reviewed by hand. */
async function lapsedThenMarked() {
  const setup = world();
  assert.equal((await setup.cli('approve', setup.id)).code, 0);
  setup.commit('two.txt');
  const now = Date.now();
  const review = new AutoReview(setup.store, async () => ({ merged: false, why: null }), 0);
  review.kickLocal(localEntries(setup.store, { now }), now);
  await review.idle();
  assert.equal(readApproval(setup.store, setup.id)?.lapsed, true);
  assert.equal(readReviewRecord(setup.store, setup.id)?.mark, undefined);
  assert.equal((await setup.cli('reviewed', setup.id)).code, 0);
  return setup;
}
const marked = (setup: ReturnType<typeof world>) =>
  !!readReviewRecord(setup.store, setup.id)?.mark?.at;

test('a hand mark made after a lapse survives re-approving and undoing', async () => {
  const setup = await lapsedThenMarked();
  assert.equal((await setup.cli('approve', setup.id)).code, 0);
  assert.equal(readApproval(setup.store, setup.id)?.lapsed, undefined, 'a fresh approval');
  assert.equal(marked(setup), true, 'your hand mark stays under it');
  assert.equal((await setup.cli('approve', setup.id, '--undo')).code, 0);
  assert.equal(marked(setup), true, 'your hand mark stays');
});

test('undoing a lapsed approval leaves the story’s own mark', async () => {
  const setup = await lapsedThenMarked();
  assert.equal((await setup.cli('approve', setup.id, '--undo')).code, 0);
  assert.equal(readApproval(setup.store, setup.id), null);
  assert.equal(marked(setup), true);
});

test('a lapsed approval (the watcher saw the new tip first) is carried; an undone one is not; an expired one is not', async () => {
  const { id, card, store, commit, cli, startRun, head } = world();
  assert.equal((await cli('approve', id)).code, 0);
  const first = head();
  assert.equal((await startRun('fix-it', 'fixer')).code, 0);
  const second = commit('two.txt');
  // the background check clears the approval as soon as the branch tip differs from it
  const now = Date.now();
  const review = new AutoReview(store, async () => ({ merged: false, why: null }), 0);
  review.kickLocal(localEntries(store, { now }), now);
  await review.idle();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.equal(lapsed?.head_oid, first);
  assert.equal(approvalOf(store, id, first), null, 'a lapsed approval counts for nothing');
  assert.equal(localEntries(store, { now })[0].story.approved_at, null);
  assert.equal(
    localEntries(store, { now })[0].story.reviewed_at,
    null,
    'the approved mark went with it',
  );

  const fixed = await cli(...finishArgs('fix-it', second, card));
  assert.match(fixed.stdout, /approval carried/);
  assert.equal(readApproval(store, id)?.lapsed, undefined);
  assert.equal(approvalOf(store, id, second)?.head_oid, second);
  assert.equal(
    localEntries(store, { now })[0].story.reviewed_by,
    'approved',
    'the approved mark is back with the approval',
  );

  // undone, then the branch moves and a fixer finishes: nothing to carry
  assert.equal((await cli('approve', id, '--undo')).code, 0);
  assert.equal((await startRun('fix-two', 'fixer')).code, 0);
  const third = commit('three.txt');
  const none = await cli(
    'agent',
    'finish',
    'fix-two',
    '--commit',
    third,
    '--card',
    card,
    '--sid',
    SID,
  );
  assert.doesNotMatch(none.stdout, /carried/);
  assert.equal(readApproval(store, id), null);

  // an approval older than the window is not carried
  assert.equal((await cli('approve', id)).code, 0);
  const old = readApproval(store, id);
  store.writeState(id, REVIEW_FILE, { approval: { ...old, at: '2020-01-01T00:00:00.000Z' } });
  assert.equal((await startRun('fix-three', 'fixer')).code, 0);
  const fourth = commit('four.txt');
  const expired = await cli(
    'agent',
    'finish',
    'fix-three',
    '--commit',
    fourth,
    '--card',
    card,
    '--sid',
    SID,
  );
  assert.doesNotMatch(expired.stdout, /carried/);
  assert.equal(readApproval(store, id)?.head_oid, third);
});

test('a landed local story (no PR) is Done whatever else, but a running agent still wins', () => {
  const none = { sessions: [], agents: [], pr: null };
  const story = {
    reviewed: true,
    manualReviewedAt: null,
    unread: false,
    local: true,
    approved: true,
    landed: true,
  };
  assert.equal(columnOf({ ...none, story }), 'done');
  assert.equal(
    columnOf({ ...none, story: { ...story, approved: false, reviewed: false } }),
    'done',
  );
  assert.equal(columnOf({ ...none, story: { ...story, landed: false } }), 'ship');
  assert.equal(
    columnOf({ ...none, agents: [{ status: 'working', state: 'running' }], story }),
    'working',
  );
  const pr = { state: 'open' } as never;
  assert.notEqual(columnOf({ ...none, pr, story }), 'done', 'a PR story follows the PR');
});

// markLandedWorks over bare cards: which story a landing belongs to, and what is left of the card an hour on
const HOUR = 3600 * 1000;
const START = Date.parse('2026-11-12T12:00:00Z');
const iso = (millis: number) => new Date(millis).toISOString();
function landing(
  over: {
    item?: Record<string, unknown>;
    built?: number;
    approved?: number | null;
    card?: Record<string, unknown>;
  } = {},
) {
  const item = {
    id: 'bl_one',
    state: 'started',
    repo: 'acme/widgets',
    branch: 'feature',
    started_at: iso(START - 5 * HOUR),
    landed_at: iso(START - 30 * 60000),
    ...over.item,
  };
  const card = {
    id: 'work:1',
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'feature',
    pr: null,
    sessions: [],
    agents: [],
    story: {
      id: 's1',
      kind: 'local',
      approved_at: iso(over.approved ?? START - 2 * HOUR),
    },
    ...over.card,
  };
  if (over.approved === null) {
    (card.story as { approved_at: string | null }).approved_at = null;
  }
  const stories = new Map([['s1', { built_at: iso(over.built ?? START - 3 * HOUR) }]]);
  const cards = [card];
  const run = (now: number, agents: unknown[] = []) =>
    markLandedWorks([item] as never, cards as never, now, stories as never, agents as never);
  return { card, cards, run };
}

test('a landed card whose state is still open marks its story landed', () => {
  const { card, run } = landing({ item: { state: 'open', started_at: null } });
  run(START);
  assert.deepEqual((card as { landed?: unknown }).landed, {
    card: 'bl_one',
    at: iso(START - 30 * 60000),
  });
});

test('a story told or approved after the landing, or before the card started, is not the landed card’s', () => {
  for (const over of [
    { built: START - 10 * 60000 },
    { approved: START - 10 * 60000 },
    { built: START - 6 * HOUR },
  ]) {
    const { card, cards, run } = landing(over);
    run(START + 3 * HOUR);
    assert.equal((card as { landed?: unknown }).landed, undefined);
    assert.equal(cards.length, 1, 'and it is not taken off the board an hour on');
  }
  const own = landing({ approved: null });
  own.run(START);
  assert.ok(
    (own.card as { landed?: unknown }).landed,
    'an unapproved story of its own still lands',
  );
});

test('an hour after the landing the card leaves, unless a session or an unfinished agent is on it', () => {
  const alone = landing();
  alone.run(START + 2 * HOUR);
  assert.equal(alone.cards.length, 0);
  const busy = landing({ card: { sessions: [{ id: 'x' }] } });
  busy.run(START + 2 * HOUR);
  assert.equal(busy.cards.length, 1);
  assert.equal((busy.card as { story: unknown }).story, null, 'without the landed story');
  const running = landing({ card: { agents: [{ id: 'a', state: 'running' }] } });
  running.run(START + 2 * HOUR);
  assert.equal(running.cards.length, 1);
  const finished = landing({ card: { agents: [{ id: 'a', state: 'done' }] } });
  finished.run(START + 2 * HOUR);
  assert.equal(finished.cards.length, 0, 'an agent that is done does not hold it');
});

test('an agent that ended after the landing, within the hour, keeps the card a while longer', () => {
  const ended = (when: number) => ({
    key: 'aaaaaaaa:fix',
    state: 'failed',
    ended_at: iso(when),
  });
  const late = landing({ card: { agents: [ended(START + 90 * 60000)] } });
  late.run(START + 2 * HOUR);
  assert.equal(late.cards.length, 1, 'a failed fixer after the landing is still news');
  assert.equal((late.card as { story: unknown }).story, null);
  const old = landing({ card: { agents: [ended(START + 90 * 60000)] } });
  old.run(START + 3 * HOUR);
  assert.equal(old.cards.length, 0, 'an hour after it ended it leaves too');
  const before = landing({ card: { agents: [ended(START - 40 * 60000)] } });
  before.run(START + 2 * HOUR);
  assert.equal(before.cards.length, 0, 'an agent that ended before the landing does not hold it');
});

test('a landed card whose item is still open shows its running agent', () => {
  const item = {
    id: 'bl_one',
    state: 'open',
    repo: 'acme/widgets',
    branch: 'feature',
    landed_at: iso(START),
  };
  const work = { kind: 'work', repo: 'acme/widgets', branch: 'feature', agents: [] as unknown[] };
  const view = { key: 'aaaaaaaa:ou-x', name: 'ou-x', state: 'running' };
  nestClaimedAgents([item] as never, [work] as never, new Map([['bl_one', [view]]]) as never);
  assert.deepEqual(work.agents, [view]);
  const unlanded = { ...work, agents: [] as unknown[] };
  nestClaimedAgents(
    [{ ...item, landed_at: null }] as never,
    [unlanded] as never,
    new Map([['bl_one', [view]]]) as never,
  );
  assert.equal(unlanded.agents.length, 0, 'an open item that has not landed nests nothing');
});

test('a forgotten waiting agent does not keep a landed card', () => {
  const agent = { key: 'aaaaaaaa:ou-x', state: 'waiting', ended_at: null };
  const quiet = landing({ card: { agents: [agent] } });
  const now = START + 2 * HOUR;
  const ledger = (since: number) => [
    { sid: 'aaaaaaaa', name: 'ou-x', state: 'waiting', started: new Date(since), ended: null },
  ];
  quiet.run(now, ledger(now - 25 * HOUR));
  assert.equal(quiet.cards.length, 0, 'silent for a day: left behind');
  const recent = landing({ card: { agents: [agent] } });
  recent.run(now, ledger(now - 2 * HOUR));
  assert.equal(recent.cards.length, 1, 'a waiting agent that is still in touch holds it');
});
