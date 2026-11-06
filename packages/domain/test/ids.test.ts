import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_ID_RE,
  agentId,
  agentWorkKey,
  implicitCardId,
  isImplicitCard,
  branchKey,
  branchKeyPrefix,
  branchWorkKey,
  parsePrRef,
  partsFileName,
  prKey,
  repoProblem,
  prKeyPrefix,
  prWorkKey,
  repoKey,
  canonicalRepo,
  repoAlias,
  repoListenerName,
  sameRepo,
  slug,
  stateKeyForPr,
  storyBuildKey,
  storyIdForPr,
  storyWorkKey,
} from '../src/ids.ts';

/*
 * Real inputs from ~/.once-upon (11/6): repos as GitHub spells them, with the case the records keep. Each pair of lines in
 * "matches the code it replaced" is the old call site, copied as it was, beside the module.
 */
const REPOS = [
  'EverFi/everfi-frontend',
  'EVERFI-Content/course-actions',
  'EverFi/CourseVersionReporter',
  'EverFi/Forge',
  'EverFi/furnace',
  'shank-eric/once-upon-a-diff',
  'shank-eric/Configuration',
  'naveenvasou/larmor',
  'everfi/everfi-frontend',
];
const NUMBERS: (number | string)[] = [51, 95, 6933, 7036, '6943'];

test('repoKey lower-cases, and reads none as empty', () => {
  assert.equal(repoKey('EverFi/CourseVersionReporter'), 'everfi/courseversionreporter');
  assert.equal(repoKey(null), '');
  assert.equal(repoKey(undefined), '');
});

test('sameRepo ignores case and is false when either side is empty', () => {
  assert.ok(sameRepo('EverFi/Forge', 'everfi/forge'));
  assert.ok(!sameRepo('EverFi/Forge', 'everfi/furnace'));
  assert.ok(!sameRepo('', ''));
  assert.ok(!sameRepo(null, 'a/b'));
});

test('a named typo of a repo reads as that repo, and nothing else is aliased', () => {
  // Eric, 11/6: shank-eric/larmor is a typo of naveenvasou/larmor, for now
  assert.equal(repoKey('shank-eric/larmor'), 'naveenvasou/larmor');
  assert.equal(repoKey('Shank-Eric/Larmor'), 'naveenvasou/larmor');
  assert.ok(sameRepo('shank-eric/larmor', 'NaveenVasou/Larmor'));
  assert.equal(canonicalRepo('shank-eric/larmor'), 'naveenvasou/larmor');
  assert.equal(
    canonicalRepo('Acme/Widgets'),
    'Acme/Widgets',
    'a repo that is no typo keeps its spelling',
  );
  assert.equal(canonicalRepo(null), null);
  assert.equal(repoAlias('shank-eric/once-upon-a-diff'), null);
  assert.ok(!sameRepo('shank-eric/larmor', 'shank-eric/other'));
});

test('prKey is the repo and number, lower-cased', () => {
  assert.equal(prKey('EverFi/everfi-frontend', 6933), 'everfi/everfi-frontend#6933');
  assert.equal(prKey('EverFi/everfi-frontend', '6933'), 'everfi/everfi-frontend#6933');
});

test('the board keys are prefixed forms of the same parts', () => {
  assert.equal(prWorkKey('EverFi/everfi-frontend', 6933), 'pr:everfi/everfi-frontend#6933');
  assert.equal(storyWorkKey('local-stack-4-agent-board'), 'story:local-stack-4-agent-board');
  assert.equal(branchWorkKey('EverFi/Forge', 'Fix/Case'), 'branch:everfi/forge@Fix/Case');
  assert.equal(branchKey('EverFi/Forge', 'Fix/Case'), 'everfi/forge@Fix/Case');
  assert.equal(branchKey(null, 'main'), '@main');
});

test("a PR story id keeps GitHub's case, so it is the same on every rebuild", () => {
  assert.equal(storyIdForPr('EverFi/CourseVersionReporter', 51), 'EverFi-CourseVersionReporter-51');
  assert.equal(
    storyIdForPr('EVERFI-Content/course-actions', 95),
    'EVERFI-Content-course-actions-95',
  );
  assert.equal(storyIdForPr('EverFi/everfi-frontend', 6943), 'EverFi-everfi-frontend-6943');
  assert.notEqual(
    storyIdForPr('everfi/everfi-frontend', 6943),
    storyIdForPr('EverFi/everfi-frontend', 6943),
  );
});

test('slug trims, dashes and cuts at 100', () => {
  assert.equal(slug('  a b/c  '), 'a-b-c');
  assert.equal(slug('local-stack 4--x'), 'local-stack-4--x');
  assert.equal(slug('x'.repeat(130)).length, 100);
});

test('a PR\'s state folder is lower-case, "pr-owner-repo-N"', () => {
  assert.equal(stateKeyForPr('EverFi/everfi-frontend', 6933), 'pr-everfi-everfi-frontend-6933');
  assert.equal(
    stateKeyForPr('EverFi/CourseVersionReporter', 51),
    'pr-everfi-courseversionreporter-51',
  );
});

test('a dash form cannot tell a-b/c from a/b-c: both are one state folder (what doctor will report)', () => {
  assert.equal(stateKeyForPr('a-b/c', 1), stateKeyForPr('a/b-c', 1));
});

test('the listener name and the parts file are the live file names', () => {
  assert.equal(repoListenerName('EverFi/everfi-frontend'), 'repo-everfi-everfi-frontend');
  assert.equal(partsFileName('EverFi/everfi-frontend'), 'everfi-everfi-frontend.json');
  assert.equal(storyBuildKey('local-x'), 'story:local-x');
});

test('parsePrRef reads a PR URL and owner/name#N, and nothing else', () => {
  assert.deepEqual(parsePrRef('https://github.com/EverFi/Forge/pull/1524/files'), {
    repo: 'EverFi/Forge',
    number: '1524',
  });
  assert.deepEqual(parsePrRef('everfi/forge#1524'), { repo: 'everfi/forge', number: '1524' });
  assert.equal(parsePrRef('1524'), null);
  assert.equal(parsePrRef('EverFi-Forge-1524'), null);
  assert.equal(parsePrRef('a/b/c#1'), null);
});

test('an agent id is sid8:name, and its board card prefixes it', () => {
  assert.equal(agentId('eeea873a', 'id-module'), 'eeea873a:id-module');
  assert.equal(agentWorkKey('eeea873a', 'id-module'), 'agent:eeea873a:id-module');
});

test("a run id is r_ and 10 hex, which a review draft's r_ id is not", () => {
  assert.ok(RUN_ID_RE.test('r_a9a0ce6271'));
  assert.ok(!RUN_ID_RE.test('r_mvl1jw4q12c1a9'));
  assert.ok(!RUN_ID_RE.test('r_a9a0ce627'));
});

/** The code each call site had inline, copied as it was. */
const OLD = {
  // domain/src/pr-key.ts, github-watcher.ts:67 keyOf, github-checks.ts:162
  prKey: (repo: string, number: number | string) => `${repo}#${number}`.toLowerCase(),
  watcherKey: (repo: string, number: number) => `${repo.toLowerCase()}#${number}`,
  checksKey: (nameWithOwner: string, number: number) => `${nameWithOwner.toLowerCase()}#${number}`,
  // github-watcher.ts:68, board works/cards/backlog, merge-rules.ts:66
  branchKey: (repo: string, branch: string) => `${repo.toLowerCase()}@${branch}`,
  backlogBranchKey: (repo: string | null, branch: string) =>
    `${(repo ?? '').toLowerCase()}@${branch}`,
  // board/src/stages/works.ts:21, :219, :239
  boardPr: (repo: string, number: number) => `pr:${repo.toLowerCase()}#${number}`,
  boardBranch: (repo: string, branch: string) => `branch:${repo.toLowerCase()}@${branch}`,
  // stories/src/meta.ts:101
  stateKey: (repo: string, number: number | string) =>
    `pr-${repo.replace('/', '-')}-${number}`.toLowerCase(),
  // publish.ts:68, story-ref.ts:34
  storyId: (repo: string, number: number | string) =>
    String(`${repo.replace('/', '-')}-${number}`)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100),
  // listeners/wait.ts:107, stories/parts.ts:31
  consumer: (repo: string) => `repo-${String(repo).toLowerCase().replace('/', '-')}`,
  parts: (repo: string) => `${repo.toLowerCase().replace(/\//g, '-')}.json`,
  // story-ref.ts:22-26
  ref: (text: string): { repo: string; number: string } | null => {
    const pr =
      /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(text) ||
      /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(text);
    return pr ? { repo: pr[1], number: pr[2] } : null;
  },
};

test('matches the code it replaced, for each real repo and number', () => {
  for (const repo of REPOS) {
    assert.equal(partsFileName(repo), OLD.parts(repo));
    assert.equal(repoListenerName(repo), OLD.consumer(repo));
    for (const branch of ['main', 'package-ui', 'Feature/Mixed-Case', 'backlog/x-1a2b']) {
      assert.equal(branchKey(repo, branch), OLD.branchKey(repo, branch));
      assert.equal(branchKey(repo, branch), OLD.backlogBranchKey(repo, branch));
      assert.equal(branchWorkKey(repo, branch), OLD.boardBranch(repo, branch));
    }
    for (const number of NUMBERS) {
      assert.equal(prKey(repo, number), OLD.prKey(repo, number));
      assert.equal(storyIdForPr(repo, number), OLD.storyId(repo, number));
      assert.equal(stateKeyForPr(repo, number), OLD.stateKey(repo, number));
      if (typeof number === 'number') {
        assert.equal(prKey(repo, number), OLD.watcherKey(repo, number));
        assert.equal(prKey(repo, number), OLD.checksKey(repo, number));
        assert.equal(prWorkKey(repo, number), OLD.boardPr(repo, number));
      }
    }
  }
  assert.equal(branchKey(null, 'main'), OLD.backlogBranchKey(null, 'main'));
});

test('parsePrRef matches the code it replaced', () => {
  for (const text of [
    'https://github.com/EverFi/everfi-frontend/pull/6933',
    'https://github.com/EverFi/everfi-frontend/pull/6933/files#diff-abc',
    'github.com/EVERFI-Content/course-actions/pull/99',
    'EverFi/CourseVersionReporter#51',
    'everfi/furnace#3058',
    '6933',
    'EverFi-everfi-frontend-6943',
    'local-stack-4-agent-board',
    'a/b#c',
    'https://example.com/a/b/pull/1',
    '',
  ]) {
    assert.deepEqual(parsePrRef(text), OLD.ref(text), text);
  }
});

test("a repo's key prefixes are what its prKey and branchKey start with, as github-watcher spelled them", () => {
  for (const repo of REPOS) {
    // github-watcher.ts:321-322, :351 and :359 before the module
    assert.equal(prKeyPrefix(repo), `${repo.toLowerCase()}#`);
    assert.equal(branchKeyPrefix(repo), `${repo.toLowerCase()}@`);
    assert.ok(prKey(repo, 6933).startsWith(prKeyPrefix(repo)));
    assert.ok(branchKey(repo, 'main').startsWith(branchKeyPrefix(repo)));
  }
  assert.ok(!prKey('everfi/forge-extra', 1).startsWith(prKeyPrefix('EverFi/Forge')));
});

test('repoProblem: a repo on a known lane is not noted, in any case; a repo on none is, with the known repo of its name', () => {
  const known = ['everfi/clarifi', 'shank-eric/once-upon-a-diff', 'naveenvasou/larmor'];
  assert.equal(repoProblem('EverFi/ClariFi', known), null);
  assert.equal(repoProblem('shank-eric/once-upon-a-diff', known), null);
  assert.equal(repoProblem('', known), null);
  assert.equal(repoProblem(null, known), null);
  assert.match(
    repoProblem('esshank/once-upon-a-diff', known) ?? '',
    /esshank\/once-upon-a-diff is on none of the repos this machine works in; did you mean shank-eric\/once-upon-a-diff\?/,
  );
  assert.match(repoProblem('shank-eric/larmor', known) ?? '', /did you mean naveenvasou\/larmor\?/);
  // two known owners of one name (a real fork) are both named, once each
  assert.match(
    repoProblem('x/larmor', [...known, 'Davidbujok/larmor', 'NaveenVasou/Larmor']) ?? '',
    /did you mean naveenvasou\/larmor or Davidbujok\/larmor\?/,
  );
  // no repo of that name: said without a guess
  const none = repoProblem('eshank/unknown-thing', known) ?? '';
  assert.match(none, /is on none of the repos this machine works in \(checkouts, PRs, cards\)/);
  assert.doesNotMatch(none, /did you mean/);
});

test('an implicit card id is an ic_ card id, minted from a fresh suffix, and a backlog id is not one', () => {
  assert.equal(implicitCardId('k3j9x2abc'), 'ic_k3j9x2abc');
  assert.equal(isImplicitCard('ic_k3j9x2abc'), true);
  assert.equal(isImplicitCard('bl_k3j9x2abc'), false);
  assert.equal(isImplicitCard(null), false);
  assert.equal(isImplicitCard(undefined), false);
});
