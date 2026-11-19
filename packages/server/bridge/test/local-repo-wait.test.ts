import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, git, startBridge, runCli, localRepo, writeJson, TOKEN } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';

/** What `once-upon wait --repo acme/widgets` hands over (it returns on the first request, so one call per request). */
async function repoWait(home: string, types: string) {
  const result = await runCli(home, [
    'wait',
    '--repo',
    'acme/widgets',
    '--consumer',
    'repo-acme-widgets',
    '--type',
    types,
    '--timeout',
    '2',
    '--json',
  ]);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; id: string; repo?: string | null });
}

test("a repo wait takes a local story's rebuild, fix request and approval: the story's repo is its checkout's origin", async () => {
  const home = tmp('home');
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
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const bridge = await startBridge({ home });
  try {
    const asked = await bridge.call('POST', `/api/stories/${id}/rebuild`, { mode: 'rebuild' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const stored = Object.values(new Builds(home).all()).find((build) => build.story === id);
    assert.equal(stored?.repo, 'acme/widgets', 'the request carries the checkout origin');
    const rebuild = await repoWait(home, 'build_request');
    assert.deepEqual(
      rebuild.map((entry) => entry.type),
      ['build_request'],
      'a repo wait picks up the local rebuild',
    );

    await bridge.call('POST', `/api/stories/${id}/notes`, {
      path: 'one.txt',
      line: 2,
      body: 'Fix',
    });
    const sent = await bridge.call('POST', `/api/stories/${id}/fixes`, { action: 'send' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const fixes = await repoWait(home, 'fix_request');
    assert.deepEqual(
      fixes.map((entry) => entry.type),
      ['fix_request'],
      'a repo wait picks up the local fix request',
    );

    const head = git(repo, 'rev-parse', 'HEAD');
    const approved = await bridge.call(
      'POST',
      `/api/stories/${id}/approve`,
      { head_sha: head },
      {
        Authorization: `Bearer ${pageKey(TOKEN, id)}`,
      },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const approvals = await repoWait(home, 'approved');
    assert.deepEqual(
      approvals.map((entry) => entry.type),
      ['approved'],
      'a repo wait picks up the local approval',
    );
  } finally {
    await bridge.close();
  }
});
