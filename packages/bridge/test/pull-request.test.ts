import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  tmp,
  startBridge,
  runCli,
  localRepo,
  writeJson,
  git,
  fakeGitPush,
  TOKEN,
} from './helpers.ts';
import {
  boardKey,
  pageKey,
  viewKey,
  viewKeyMay,
} from '@once-upon-a-diff/core/records/page-links/page-key';
import { createLocalStory, reviewBranch } from '@once-upon-a-diff/core/records/stories/local-story';
import {
  aheadOf,
  branchPushArgs,
  namedBase,
} from '@once-upon-a-diff/core/records/stories/pull-request';
import type { PrPushAnswer, PrView, StoryData } from '@once-upon-a-diff/contracts/types';

const GITHUB_URL = 'https://github.com/acme/widgets.git';

/**
 * A local story on branch `feature` whose origin is github.com/acme/widgets, rewritten by url.insteadOf to a bare
 * repo in a temp folder, which has `main` (or `trunk`) at the story's base. git shows the rewritten URL, so the story's meta
 * names the repo itself.
 */
function storyWithOrigin(home: string, trunk = 'main') {
  const { repo, base } = localRepo();
  const remote = tmp('remote');
  git(remote, 'init', '-q', '--bare', '-b', trunk);
  git(repo, 'config', `url.${remote}.insteadOf`, GITHUB_URL);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  git(repo, 'push', '-q', 'origin', `${base}:refs/heads/${trunk}`);
  git(repo, 'fetch', '-q', 'origin');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, { chapters: [{ refs: [], title: 'Chapter 1: One', files: ['one.txt'] }] });
  const story = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const metaFile = path.join(story.dir, 'meta.json');
  writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
  return { repo, remote, base, id: story.id };
}

/** A stand-in gh that answers `gh pr list` with whatever the test last wrote to its file. */
function fakeGh(): { prsFile: string; callsFile: string; bin: string } {
  const dir = tmp('gh');
  const prsFile = path.join(dir, 'prs.json');
  writeFileSync(prsFile, '[]');
  const bin = path.join(dir, 'gh');
  const callsFile = path.join(dir, 'calls');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> "${callsFile}"\n[ "$1 $2" = "pr list" ] || exit 2\ncat "${prsFile}"\n`,
  );
  chmodSync(bin, 0o755);
  return { prsFile, callsFile, bin };
}

/** A local story on branch `feature` in a checkout whose origin is `url`, with no repo of its own in meta. */
function storyOnHost(home: string, url: string) {
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', url);
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, { chapters: [{ refs: [], title: 'Chapter 1: One', files: ['one.txt'] }] });
  return createLocalStory({ home, repo, base, head: 'HEAD', chapters }).id;
}

describe('Create pull request on a local story', () => {
  let fakeGhBin: ReturnType<typeof fakeGh>;
  let ghWas: string | undefined;
  before(() => {
    ghWas = process.env.ONCE_UPON_GH;
    fakeGhBin = fakeGh();
    process.env.ONCE_UPON_GH = fakeGhBin.bin;
  });
  after(() => {
    if (ghWas === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = ghWas;
    }
  });

  test('pr-draft hands over the title and body, and GET .../pr shows them with what a push would send', async () => {
    const home = tmp('home');
    const { id } = storyWithOrigin(home);
    const bodyFile = path.join(tmp('body'), 'body.md');
    writeFileSync(bodyFile, '## Summary\n\nWidgets.\n');
    const saved = await runCli(home, [
      'pr-draft',
      '--story',
      id,
      '--title',
      'Add widgets',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(saved.code, 0, saved.stderr);
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(view.repo, 'acme/widgets');
      assert.equal(view.branch, 'feature');
      assert.equal(view.base, 'main'); // the base is a commit, so origin's default
      assert.equal(view.remote.state, 'missing');
      assert.deepEqual(
        view.to_push.map((commit) => commit.subject),
        ['add two', 'change one'],
      );
      assert.equal(view.draft?.title, 'Add widgets');
      assert.equal(view.draft?.body, '## Summary\n\nWidgets.');
      assert.equal(view.pull, null);
    } finally {
      await bridge.close();
    }
  });

  test('Create pull request on a storyless review pushes only the sha the page showed, then tracks the branch; a moved branch is refused', async () => {
    const home = tmp('home');
    const { repo } = localRepo();
    const remote = tmp('remote');
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    // origin's main is the story's base, seeded by a fetch into the bare repo: no test runs a real push
    git(repo, 'branch', 'seed', 'HEAD~2');
    git(remote, 'fetch', '-q', repo, 'seed:main');
    git(repo, 'branch', '-D', '-q', 'seed');
    git(repo, 'config', `url.${remote}.insteadOf`, GITHUB_URL);
    git(repo, 'remote', 'add', 'origin', GITHUB_URL);
    git(repo, 'fetch', '-q', 'origin');
    const { id, dir } = reviewBranch({ home, path: repo, branch: 'feature' });
    const metaFile = path.join(dir, 'meta.json');
    writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
    const shown = git(repo, 'rev-parse', 'feature');
    writeFileSync(path.join(repo, 'later.txt'), 'later\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'later');
    const bridge = await startBridge({ home });
    const pushes = fakeGitPush();
    const push = (sha: string) =>
      bridge.call<PrPushAnswer>(
        'POST',
        `/api/stories/${id}/pr`,
        { action: 'push', head_sha: sha },
        { Authorization: `Bearer ${pageKey(TOKEN, id)}` },
      );
    try {
      const page = (await bridge.call<StoryData>('GET', `/api/stories/${id}`)).body;
      assert.equal(page.local?.storyless, true);
      assert.equal(page.local?.head_oid, shown);
      // the box opened after the new commit: its tip is not what the page showed
      const tip = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body
        .head_sha as string;
      assert.notEqual(tip, shown);
      const moved = await push(tip);
      assert.equal(moved.status, 409);
      assert.match(moved.text, /the branch moved: click Review on its card to see the new commits/);
      assert.equal(
        (await push(shown)).status,
        409,
        'the branch is past it, so a push would send more',
      );
      assert.deepEqual(pushes.calls(), [], 'nothing pushed');
      // back at the head the page showed: the click is the approval
      git(repo, 'reset', '-q', '--hard', shown);
      const done = await push(shown);
      assert.equal(done.status, 200, done.text);
      assert.deepEqual(
        pushes.calls().map((args) => args.slice(2)),
        [
          ['push', 'origin', `${shown}:refs/heads/feature`],
          ['branch', '--set-upstream-to=origin/feature', 'feature'],
        ],
        'the shown sha, never the branch ref, then the upstream the fix-round relay reads',
      );
    } finally {
      pushes.restore();
      await bridge.close();
    }
  });

  test('a storyless review’s push names the shown sha, never the branch ref; a told story’s pushes the branch', () => {
    const sha = 'c80964d9' + '0'.repeat(32);
    assert.deepEqual(branchPushArgs('feature', sha, true), [
      'push',
      'origin',
      `${sha}:refs/heads/feature`,
    ]);
    assert.deepEqual(branchPushArgs('feature', sha, false), [
      'push',
      'origin',
      `${sha}:refs/heads/feature`,
    ]);
    assert.deepEqual(branchPushArgs('feature', null, true), [
      'push',
      '-u',
      'origin',
      'refs/heads/feature:refs/heads/feature',
    ]);
    assert.deepEqual(branchPushArgs('feature', null, false), [
      'push',
      'origin',
      'refs/heads/feature:refs/heads/feature',
    ]);
  });

  test('the read-only key is an allowlist: what it may reach is listed, and anything else is refused by default', () => {
    const may: [string, string][] = [
      ['', 'GET'],
      ['version', 'GET'],
      ['pulse', 'GET'],
      ['questions', 'POST'],
      ['viewed', 'POST'],
      ['notes', 'POST'],
      ['fixes', 'GET'],
      ['fixes', 'POST'],
      ['rebuild', 'GET'],
      ['rebuild', 'POST'],
      ['pr', 'GET'],
    ];
    for (const [what, method] of may) {
      assert.equal(viewKeyMay(what, method), true, `${method} ${what}`);
    }
    const never: [string, string][] = [
      ['pr', 'POST'],
      ['push', 'GET'],
      ['pr', 'PUT'],
      ['', 'POST'],
      ['push', 'POST'],
      ['approve', 'POST'],
      ['approve', 'GET'],
      ['viewed', 'GET'],
      ['notes', 'GET'],
      ['version', 'POST'],
      ['someFutureRoute', 'POST'],
      ['someFutureRoute', 'GET'],
      ['constructor', 'GET'],
      ['toString', 'POST'],
      ['__proto__', 'GET'],
    ];
    for (const [what, method] of never) {
      assert.equal(viewKeyMay(what, method), false, `${method} ${what}`);
    }
  });

  test('the read-only key reads, asks and rebuilds but never pushes', async () => {
    const home = tmp('home');
    const { remote, id } = storyWithOrigin(home);
    const bridge = await startBridge({ home });
    const story = `/api/stories/${id}`;
    const keyOf = (url: string) => url.split('#key=')[1];
    const withKey = (key: string, method: string, route: string, body?: unknown) =>
      bridge.call(method, route, body, { Authorization: `Bearer ${key}` });
    try {
      const read = viewKey(TOKEN, id);
      assert.notEqual(read, pageKey(TOKEN, id), 'not the key that can push');
      assert.notEqual(viewKey(TOKEN, id), viewKey(TOKEN, 'other'), 'one story each');
      // a story key opens nothing, and the board's key is no story's key
      assert.equal(
        (await withKey(read, 'POST', '/api/board/open-story', { story: id })).status,
        403,
        'a story key opens nothing',
      );
      assert.equal((await withKey(boardKey(TOKEN), 'GET', `${story}/pr`)).status, 403);
      assert.equal(
        (await withKey(boardKey(TOKEN), 'POST', `${story}/pr`, { action: 'push', head_sha: 'x' }))
          .status,
        403,
        "the board's key is no story's key",
      );

      // the read-only key may look where the branch stands, the same view the full key gets
      const view = (await withKey(pageKey(TOKEN, id), 'GET', `${story}/pr`)).body as PrView;
      const looked = await withKey(read, 'GET', `${story}/pr`);
      assert.equal(looked.status, 200, looked.text);
      assert.equal((looked.body as PrView).head_sha, view.head_sha);
      // but refuses every write to the PR routes, and nothing reaches the remote
      for (const [method, body] of [
        ['POST', { action: 'push', head_sha: view.head_sha }],
        ['POST', { action: 'push' }],
      ] as const) {
        const refused = await withKey(read, method, `${story}/pr`, body);
        assert.equal(refused.status, 403, `${method} ${JSON.stringify(body)}`);
        assert.match((refused.body as { error: string }).error, /read-only/);
      }
      assert.equal(
        (await withKey(read, 'POST', `${story}/drafts`, { chapter: 1, index: 0, action: 'review' }))
          .status,
        403,
        'never Add to my review',
      );
      assert.throws(() => git(remote, 'rev-parse', 'refs/heads/feature'), 'nothing was pushed');

      // and the rest of the story's routes work, with the page told it is read-only
      const data = (await withKey(read, 'GET', story)).body as StoryData;
      assert.equal(data.read_only, true);
      assert.equal(
        ((await withKey(pageKey(TOKEN, id), 'GET', story)).body as StoryData).read_only,
        undefined,
        'the full key says nothing of it',
      );
      for (const what of ['/pulse', '/version', '/fixes', '/drafts', '/read', '/ui', '/working']) {
        assert.equal((await withKey(read, 'GET', `${story}${what}`)).status, 200, what);
      }
      assert.equal(
        (await withKey(read, 'POST', `${story}/questions`, { text: 'Why?', step: 1 })).status,
        200,
      );
      assert.equal(
        (await withKey(read, 'POST', `${story}/viewed`, { path: 'one.txt', viewed: true })).status,
        200,
      );
      assert.equal(
        (
          await withKey(read, 'POST', `${story}/notes`, {
            path: 'one.txt',
            line: 1,
            body: 'Rename it',
          })
        ).status,
        200,
        'a Fix before push note',
      );
      assert.equal(
        (await withKey(read, 'POST', `${story}/fixes`, { action: 'auto', on: false })).status,
        200,
      );
      // Send goes to the session, and take back works: Fix before push is the way a read-only link reviews
      assert.equal(
        (await withKey(read, 'POST', `${story}/fixes`, { action: 'send' })).status,
        200,
        'Send',
      );
      // Rebuild reaches its own route (a rebuild with no chapters to keep is a 400 from its own check, not a 403)
      assert.notEqual((await withKey(read, 'GET', `${story}/rebuild`)).status, 403, 'Rebuild');
      assert.notEqual((await withKey(read, 'POST', `${story}/rebuild`, {})).status, 403, 'Rebuild');
      // everything not on the allowlist is refused, listed or not: Approve, a route that does not exist yet
      for (const [method, what] of [
        ['POST', '/approve'],
        ['POST', '/later'],
        ['GET', '/later'],
      ] as const) {
        const refused = await withKey(
          read,
          method,
          `${story}${what}`,
          method === 'POST' ? {} : undefined,
        );
        assert.equal(refused.status, 403, `${method} ${what}`);
        assert.match((refused.body as { error: string }).error, /read-only/);
      }
      // not another story, a bridge-wide route, or a page of the board's
      assert.equal((await withKey(read, 'GET', '/api/stories/acme-widgets-7')).status, 403);
      assert.equal((await withKey(read, 'GET', '/api/stories')).status, 403);
      assert.equal((await withKey(read, 'GET', '/api/board')).status, 403);

      // the full key, which the board's Open story and `once-upon page` hand out, still pushes
      const fromBoard = await withKey(boardKey(TOKEN), 'POST', '/api/board/open-story', {
        story: id,
      });
      assert.equal(fromBoard.status, 200, fromBoard.text);
      const full = keyOf((fromBoard.body as { url: string }).url);
      assert.equal(full, pageKey(TOKEN, id));
      const pushed = await withKey(full, 'POST', `${story}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.equal(pushed.status, 200, pushed.text);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), view.head_sha);
    } finally {
      await bridge.close();
    }
  });

  test('a push sends the branch, sets its upstream, and then there is nothing to push', async () => {
    const home = tmp('home');
    const { repo, remote, id } = storyWithOrigin(home);
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      const pushed = await bridge.call<PrPushAnswer>('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.equal(pushed.status, 200, pushed.text);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), view.head_sha);
      assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
      assert.equal(pushed.body.view.remote.state, 'same');
      assert.deepEqual(pushed.body.view.to_push, []);

      writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
      git(repo, 'commit', '-q', '-am', 'one more');
      const ahead = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(ahead.remote.state, 'ahead');
      assert.deepEqual(
        ahead.to_push.map((commit) => commit.subject),
        ['one more'],
      );
    } finally {
      await bridge.close();
    }
  });

  test("it won't push a branch that moved since the box opened, or one GitHub has commits on", async () => {
    const home = tmp('home');
    const { repo, remote, id } = storyWithOrigin(home);
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      const moved = await bridge.call('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: 'a'.repeat(40),
      });
      assert.equal(moved.status, 409);
      assert.match(moved.text, /moved since the box opened/);

      // someone else's commit on GitHub's feature, which this checkout hasn't fetched
      const other = tmp('other');
      execFileSync('git', ['clone', '-q', remote, other]);
      git(other, 'checkout', '-q', '-b', 'feature');
      writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
      git(other, 'add', '.');
      git(
        other,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=T',
        'commit',
        '-q',
        '-m',
        'theirs',
      );
      git(other, 'push', '-q', 'origin', 'feature');

      const diverged = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(diverged.remote.state, 'diverged');
      const refused = await bridge.call('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.equal(refused.status, 409);
      assert.match(refused.text, /has commits this checkout doesn't/);
      assert.notEqual(git(remote, 'rev-parse', 'refs/heads/feature'), view.head_sha);
      assert.equal(git(repo, 'rev-parse', 'feature'), view.head_sha);
    } finally {
      await bridge.close();
    }
  });

  test('a checkout whose origin is not on github.com has no repo here: no gh call, no PR looked up', async () => {
    for (const origin of [
      'https://ghe.invalid/acme/widgets.git',
      'git@gitlab.invalid:group/sub/widgets.git',
      'https://dev.azure.com/acme/Platform/_git/widgets',
    ]) {
      const home = tmp('home');
      const id = storyOnHost(home, origin);
      // a PR the fake gh would show if it were asked about github.com/acme/widgets
      writeFileSync(
        fakeGhBin.prsFile,
        JSON.stringify([{ number: 9, url: 'https://github.com/acme/widgets/pull/9' }]),
      );
      const bridge = await startBridge({ home });
      try {
        const callsBefore = existsSync(fakeGhBin.callsFile)
          ? readFileSync(fakeGhBin.callsFile, 'utf8')
          : '';
        const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
        assert.equal(view.repo, null, origin);
        assert.equal(view.pull, null, origin);
        const callsAfter = existsSync(fakeGhBin.callsFile)
          ? readFileSync(fakeGhBin.callsFile, 'utf8')
          : '';
        assert.equal(callsAfter, callsBefore, `${origin}: gh was not run`);
      } finally {
        writeFileSync(fakeGhBin.prsFile, '[]');
        await bridge.close();
      }
    }
  });

  test('an open PR for the branch shows up, and a PR story has no Create pull request', async () => {
    const home = tmp('home');
    const { id } = storyWithOrigin(home);
    writeFileSync(
      fakeGhBin.prsFile,
      JSON.stringify([{ number: 12, url: 'https://github.com/acme/widgets/pull/12' }]),
    );
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.deepEqual(view.pull, { number: 12, url: 'https://github.com/acme/widgets/pull/12' });
    } finally {
      writeFileSync(fakeGhBin.prsFile, '[]');
      await bridge.close();
    }
    const refusedDraft = await runCli(home, [
      'pr-draft',
      '--story',
      'nope',
      '--title',
      'T',
      '--body',
      'B',
    ]);
    assert.notEqual(refusedDraft.code, 0);
    assert.match(refusedDraft.stderr, /no story nope/);
  });

  test("a story's PR base falls back to the master origin has when there is no origin/HEAD, as Push does", async () => {
    const home = tmp('home');
    const { id, repo } = storyWithOrigin(home, 'master');
    try {
      git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); // gits from 2.48 set it on fetch
    } catch {
      /* an older git left none */
    }
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(view.base, 'master');
    } finally {
      await bridge.close();
    }
  });

  test('namedBase reads a 64-character commit (a SHA-256 repo) as a commit, not a branch', () => {
    const home = tmp('home');
    const { repo, base } = storyWithOrigin(home);
    const long = 'a'.repeat(64);
    git(repo, 'update-ref', `refs/remotes/origin/${long}`, base); // a branch on origin named like a sha
    assert.equal(namedBase(repo, long), null);
  });

  test("namedBase takes a branch on origin, and not a commit or a ref origin doesn't have", () => {
    const home = tmp('home');
    const { repo, base } = storyWithOrigin(home);
    assert.equal(namedBase(repo, 'origin/main'), 'main');
    assert.equal(namedBase(repo, 'main'), 'main');
    assert.equal(namedBase(repo, base), null);
    assert.equal(namedBase(repo, 'origin/develop'), null);
  });
  describe('Push for a branch with an open PR', () => {
    const OPEN_PR = [{ number: 12, url: 'https://github.com/acme/widgets/pull/12' }];
    const commitFix = (repo: string, name: string) => {
      writeFileSync(path.join(repo, name), `${name}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', name);
    };
    /** The story's branch pushed once (so the PR has something), then the bridge. */
    async function pushedStory(home: string) {
      const made = storyWithOrigin(home);
      const bridge = await startBridge({ home });
      const view = (await bridge.call<PrView>('GET', `/api/stories/${made.id}/pr`)).body;
      const first = await bridge.call('POST', `/api/stories/${made.id}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.equal(first.status, 200, first.text);
      return { ...made, bridge };
    }

    test('aheadOf counts what origin lacks from ls-remote and rev-list, without fetching', async () => {
      const { repo, remote, bridge } = await pushedStory(tmp('home'));
      try {
        assert.equal(await aheadOf(repo, 'feature'), 0);
        commitFix(repo, 'fix-1.txt');
        commitFix(repo, 'fix-2.txt');
        assert.equal(await aheadOf(repo, 'feature'), 2);
        const tracking = git(repo, 'rev-parse', 'refs/remotes/origin/feature');
        assert.equal(await aheadOf(repo, 'no-such-branch'), null, 'not here');
        // someone else pushes to feature: this checkout has neither their commit nor a fast-forward
        const other = tmp('other');
        execFileSync('git', ['clone', '-q', remote, other]);
        git(other, 'checkout', '-q', 'feature');
        writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
        git(other, 'add', '.');
        git(
          other,
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=T',
          'commit',
          '-q',
          '-m',
          'theirs',
        );
        git(other, 'push', '-q', 'origin', 'feature');
        assert.equal(await aheadOf(repo, 'feature'), null, 'diverged: no count');
        assert.equal(
          git(repo, 'rev-parse', 'refs/remotes/origin/feature'),
          tracking,
          'nothing fetched',
        );
      } finally {
        await bridge.close();
      }
    });

    test('Push fast-forwards the commits made after review, and then there is nothing to push', async () => {
      const home = tmp('home');
      writeFileSync(fakeGhBin.prsFile, JSON.stringify(OPEN_PR));
      const { repo, remote, id, bridge } = await pushedStory(home);
      try {
        commitFix(repo, 'fix-1.txt');
        commitFix(repo, 'fix-2.txt');
        const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
        assert.equal(view.remote.state, 'ahead');
        assert.deepEqual(view.pull, { number: 12, url: OPEN_PR[0].url });
        assert.deepEqual(
          view.to_push.map((commit) => commit.subject),
          ['fix-2.txt', 'fix-1.txt'],
        );
        const pushed = await bridge.call<PrPushAnswer>('POST', `/api/stories/${id}/pr`, {
          action: 'push-ahead',
          head_sha: view.head_sha,
        });
        assert.equal(pushed.status, 200, pushed.text);
        assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), view.head_sha);
        assert.equal(pushed.body.view.remote.state, 'same');
        assert.deepEqual(pushed.body.view.to_push, []);
        assert.equal(await aheadOf(repo, 'feature'), 0);
        const again = await bridge.call('POST', `/api/stories/${id}/pr`, {
          action: 'push-ahead',
          head_sha: view.head_sha,
        });
        assert.equal(again.status, 409);
        assert.match(again.text, /nothing to push/);
      } finally {
        writeFileSync(fakeGhBin.prsFile, '[]');
        await bridge.close();
      }
    });

    test('it is refused with no open PR, a branch that moved, or commits on GitHub this checkout lacks, and nothing is forced', async () => {
      const home = tmp('home');
      const { repo, remote, id, bridge } = await pushedStory(home);
      const post = (head: unknown) =>
        bridge.call('POST', `/api/stories/${id}/pr`, { action: 'push-ahead', head_sha: head });
      try {
        commitFix(repo, 'fix-1.txt');
        const head = git(repo, 'rev-parse', 'feature');
        const pushedTip = git(remote, 'rev-parse', 'refs/heads/feature');
        assert.notEqual(head, pushedTip);
        const noPr = await post(head);
        assert.equal(noPr.status, 409);
        assert.match(noPr.text, /no open PR/);

        writeFileSync(fakeGhBin.prsFile, JSON.stringify(OPEN_PR));
        const moved = await post('a'.repeat(40));
        assert.equal(moved.status, 409);
        assert.match(moved.text, /moved since the box opened/);

        const other = tmp('other');
        execFileSync('git', ['clone', '-q', remote, other]);
        git(other, 'checkout', '-q', 'feature');
        writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
        git(other, 'add', '.');
        git(
          other,
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=T',
          'commit',
          '-q',
          '-m',
          'theirs',
        );
        git(other, 'push', '-q', 'origin', 'feature');
        const theirs = git(remote, 'rev-parse', 'refs/heads/feature');
        const diverged = await post(head);
        assert.equal(diverged.status, 409);
        assert.match(diverged.text, /Pull first/);
        assert.equal(
          git(remote, 'rev-parse', 'refs/heads/feature'),
          theirs,
          'their commit is still the tip',
        );
        assert.equal(git(repo, 'rev-parse', 'feature'), head);
        assert.equal(
          (await bridge.call('POST', `/api/stories/${id}/pr`, { action: 'nope' })).status,
          400,
        );
      } finally {
        writeFileSync(fakeGhBin.prsFile, '[]');
        await bridge.close();
      }
    });

    test('only the full page key reaches it: not the read-only key, the board key, or another story', async () => {
      const home = tmp('home');
      writeFileSync(fakeGhBin.prsFile, JSON.stringify(OPEN_PR));
      const { repo, remote, id, bridge } = await pushedStory(home);
      try {
        commitFix(repo, 'fix-1.txt');
        const head = git(repo, 'rev-parse', 'feature');
        const tip = git(remote, 'rev-parse', 'refs/heads/feature');
        assert.equal(viewKeyMay('pr', 'POST'), false);
        for (const key of [
          viewKey(TOKEN, id),
          boardKey(TOKEN),
          pageKey(TOKEN, 'other'),
          'page.nonsense',
        ]) {
          const refused = await bridge.call(
            'POST',
            `/api/stories/${id}/pr`,
            { action: 'push-ahead', head_sha: head },
            { Authorization: `Bearer ${key}` },
          );
          assert.equal(refused.status, 403, refused.text);
        }
        assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), tip, 'nothing was pushed');
        const full = await bridge.call(
          'POST',
          `/api/stories/${id}/pr`,
          { action: 'push-ahead', head_sha: head },
          { Authorization: `Bearer ${pageKey(TOKEN, id)}` },
        );
        assert.equal(full.status, 200, full.text);
        assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), head);
      } finally {
        writeFileSync(fakeGhBin.prsFile, '[]');
        await bridge.close();
      }
    });
  });
});
