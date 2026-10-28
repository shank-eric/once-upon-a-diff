import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git, localRepo, tmp } from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';

test('a local story records the branch --head names, not the checkout’s, and none for a commit', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'stack/2', tip);
  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const branchOf = (head: string, id?: string) => {
    const made = createLocalStory({ home, repo, base, head, id });
    return {
      id: made.id,
      branch: JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8')).branch,
    };
  };
  const byName = branchOf('stack/2');
  assert.equal(byName.branch, 'stack/2', 'the branch Create pull request will push');
  assert.match(byName.id, /stack-2$/);
  assert.equal(branchOf('refs/heads/feature').branch, 'feature');
  assert.equal(branchOf('HEAD').branch, 'elsewhere');
  assert.equal(branchOf(tip, 'by-sha').branch, null);
});
