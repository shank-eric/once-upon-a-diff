import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { claimAt, git, localRepo, runCli, startBridge, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { writeBinding } from '@once-upon-a-diff/state/records/listeners/binding';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { PrPushAnswer, PrView } from '@once-upon-a-diff/contracts/types';

// Create pull request on a story's page ends the story's parked storyteller: the reviewer opens the PR on GitHub,
// so the run finishes once gh shows the branch's open PR ("PR #N opened"), never for a failed push or another role.
const SID = 'abcd1234';
const GITHUB_URL = 'https://github.com/acme/widgets.git';
// opened after the storyteller parked (the reviewer's click comes after it)
const prOpenedAfter = () => new Date(Date.now() + 60_000).toISOString();
const openPr = (extra: Record<string, unknown> = {}) => [
  {
    number: 14,
    url: 'https://github.com/acme/widgets/pull/14',
    createdAt: prOpenedAfter(),
    isCrossRepository: false,
    ...extra,
  },
];

function world() {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const { repo, base } = localRepo();
  const remote = tmp('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'config', `url.${remote}.insteadOf`, GITHUB_URL);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  git(repo, 'push', '-q', 'origin', `${base}:refs/heads/main`);
  git(repo, 'fetch', '-q', 'origin');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, { chapters: [{ refs: [], title: 'Chapter 1: One', files: ['one.txt'] }] });
  const { id, dir } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const metaFile = path.join(dir, 'meta.json');
  writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
  const backlog = new BacklogStore(home);
  const item = backlog.add({ title: 'The work', repo: 'acme/widgets' });
  backlog.start(item.id, { branch: 'feature' });
  claimAt(backlog, item.id, 'pr-author', new Date().toISOString(), SID);
  const ghDir = tmp('gh');
  const prsFile = path.join(ghDir, 'prs.json');
  writeFileSync(prsFile, '[]');
  const ghBin = path.join(ghDir, 'gh');
  writeFileSync(ghBin, `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 2\ncat "${prsFile}"\n`);
  chmodSync(ghBin, 0o755);
  // the story is bound to the storyteller that built it (publish --agent)
  writeBinding(home, id, 'tell-it', SID);
  const start = async (name: string, role: string, park: boolean) => {
    const started = await runCli(home, [
      ...['agent', 'start', name, '--role', role, '--card', item.id, '--task', 't', '--sid', SID],
    ]);
    assert.equal(started.code, 0, started.stderr);
    if (park) {
      const parked = await runCli(home, [
        ...['agent', 'state', name, '--state', 'review', '--outcome', 'story', '--sid', SID],
      ]);
      assert.equal(parked.code, 0, parked.stderr);
    }
  };
  const run = (name: string) =>
    new AgentRegistry(home).agents().find((entry) => entry.name === name);
  return { home, repo, base, id, prsFile, ghBin, start, run };
}

async function withGh<T>(ghBin: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.ONCE_UPON_GH;
  process.env.ONCE_UPON_GH = ghBin;
  try {
    return await body();
  } finally {
    if (was === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = was;
    }
  }
}

test('the push, then the open PR: the bound storyteller finishes with the PR number; other roles stay', async () => {
  const { home, id, prsFile, ghBin, start, run } = world();
  await start('tell-it', 'storyteller', true);
  await start('the-author', 'author', false);
  await start('the-critic', 'critic', false);
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(run('tell-it')?.state, 'waiting');
      const pushed = await bridge.call<PrPushAnswer>('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.equal(pushed.status, 200, pushed.text);
      assert.equal(run('tell-it')?.state, 'waiting', 'pushed, but no PR yet: nothing finished');

      // the reviewer clicks Create pull request on GitHub's page
      writeFileSync(prsFile, JSON.stringify(openPr()));
      assert.equal((await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).status, 200);
      const told = run('tell-it');
      assert.equal(told?.state, 'done');
      assert.equal(told?.outcome, 'PR #14 opened');
      assert.equal(run('the-author')?.state, 'running', 'an author is never finished');
      assert.equal(run('the-critic')?.state, 'running', 'a critic is never finished');
    } finally {
      await bridge.close();
    }
  });
});

test('a push answer that already shows the open PR finishes the storyteller too, and a finished run is left alone', async () => {
  const { home, id, prsFile, ghBin, start, run } = world();
  await start('tell-it', 'storyteller', true);
  writeFileSync(prsFile, JSON.stringify(openPr()));
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      const pushed = await bridge.call<PrPushAnswer>('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body.head_sha,
      });
      assert.equal(pushed.status, 200, pushed.text);
      const first = run('tell-it');
      assert.equal(first?.state, 'done');
      assert.equal(first?.outcome, 'PR #14 opened');
      // a later look at the same PR leaves the finished run as it was
      await bridge.call('GET', `/api/stories/${id}/pr`);
      assert.deepEqual(run('tell-it'), first);
    } finally {
      await bridge.close();
    }
  });
});

test('a failed push, or a branch with no open PR, finishes nothing', async () => {
  const { home, repo, id, ghBin, start, run } = world();
  await start('tell-it', 'storyteller', true);
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      git(repo, 'remote', 'set-url', 'origin', path.join(tmp('nowhere'), 'gone.git'));
      const refused = await bridge.call('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      assert.notEqual(refused.status, 200);
      const stale = await bridge.call('POST', `/api/stories/${id}/pr`, {
        action: 'push',
        head_sha: 'f'.repeat(40),
      });
      assert.equal(stale.status, 409);
      assert.equal(run('tell-it')?.state, 'waiting');
    } finally {
      await bridge.close();
    }
  });
});

test('an open PR older than the parked run is not its PR: a re-told story waits for its review', async () => {
  const { home, id, prsFile, ghBin, start, run } = world();
  await start('tell-it', 'storyteller', true);
  writeFileSync(prsFile, JSON.stringify(openPr({ createdAt: '2020-01-01T00:00:00Z' })));
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(view.pull?.number, 14, 'the page still shows the old PR');
      assert.equal(run('tell-it')?.state, 'waiting');
    } finally {
      await bridge.close();
    }
  });
});

test('two stories on one branch: only the storyteller bound to the opened story finishes', async () => {
  const { home, repo, base, id, prsFile, ghBin, start, run } = world();
  const chapters = path.join(tmp('ch2'), 'chapters.json');
  writeJson(chapters, { chapters: [{ refs: [], title: 'Chapter 1: One', files: ['one.txt'] }] });
  const second = createLocalStory({ home, repo, base, head: 'HEAD', chapters, id: 'other-story' });
  const metaFile = path.join(second.dir, 'meta.json');
  writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
  writeBinding(home, second.id, 'tell-newer', SID);
  await start('tell-it', 'storyteller', true);
  await start('tell-newer', 'storyteller', true);
  await start('tell-unbound', 'storyteller', true);
  writeFileSync(prsFile, JSON.stringify(openPr()));
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      assert.equal((await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).status, 200);
      assert.equal(run('tell-it')?.state, 'done');
      assert.equal(run('tell-newer')?.state, 'waiting', 'the other story keeps its storyteller');
      assert.equal(run('tell-unbound')?.state, 'waiting', 'a run no story names is left alone');
    } finally {
      await bridge.close();
    }
  });
});

test('a fork PR with the same head branch name is not the story PR', async () => {
  const { home, id, prsFile, ghBin, start, run } = world();
  await start('tell-it', 'storyteller', true);
  writeFileSync(prsFile, JSON.stringify(openPr({ isCrossRepository: true })));
  await withGh(ghBin, async () => {
    const bridge = await startBridge({ home });
    try {
      const view = (await bridge.call<PrView>('GET', `/api/stories/${id}/pr`)).body;
      assert.equal(view.pull, null);
      assert.equal(run('tell-it')?.state, 'waiting');
    } finally {
      await bridge.close();
    }
  });
});
