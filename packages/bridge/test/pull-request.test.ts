import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmp, startBridge, runCli, localRepo, writeJson } from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { namedBase } from '../src/stories/pull-request.ts';
import type { PrPushAnswer, PrView } from '@once-upon-a-diff/shared/types';

const GITHUB_URL = 'https://github.com/acme/widgets.git';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

/**
 * A local story on branch `feature` whose origin is github.com/acme/widgets, rewritten by url.insteadOf to a bare
 * repo in a temp folder, which has `main` at the story's base. git shows the rewritten URL, so the story's meta
 * names the repo itself.
 */
function storyWithOrigin(home: string) {
  const { repo, base } = localRepo();
  const remote = tmp('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'config', `url.${remote}.insteadOf`, GITHUB_URL);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  git(repo, 'push', '-q', 'origin', `${base}:refs/heads/main`);
  git(repo, 'fetch', '-q', 'origin');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, { chapters: [{ title: 'Chapter 1: One', files: ['one.txt'] }] });
  const story = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const metaFile = path.join(story.dir, 'meta.json');
  writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
  return { repo, remote, base, id: story.id };
}

/** A stand-in gh that answers `gh pr list` with whatever the test last wrote to its file. */
function fakeGh(): { prsFile: string; bin: string } {
  const dir = tmp('gh');
  const prsFile = path.join(dir, 'prs.json');
  writeFileSync(prsFile, '[]');
  const bin = path.join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 2\ncat "${prsFile}"\n`);
  chmodSync(bin, 0o755);
  return { prsFile, bin };
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

  test("namedBase takes a branch on origin, and not a commit or a ref origin doesn't have", () => {
    const home = tmp('home');
    const { repo, base } = storyWithOrigin(home);
    assert.equal(namedBase(repo, 'origin/main'), 'main');
    assert.equal(namedBase(repo, 'main'), 'main');
    assert.equal(namedBase(repo, base), null);
    assert.equal(namedBase(repo, 'origin/develop'), null);
  });
});
