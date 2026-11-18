/*
 * The card keeper (core/src/features/cards/card-keeper.ts): a board build learns the work it saw (board/src/stages/learned.ts) and the
 * keeper stores a card for each, in shadow. The worlds here are real Boards over a home with PR and local stories, live sessions on
 * worktrees, a fake GitHub watcher and a keeper on the home; the rules of the keeper alone are tested on the cards it is handed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBridge, tmp, writeJson, type TestBridge } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { Board, type PrWatcher } from '@once-upon-a-diff/board/board';
import { CardKeeper, MAX_WRITES } from '@once-upon-a-diff/core/features/cards/card-keeper';
import type { LearnedCard, LearnedCards } from '@once-upon-a-diff/core/features/cards/learned';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { waitSeam } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';

const REPO = 'acme/widgets';
const NOW = new Date('2026-11-18T15:00:00Z');
const HOUR = 3600_000;
const open: TestBridge[] = [];
const children: { kill: () => void }[] = [];
after(async () => {
  children.forEach((child) => child.kill());
  await Promise.all(open.map((bridge) => bridge.close()));
});

const prInfo = (number: number, extra: Partial<PrInfo> = {}): PrInfo => ({
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  branch: null,
  author: 'octocat',
  mine: true,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
  ...extra,
});

/** What the fake GitHub says; a test changes it between builds. */
interface Says {
  infos: PrInfo[];
  branchPrs: Record<string, unknown>;
  requested: { repo: string; number: number; created_at?: string }[];
}

function watcherOf(says: Says): PrWatcher {
  return {
    kick: () => undefined,
    kickInfo: () => undefined,
    kickBranch: () => undefined,
    kickLocal: () => undefined,
    kickRequested: () => undefined,
    requested: () => says.requested,
    info: (_repo, number) => says.infos.find((info) => info.number === number) ?? null,
    infoAt: (_repo, number) =>
      says.infos.some((info) => info.number === number) ? Infinity : null,
    branchPr: (repo, branch) => says.branchPrs[`${repo}@${branch}`] as never,
    branchAt: () => null,
  };
}

function prStory(home: string, number: number, branch: string | null) {
  const id = `${REPO.replace('/', '-')}-${number}`;
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'github',
    repo: REPO,
    number,
    pr_title: `PR ${number}`,
    ...(branch ? { head_ref: branch } : {}),
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
  return id;
}

function localStory(home: string, id: string, checkout: string, branch: string) {
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: checkout,
    repo_name: 'widgets',
    base: 'origin/main',
    head: 'HEAD',
    branch,
    title: `Local ${id}`,
    built_at: new Date(NOW.getTime() - HOUR).toISOString(),
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story of ${id}`, chapters: [] });
}

/** A Board with a keeper over a fresh home, a repo `acme/widgets` with worktrees, live sessions, and a fake GitHub. */
function world({ keeper = true, stuck = '' }: { keeper?: boolean; stuck?: string } = {}) {
  const lookup = { stuck: !!stuck };
  const home = tmp('keeper-home');
  const sessions = tmp('keeper-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const fixture = worktreeFixture();
  seenCheckout(home, REPO, fixture.main);
  const says: Says = { infos: [], branchPrs: {}, requested: [] };
  const logs: string[] = [];
  const keeping = new CardKeeper(home, (line) => logs.push(line));
  let clock = NOW.getTime();
  const board = new Board(home, new StoryStore({ home }), watcherOf(says), new Builds(home), {
    source: registrySource,
    now: () => new Date(clock),
    repoOf: (cwd) =>
      lookup.stuck && cwd === stuck ? new Promise(() => undefined) : Promise.resolve(REPO),
    ...(keeper ? { keeper: keeping } : {}),
  });
  const kids = new Map<string, string>();
  /** a live session in `cwd`, busy or idle, with a transcript that shows a prompt (a blank one is a chip, not a card) */
  const live = (cwd: string, name: string, { status = 'idle', blank = false } = {}) => {
    const child = spawn('sleep', ['120']);
    children.push({ kill: () => child.kill() });
    const pid = child.pid as number;
    const session = `${String(pid).padStart(8, '0')}-1111-4222-8333-444444444444`;
    const lines = blank
      ? [{ type: 'mode', mode: 'normal', sessionId: session }]
      : [
          { type: 'user', message: { role: 'user', content: 'fix the build' }, sessionId: session },
          { type: 'assistant', message: { role: 'assistant', content: [] }, sessionId: session },
        ];
    const transcript = path.join(
      process.env.CLAUDE_CONFIG_DIR as string,
      'projects',
      cwd.replace(/[^A-Za-z0-9]/g, '-'),
      `${session}.jsonl`,
    );
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    writeJson(path.join(sessions, `${pid}.json`), {
      pid,
      sessionId: session,
      cwd,
      name,
      status,
      startedAt: clock - 3 * HOUR,
      statusUpdatedAt: clock - HOUR,
    });
    kids.set(name, session);
    return session;
  };
  /** the next build, past the kept answer */
  const build = async () => {
    clock += 3000;
    return JSON.stringify(await board.snapshot());
  };
  const store = new BacklogStore(home);
  const file = path.join(home, 'backlog.jsonl');
  const text = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const stored = () => store.items();
  return {
    home,
    fixture,
    says,
    logs,
    board,
    build,
    live,
    kids,
    store,
    file,
    text,
    stored,
    keeping,
    lookup,
  };
}

/** Holds the backlog lock, as another writer would, so a keeper that takes it waits (briefly: the seam) and throws, which it logs. */
function holdLock(file: string) {
  const limit = waitSeam.limitMs;
  mkdirSync(`${file}.lock`, { recursive: true });
  waitSeam.limitMs = 150;
  return () => {
    rmSync(`${file}.lock`, { recursive: true, force: true });
    waitSeam.limitMs = limit;
  };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

test('one build stores a card for each piece of work, and none for a PR with no work, an editor or a blank session', async () => {
  const scene = world();
  const { fixture, says, home } = scene;
  // a PR story with its branch, in a worktree a session is on
  const prTree = fixture.add('feat/pr');
  prStory(home, 7, 'feat/pr');
  says.infos.push(prInfo(7, { branch: 'feat/pr' }));
  const prSession = scene.live(prTree, 'on-pr', { status: 'busy' });
  // a local story on a branch
  const localTree = fixture.add('feat/local');
  localStory(home, 'local-one', localTree, 'feat/local');
  // a busy session on a feature branch with no work of its own
  const sessTree = fixture.add('feat/sess');
  const sess = scene.live(sessTree, 'on-branch', { status: 'busy' });
  // two sessions on one branch, a new own PR (1 hour old), an old own PR, a review request
  const twoTree = fixture.add('feat/two');
  const first = scene.live(twoTree, 'two-a');
  scene.live(twoTree, 'two-b');
  says.infos.push(prInfo(12, { branch: 'feat/new', mine: true }));
  says.requested.push({
    repo: REPO,
    number: 12,
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
  });
  says.infos.push(prInfo(10, { branch: 'feat/old', mine: true }));
  says.requested.push({
    repo: REPO,
    number: 10,
    created_at: new Date(NOW.getTime() - 72 * HOUR).toISOString(),
  });
  says.infos.push(prInfo(11, { branch: 'feat/theirs', mine: false, review_requested: true }));
  says.requested.push({
    repo: REPO,
    number: 11,
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
  });
  // a pending build request a listener has claimed, for a PR with no story
  const builds = new Builds(home);
  const asked = builds.request({ repo: REPO, number: 14 });
  builds.claim(asked.id, 'repo-acme-widgets');
  says.infos.push(prInfo(14, { branch: 'feat/building', mine: true }));
  // an editor and a blank session: no card
  const editorTree = fixture.add('feat/editor');
  const editor = scene.live(editorTree, 'the-editor');
  new AgentRegistry(home).start({
    name: 'editor-widgets',
    sid: editor.slice(0, 8),
    session: editor,
    kind: 'editor',
    slots: 2,
    task: 'editor',
    repo: REPO,
    cwd: editorTree,
    at: new Date(NOW.getTime() - 2 * HOUR),
  });
  scene.live(fixture.add('feat/blank'), 'blank-one', { blank: true });

  await scene.build();
  assert.deepEqual(scene.logs, []);
  const byBranch = new Map(scene.stored().map((item) => [item.branch, item]));
  assert.deepEqual(
    [...byBranch.keys()].sort(),
    ['feat/building', 'feat/local', 'feat/new', 'feat/pr', 'feat/sess', 'feat/two'],
    'one card for each piece of work: not the old PR, the review request, the editor or the blank session',
  );
  const pr = byBranch.get('feat/pr');
  assert.equal(pr?.source, 'pr');
  assert.equal(pr?.pr, 7);
  assert.equal(pr?.story, 'acme-widgets-7');
  assert.equal(pr?.session, prSession);
  assert.equal(pr?.repo, REPO);
  assert.equal(pr?.worktree, prTree);
  assert.equal(pr?.title, 'PR 7');
  const local = byBranch.get('feat/local');
  assert.equal(local?.source, 'story');
  assert.equal(local?.story, 'local-one');
  assert.equal(local?.pr, null);
  const alone = byBranch.get('feat/sess');
  assert.equal(alone?.source, 'session');
  assert.equal(alone?.session, sess);
  assert.equal(alone?.worktree, sessTree);
  assert.equal(
    byBranch.get('feat/two')?.session,
    first,
    'two sessions on one branch make one card, with the first on it',
  );
  assert.equal(byBranch.get('feat/new')?.pr, 12);
  assert.equal(byBranch.get('feat/building')?.pr, 14);
  assert.ok(
    scene.stored().every((item) => item.source !== 'backlog' && item.added_by === 'keeper'),
  );
});

test('a second build, and five more, write nothing and never take the lock, with two sessions on a branch', async () => {
  const scene = world();
  const tree = scene.fixture.add('feat/two');
  scene.live(tree, 'two-a');
  scene.live(tree, 'two-b');
  prStory(scene.home, 7, 'feat/pr');
  scene.says.infos.push(prInfo(7, { branch: 'feat/pr' }));
  await scene.build();
  const written = scene.text();
  assert.equal(scene.stored().length, 2);
  const release = holdLock(scene.file);
  try {
    for (let i = 0; i < 5; i++) {
      await scene.build();
    }
    assert.equal(scene.text(), written, 'nothing written');
    assert.deepEqual(
      scene.logs,
      [],
      'a keeper that took the lock would have waited, thrown and logged',
    );
    // and the held lock is what shows a keeper that does write: new work takes it, waits, fails, and says so
    prStory(scene.home, 8, 'feat/more');
    await scene.build();
    assert.equal(scene.logs.length, 1, 'the write that was due took the lock');
  } finally {
    release();
  }
});

test('GitHub saying nothing: the story card has no PR, and a PR with no branch makes no card', async () => {
  const scene = world();
  prStory(scene.home, 7, 'feat/pr');
  prStory(scene.home, 8, null); // a story of a PR with no head ref, and GitHub has not answered
  scene.says.requested.push({
    repo: REPO,
    number: 9,
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
  });
  await scene.build();
  const [card, ...rest] = scene.stored();
  assert.equal(rest.length, 0, `only the PR with a branch: ${ids(scene.stored())}`);
  assert.equal(card.branch, 'feat/pr');
  assert.equal(card.source, 'story');
  assert.equal(card.pr, null, 'no PR number until GitHub answered for it');
  assert.equal(card.story, 'acme-widgets-7');
  // GitHub answers: the same card gets its PR
  scene.says.infos.push(prInfo(7, { branch: 'feat/pr' }));
  await scene.build();
  assert.deepEqual(
    scene.stored().map((item) => item.pr),
    [7],
  );
});

test('a lookup that timed out stores no session card; once it answers, the card is stored', async () => {
  const tree = worktreeFixture();
  const stuckTree = tree.add('feat/stuck');
  const scene = world({ stuck: stuckTree });
  const session = scene.live(stuckTree, 'on-stuck');
  await scene.build();
  assert.deepEqual(
    scene.stored(),
    [],
    'the lookup had not answered: the repo is only the last one known',
  );
  // the lookup answers on a later build, and the session's card is stored
  scene.lookup.stuck = false;
  await scene.build();
  assert.deepEqual(
    scene.stored().map((item) => [item.session, item.branch, item.repo]),
    [[session, 'feat/stuck', REPO]],
  );
});

test('a merged PR is never matched; a landed card on the branch plus a live session is a new card', async () => {
  const scene = world();
  const tree = scene.fixture.add('feat/again');
  prStory(scene.home, 7, 'feat/again');
  scene.says.infos.push(
    prInfo(7, { branch: 'feat/again', state: 'merged', merged_at: NOW.toISOString() }),
  );
  scene.live(tree, 'on-again');
  await scene.build();
  assert.deepEqual(
    scene.stored().map((item) => [item.branch, item.pr]),
    [['feat/again', null]],
    'the merged PR has no card; the session on the branch has its own, with no PR',
  );
  // a started backlog card on the branch lands: the live session gets a new card of its own
  const scene2 = world();
  const tree2 = scene2.fixture.add('feat/landed');
  const old = scene2.store.add({ title: 'old work', repo: REPO });
  scene2.store.start(old.id, { branch: 'feat/landed', repo: REPO });
  scene2.store.done(old.id, { sha: 'abc1234' });
  scene2.live(tree2, 'on-landed');
  await scene2.build();
  const made = scene2.stored().filter((item) => item.id !== old.id);
  assert.equal(made.length, 1);
  assert.equal(made[0].branch, 'feat/landed');
  assert.equal(made[0].source, 'session');
});

test('a story-bearing PR on a started backlog card’s branch joins it: one card, still a backlog card, with no worktree written', async () => {
  const scene = world();
  const tree = scene.fixture.add('feat/started');
  const item = scene.store.add({ title: 'a backlog card', repo: REPO });
  scene.store.start(item.id, { branch: 'feat/started', repo: REPO });
  prStory(scene.home, 7, 'feat/started');
  scene.says.infos.push(prInfo(7, { branch: 'feat/started' }));
  scene.live(tree, 'on-started');
  await scene.build();
  const [card, ...rest] = scene.stored();
  assert.equal(rest.length, 0);
  assert.equal(card.id, item.id);
  assert.equal(card.source, 'backlog');
  assert.equal(card.pr, 7);
  assert.equal(card.story, 'acme-widgets-7');
  assert.equal(card.worktree, null, 'a listed card is not given a worktree');
  const text = scene.text();
  await scene.build();
  assert.equal(scene.text(), text, 'and a second build writes nothing');
});

test('a failing write is logged and the board is the same as one with no keeper', async () => {
  const scene = world();
  prStory(scene.home, 7, 'feat/pr');
  scene.says.infos.push(prInfo(7, { branch: 'feat/pr' }));
  writeFileSync(scene.file, '');
  chmodSync(scene.file, 0o444);
  const plain = world({ keeper: false });
  prStory(plain.home, 7, 'feat/pr');
  plain.says.infos.push(prInfo(7, { branch: 'feat/pr' }));
  const withKeeper = await scene.build();
  const without = await plain.build();
  assert.ok(scene.logs.length >= 1, 'the failure is logged');
  assert.match(scene.logs[0], /card keeper: acme\/widgets@feat\/pr/);
  // the two boards differ only by the homes' own paths: compare what the page shows
  assert.equal(
    JSON.stringify(
      JSON.parse(withKeeper).lanes.map((lane: { cards: unknown[] }) => lane.cards.length),
    ),
    JSON.stringify(
      JSON.parse(without).lanes.map((lane: { cards: unknown[] }) => lane.cards.length),
    ),
  );
  chmodSync(scene.file, 0o644);
});

// ---- the keeper alone, on the cards it is handed

const learned = (num: number, more: Partial<LearnedCard> = {}): LearnedCard => ({
  kind: 'work',
  source: 'story',
  title: `work ${num}`,
  repo: REPO,
  branch: `feat/n-${num}`,
  worktree: null,
  pr: null,
  story: `story-${num}`,
  session: null,
  ...more,
});
const handed = (
  cards: LearnedCard[],
  ended: LearnedCards['ended'] = [],
  open: LearnedCards['open'] = [],
): LearnedCards => ({
  cards,
  ended,
  open,
});

test('a restart-sized world: the first build writes 40 cards, the next the rest, the third nothing', () => {
  const home = tmp('keeper-cap');
  const logs: string[] = [];
  const keeper = new CardKeeper(home, (line) => logs.push(line));
  const cards = Array.from({ length: 45 }, (_, i) => learned(i));
  keeper.apply(handed(cards));
  assert.equal(new BacklogStore(home).items().length, MAX_WRITES);
  keeper.apply(handed(cards));
  assert.equal(new BacklogStore(home).items().length, 45);
  const text = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8');
  keeper.apply(handed(cards));
  assert.equal(readFileSync(path.join(home, 'backlog.jsonl'), 'utf8'), text);
  assert.deepEqual(logs, []);
});

test('a 500-character title is clipped, a repo the store would refuse is skipped, and a card that always fails is logged once and does not starve the rest', () => {
  const home = tmp('keeper-fail');
  const logs: string[] = [];
  const keeper = new CardKeeper(home, (line) => logs.push(line));
  class Flaky extends BacklogStore {
    add(input: Parameters<BacklogStore['add']>[0]) {
      if (input.branch === 'feat/bad') {
        throw new Error('disk on fire');
      }
      return super.add(input);
    }
  }
  (keeper as unknown as { store: BacklogStore }).store = new Flaky(home);
  const cards = [
    learned(1, { branch: 'feat/bad' }),
    learned(2, { title: 'x'.repeat(500) }),
    learned(3, { repo: 'not a repo' }),
    learned(4, { branch: 'has space' }),
    learned(5),
  ];
  for (let i = 0; i < 3; i++) {
    keeper.apply(handed(cards));
  }
  const stored = new BacklogStore(home).items();
  assert.deepEqual(stored.map((item) => item.branch).sort(), ['feat/n-2', 'feat/n-5']);
  assert.equal(stored.find((item) => item.branch === 'feat/n-2')?.title.length, 200);
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /feat\/bad: disk on fire/);
});

test('the last build’s PR is not the new one’s: a card of a PR seen merged, or of another PR, is passed over', () => {
  const home = tmp('keeper-guard');
  const keeper = new CardKeeper(home, () => undefined);
  const store = new BacklogStore(home);
  // PR 5 has its card on the branch
  keeper.apply(handed([learned(1, { branch: 'feat/reused', source: 'pr', pr: 5 })]));
  assert.deepEqual(
    store.items().map((item) => item.pr),
    [5],
  );
  // GitHub says PR 5 merged, and a new PR 7 is open on the same branch name
  keeper.apply(
    handed(
      [learned(1, { branch: 'feat/reused', source: 'pr', pr: 7, story: null })],
      [{ repo: REPO, number: 5 }],
    ),
  );
  assert.deepEqual(
    store
      .items()
      .map((item) => item.pr)
      .sort(),
    [5, 7],
  );
  // and nothing more is made on later builds
  for (let i = 0; i < 3; i++) {
    keeper.apply(handed([learned(1, { branch: 'feat/reused', source: 'pr', pr: 7, story: null })]));
  }
  assert.equal(store.items().length, 2);
  // a session on the branch with no PR yet joins the new card, not the merged one
  keeper.apply(
    handed(
      [learned(2, { branch: 'feat/reused', source: 'session', story: null, session: 'sess-1' })],
      [{ repo: REPO, number: 5 }],
      [{ repo: REPO, number: 7 }],
    ),
  );
  const joined = store.items().filter((item) => item.session === 'sess-1');
  assert.equal(store.items().length, 2);
  assert.deepEqual(
    joined.map((item) => item.pr),
    [7],
  );
  // PR 5 stays open in the other case: a different PR number on a branch is another card, whatever GitHub said of 5
  const fresh = new CardKeeper(tmp('keeper-guard-two'), () => undefined);
  fresh.apply(handed([learned(3, { branch: 'feat/x', source: 'pr', pr: 5 })]));
  fresh.apply(handed([learned(3, { branch: 'feat/x', source: 'pr', pr: 6 })]));
  assert.equal(
    new BacklogStore(
      (fresh as unknown as { store: BacklogStore }).store.file.replace(/backlog\.jsonl$/, ''),
    ).items().length,
    2,
  );
});

test('a session that moves to another branch gets that branch’s card; its card on the old branch stays on the old branch', () => {
  const home = tmp('keeper-moved');
  const keeper = new CardKeeper(home, () => undefined);
  const store = new BacklogStore(home);
  const session = (branch: string) =>
    learned(1, { kind: 'session', source: 'session', branch, story: null, session: 'sess-moved' });
  keeper.apply(handed([session('feat/old')]));
  keeper.apply(handed([session('feat/new')]));
  assert.deepEqual(
    store
      .items()
      .map((item) => item.branch)
      .sort(),
    ['feat/new', 'feat/old'],
  );
  // and a later build writes nothing more
  const text = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8');
  keeper.apply(handed([session('feat/new')]));
  assert.equal(readFileSync(path.join(home, 'backlog.jsonl'), 'utf8'), text);
});

test('a listed card that lands between the keeper’s read and its lock is given no worktree', () => {
  const home = tmp('keeper-race');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'a backlog card', repo: REPO });
  store.start(item.id, { branch: 'feat/raced', repo: REPO });
  const keeper = new CardKeeper(home, () => undefined);
  // the keeper's lock-free read is a build behind: it sees no card on the branch
  class Stale extends BacklogStore {
    private served = false;
    items() {
      if (!this.served) {
        this.served = true;
        return [];
      }
      return super.items();
    }
  }
  (keeper as unknown as { store: BacklogStore }).store = new Stale(home);
  keeper.apply(
    handed([learned(1, { branch: 'feat/raced', worktree: '/tmp/raced', story: 'story-raced' })]),
  );
  const [card, ...rest] = store.items();
  assert.equal(rest.length, 0);
  assert.equal(card.story, 'story-raced');
  assert.equal(card.worktree, null);
});

test('after a restart, work on a branch name an earlier PR used does not join that PR’s card, unless the build saw the PR open', () => {
  const home = tmp('keeper-restart');
  const store = new BacklogStore(home);
  new CardKeeper(home, () => undefined).apply(
    handed(
      [learned(1, { branch: 'feat/reused', source: 'pr', pr: 5, story: null })],
      [],
      [{ repo: REPO, number: 5 }],
    ),
  );
  // a new bridge: it never saw PR 5 end, and the session has no PR yet
  const session = learned(2, {
    kind: 'session',
    source: 'session',
    branch: 'feat/reused',
    story: null,
    session: 'sess-again',
  });
  const restarted = new CardKeeper(home, () => undefined);
  restarted.apply(handed([session]));
  assert.equal(store.items().length, 2);
  assert.equal(store.items().find((item) => item.pr === 5)?.session, null);
  assert.equal(store.items().find((item) => item.session === 'sess-again')?.pr, null);
  // a PR the build sees open still takes its session and story
  const joining = new CardKeeper(tmp('keeper-restart-open'), () => undefined);
  const base = learned(3, { branch: 'feat/open', source: 'pr', pr: 9, story: null });
  joining.apply(handed([base], [], [{ repo: REPO, number: 9 }]));
  joining.apply(handed([{ ...base, session: 'sess-open' }], [], [{ repo: REPO, number: 9 }]));
  const joinedStore = (joining as unknown as { store: BacklogStore }).store;
  assert.equal(joinedStore.items().length, 1);
  assert.equal(joinedStore.items()[0].session, 'sess-open');
});

// ---- the wiring: createBridge passes the keeper unless told not to

async function bridgeWorld(keeper: boolean | undefined) {
  const home = tmp('keeper-bridge');
  const sessions = tmp('keeper-bridge-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  prStory(home, 7, 'feat/pr');
  const bridge = await startBridge({
    home,
    ...(keeper === undefined ? {} : { keeper }),
    checkRequested: async () => [],
  });
  open.push(bridge);
  const board = await bridge.call('GET', '/api/board');
  assert.equal(board.status, 200);
  return home;
}

test('the bridge’s board writes the stories’ cards when its keeper is enabled, and nothing when it is off', async () => {
  const enabled = await bridgeWorld(true);
  const off = await bridgeWorld(undefined);
  const file = (home: string) => path.join(home, 'backlog.jsonl');
  // the story has a head_ref, so its work has a branch and the keeper stores it
  assert.ok(existsSync(file(enabled)), 'the keeper wrote the story’s card');
  assert.equal(new BacklogStore(enabled).items()[0]?.story, 'acme-widgets-7');
  assert.ok(
    !existsSync(file(off)),
    'startBridge leaves the keeper off by default: no card written',
  );
});
