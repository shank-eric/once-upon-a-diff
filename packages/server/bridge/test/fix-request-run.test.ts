import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { claimAt, git, localRepo, registerRuns, runCli, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { readFixes } from '@once-upon-a-diff/state/queues/requests/fixes';

// `fixed --sha` ends every fix request as a fixer run on the branch's card, whoever fixed it (core/features/runs/record-fix.ts).
const SESSION = 'abcd1234-0000-4000-8000-000000000000';
const AUTHOR = 'cafe0001';
/** a card that exists only as its runs: no backlog row */
const IMPLICIT = 'ic_mwlegacy000001';

/** A local story of `feature` in acme/widgets, with a card on the branch and a fix request claimed a moment ago. */
function scene(options: { card?: boolean; claimed?: boolean; squash?: boolean } = {}) {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  if (options.squash) {
    // the branch as this repo's rule has it: one commit
    git(repo, 'reset', '-q', '--soft', base);
    git(repo, 'commit', '-q', '-m', 'the work');
  }
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
  const { id } = createLocalStory({ home, repo, base, head: 'feature', chapters });
  const backlog = new BacklogStore(home);
  let card: string | null = null;
  if (options.card !== false) {
    const item = backlog.add({ title: 'The work', repo: 'acme/widgets' });
    backlog.start(item.id, { branch: 'feature' });
    if (options.claimed !== false) {
      claimAt(backlog, item.id, 'the-author', new Date().toISOString(), AUTHOR);
    }
    card = item.id;
  }
  const request = 'f_test000001';
  writeJson(path.join(home, 'fixes.json'), {
    [request]: {
      id: request,
      story: id,
      repo: 'acme/widgets',
      kind: 'local',
      title: 'The work',
      url: null,
      branch: 'feature',
      checkout: repo,
      notes: [{ id: 'n_1', path: 'one.txt', side: 'R', line: 2, body: 'Fix it', chapter: null }],
      to: null,
      requested_at: new Date(Date.now() - 20000).toISOString(),
      status: 'pending',
      claimed_by: 'a-listener',
      claimed_at: new Date(Date.now() - 10000).toISOString(),
    },
  });
  const cli = (...args: string[]) => runCli(home, args, { CLAUDE_CODE_SESSION_ID: SESSION });
  const runs = () => new AgentRegistry(home).agents();
  const commit = (name: string) => {
    writeFileSync(path.join(repo, name), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { home, repo, story: id, card, request, backlog, cli, runs, commit };
}

describe('fixed --sha records the fix as a run on the branch’s card', () => {
  test('a fix with no run behind it becomes a done fixer run on the card, and the request names it', async () => {
    const fixture = scene();
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Recorded as a fixer run on bl_/);
    const [run] = fixture.runs();
    assert.equal(run.name, 'fix-feature');
    assert.equal(run.role, 'fixer');
    assert.equal(run.state, 'done');
    assert.equal(run.card, fixture.card);
    assert.equal(run.result?.commit, sha);
    assert.equal(readFixes(fixture.home)[fixture.request].run, run.run);
    // the author's claim is never replaced
    assert.equal(
      fixture.backlog.items().find((one) => one.id === fixture.card)?.claim?.agent,
      'the-author',
    );
  });

  test('a stored card nobody claimed is claimed for the fixer, so the registry takes the run', async () => {
    const fixture = scene({ claimed: false });
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(fixture.runs()[0].card, fixture.card);
    assert.equal(
      fixture.backlog.items().find((one) => one.id === fixture.card)?.claim?.agent,
      'fix-feature',
    );
  });

  test('a run still going on the branch accounts for the fix: nothing is recorded and the request names it', async () => {
    const fixture = scene();
    registerRuns(fixture.home, {
      sid: AUTHOR,
      name: 'the-author',
      kind: 'author',
      repo: 'acme/widgets',
      branch: 'feature',
      card: fixture.card as string,
      started: new Date(),
    });
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Covered by run/);
    assert.deepEqual(
      fixture.runs().map((one) => one.name),
      ['the-author'],
    );
    assert.equal(readFixes(fixture.home)[fixture.request].run, fixture.runs()[0].run);
  });

  test('a branch with no open card gets an implicit one for the run, and the line says so', async () => {
    const fixture = scene({ card: false });
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /no open card on feature: made it/);
    assert.match(fixture.runs()[0].card ?? '', /^ic_/);
  });

  test('--failed records no run, and a sha that is not at or behind HEAD is refused with the request left pending', async () => {
    const fixture = scene();
    const failed = await fixture.cli(
      'fixed',
      '--request',
      fixture.request,
      '--failed',
      '--note',
      'could not',
    );
    assert.equal(failed.code, 0, failed.stderr);
    assert.deepEqual(fixture.runs(), []);
    const again = scene();
    git(again.repo, 'checkout', '-q', '-b', 'elsewhere');
    const stray = again.commit('stray.txt');
    git(again.repo, 'checkout', '-q', 'feature');
    const refused = await again.cli('fixed', '--request', again.request, '--sha', stray);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /is not a commit at or behind HEAD/);
    assert.deepEqual(again.runs(), []);
    assert.equal(readFixes(again.home)[again.request].status, 'pending');
  });

  test('an approved story keeps its approval through a new commit; an amend on a branch with older commits lapses it', async () => {
    const fixture = scene();
    assert.equal((await fixture.cli('approve', fixture.story)).code, 0);
    const first = git(fixture.repo, 'rev-parse', 'HEAD');
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /approval carried/);
    const carried = readApproval(new StoryStore({ home: fixture.home }), fixture.story);
    assert.equal(carried?.head_oid, sha);
    assert.equal(carried?.carried?.from, first);
    // a second request, fixed by amending the commit: the branch's older commits were made before the fix began (before the run's
    // start), so the amended branch is not one carry accepts and the approval does not follow
    writeFileSync(path.join(fixture.repo, 'fix.txt'), 'changed\n');
    git(fixture.repo, 'commit', '-q', '-a', '--amend', '-m', 'fix.txt');
    const amended = git(fixture.repo, 'rev-parse', 'HEAD');
    const second = readFixes(fixture.home);
    writeJson(path.join(fixture.home, 'fixes.json'), {
      ...second,
      f_test000002: {
        ...second[fixture.request],
        id: 'f_test000002',
        status: 'pending',
        sha: undefined,
        run: undefined,
        claimed_at: new Date().toISOString(),
      },
    });
    const lapsed = await fixture.cli('fixed', '--request', 'f_test000002', '--sha', amended);
    assert.equal(lapsed.code, 0, lapsed.stderr);
    assert.doesNotMatch(lapsed.stdout, /approval carried/);
    assert.match(lapsed.stdout, /Recorded as a fixer run/);
  });
  test('an amend of a one-commit branch keeps the approval even though the patch changed (carry takes the same count and subject)', async () => {
    const fixture = scene({ squash: true });
    assert.equal((await fixture.cli('approve', fixture.story)).code, 0);
    const first = git(fixture.repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(fixture.repo, 'fix.txt'), 'changed\n');
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-q', '--amend', '-m', 'the work');
    const amended = git(fixture.repo, 'rev-parse', 'HEAD');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', amended);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /approval carried/);
    const carried = readApproval(new StoryStore({ home: fixture.home }), fixture.story);
    assert.equal(carried?.head_oid, amended);
    assert.equal(carried?.carried?.from, first);
  });

  test('a card that exists only as runs (an implicit ic_ card, no backlog row) takes the fixer run without a claim error', async () => {
    const fixture = scene({ card: false });
    const earlier = git(fixture.repo, 'rev-parse', 'HEAD');
    registerRuns(fixture.home, {
      sid: AUTHOR,
      name: 'the-author',
      kind: 'author',
      repo: 'acme/widgets',
      branch: 'feature',
      card: IMPLICIT,
      started: new Date(Date.now() - 3600_000),
      now: {
        state: 'done',
        at: new Date(Date.now() - 1800_000),
        result: { commit: earlier, branch: 'feature' },
      },
    });
    assert.equal(fixture.backlog.items().length, 0);
    const sha = fixture.commit('fix.txt');
    const done = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(done.stdout, /made it/);
    const fixer = fixture.runs().find((one) => one.name === 'fix-feature');
    assert.equal(fixer?.card, IMPLICIT);
    assert.equal(fixer?.result?.commit, sha);
    assert.equal(readFixes(fixture.home)[fixture.request].status, 'done');
  });

  test('a request the reviewer took back, and a --notes id it lacks, record no run and carry no approval', async () => {
    const fixture = scene();
    assert.equal((await fixture.cli('approve', fixture.story)).code, 0);
    const approved = git(fixture.repo, 'rev-parse', 'HEAD');
    const sha = fixture.commit('fix.txt');
    const typo = await fixture.cli(
      'fixed',
      '--request',
      fixture.request,
      '--sha',
      sha,
      '--notes',
      'n_nope',
    );
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /not in f_test000001: n_nope/);
    const requests = readFixes(fixture.home);
    writeJson(path.join(fixture.home, 'fixes.json'), {
      ...requests,
      [fixture.request]: {
        ...requests[fixture.request],
        status: 'taken_back',
        done_at: new Date().toISOString(),
      },
    });
    const takenBack = await fixture.cli('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(takenBack.code, 1);
    assert.match(takenBack.stderr, /took f_test000001 back/);
    assert.deepEqual(fixture.runs(), []);
    assert.equal(
      readApproval(new StoryStore({ home: fixture.home }), fixture.story)?.head_oid,
      approved,
    );
  });

  test('with no session in the environment the run is recorded under --sid; without it the error names --sid', async () => {
    const fixture = scene({ card: false });
    const sha = fixture.commit('fix.txt');
    const bare = (...args: string[]) => runCli(fixture.home, args, { CLAUDE_CODE_SESSION_ID: '' });
    const refused = await bare('fixed', '--request', fixture.request, '--sha', sha);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--sid SID8/);
    const done = await bare(
      'fixed',
      '--request',
      fixture.request,
      '--sha',
      sha,
      '--sid',
      'beef0001',
    );
    assert.equal(done.code, 0, done.stderr);
    assert.equal(fixture.runs().find((one) => one.name === 'fix-feature')?.sid, 'beef0001');
  });
});
