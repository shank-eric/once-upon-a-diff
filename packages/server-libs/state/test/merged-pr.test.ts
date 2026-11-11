import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { ghMergedCheck } from '../src/records/github/merged-pr.ts';

interface Node {
  number: number;
  mergedAt: string;
  baseRefName?: string;
  mergeCommit?: { oid: string } | null;
  headRepository?: { nameWithOwner: string } | null;
}
const node = (number: number, mergedAt: string, extra: Partial<Node> = {}): Node => ({
  number,
  mergedAt,
  baseRefName: 'main',
  mergeCommit: { oid: String(number).repeat(40).slice(0, 40) },
  headRepository: { nameWithOwner: 'acme/widgets' },
  ...extra,
});

/** A fake gh that prints this answer (and fails with this exit code), and logs its arguments beside it. */
function fakeGh(answer: unknown, exit = 0) {
  const dir = tmp('fake-gh');
  const script = path.join(dir, 'gh');
  writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answer));
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> "${dir}/calls"\n${exit ? 'echo "gh: not found" >&2\n' : `cat "${dir}/answer.json"\n`}exit ${exit}\n`,
  );
  chmodSync(script, 0o755);
  process.env.ONCE_UPON_GH = script;
  return dir;
}
const answer = (nodes: Node[], defaultBranch = 'main', nameWithOwner?: string) => ({
  data: {
    repository: {
      nameWithOwner,
      defaultBranchRef: { name: defaultBranch },
      pullRequests: { nodes },
    },
  },
});

test('the newest merged PR into the default branch from this repo is the one, with its merge commit', async () => {
  fakeGh(
    answer([
      node(3, '2026-11-02T10:00:00Z'),
      node(5, '2026-11-05T10:00:00Z'),
      node(4, '2026-11-03T10:00:00Z'),
    ]),
  );
  assert.deepEqual(await ghMergedCheck('Acme/Widgets', 'fix-thing'), {
    number: 5,
    merge_oid: '5'.repeat(40),
    merged_at: '2026-11-05T10:00:00Z',
    base: 'main',
  });
});

test("a fork's PR of the same branch name, and a PR into another branch, do not count", async () => {
  fakeGh(
    answer([
      node(8, '2026-11-08T10:00:00Z', { headRepository: { nameWithOwner: 'someone/widgets' } }),
      node(9, '2026-11-09T10:00:00Z', { baseRefName: 'feature-base' }),
      node(6, '2026-11-06T10:00:00Z', { headRepository: null }),
      node(2, '2026-11-02T10:00:00Z'),
    ]),
  );
  assert.equal((await ghMergedCheck('acme/widgets', 'fix-thing'))?.number, 2);
});

test('a rebase merge answers with its merge commit, a PR with none answers null', async () => {
  fakeGh(answer([node(4, '2026-11-04T10:00:00Z', { mergeCommit: { oid: 'd'.repeat(40) } })]));
  assert.equal((await ghMergedCheck('acme/widgets', 'x'))?.merge_oid, 'd'.repeat(40));
  fakeGh(answer([node(4, '2026-11-04T10:00:00Z', { mergeCommit: null })]));
  assert.equal(await ghMergedCheck('acme/widgets', 'x'), null);
  fakeGh(answer([]));
  assert.equal(await ghMergedCheck('acme/widgets', 'x'), null);
});

test('it asks about the card repo and branch', async () => {
  const dir = fakeGh(answer([]));
  await ghMergedCheck('EverFi/everfi-frontend', 'web-thing');
  const calls = (await import('node:fs')).readFileSync(path.join(dir, 'calls'), 'utf8');
  assert.match(calls, /owner=EverFi/);
  assert.match(calls, /name=everfi-frontend/);
  assert.match(calls, /branch=web-thing/);
});

test('it rejects when gh fails, or says errors, or has no such repo', async () => {
  fakeGh({}, 1);
  await assert.rejects(ghMergedCheck('acme/widgets', 'x'), /gh: not found/);
  fakeGh({ errors: [{ message: 'rate limited' }] });
  await assert.rejects(ghMergedCheck('acme/widgets', 'x'), /rate limited/);
  fakeGh({ data: { repository: null } });
  await assert.rejects(ghMergedCheck('acme/widgets', 'x'), /no such repo/);
});

test("a card written with a repo's old name still lands its same-repo PR, and a fork's still does not", async () => {
  // GitHub answers repository(owner,name) for the old name with the repo's current one
  fakeGh(
    answer(
      [
        node(8, '2026-11-08T10:00:00Z', {
          headRepository: { nameWithOwner: 'someone/Widgets-Next' },
        }),
        node(2, '2026-11-02T10:00:00Z', { headRepository: { nameWithOwner: 'Acme/Widgets-Next' } }),
      ],
      'main',
      'acme/widgets-next',
    ),
  );
  assert.equal((await ghMergedCheck('acme/widgets', 'x'))?.number, 2);
  fakeGh(
    answer(
      [
        node(8, '2026-11-08T10:00:00Z', {
          headRepository: { nameWithOwner: 'someone/widgets-next' },
        }),
      ],
      'main',
      'acme/widgets-next',
    ),
  );
  assert.equal(await ghMergedCheck('acme/widgets', 'x'), null);
});
