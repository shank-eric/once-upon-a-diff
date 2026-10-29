import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git, localRepo, runCli, tmp } from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';

test('a local story records the branch --head names, not the checkout’s', () => {
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
});

test('a sha records the one local branch whose tip it is', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const meta = (head: string, id: string) => {
    const made = createLocalStory({ home, repo, base, head, id });
    return JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8'));
  };
  assert.equal(meta(tip, 'by-sha').branch, 'feature', 'the only branch at that commit');
  assert.equal(meta(tip.slice(0, 9), 'by-short').branch, 'feature', 'a short sha too');
  assert.equal(meta(tip.slice(0, 5), 'by-tiny').branch, 'feature', 'any abbreviation');
  git(repo, 'tag', 'v1', tip);
  assert.equal(meta('v1', 'by-tag').branch, 'feature', 'a tag at the tip');
  assert.equal(
    meta(git(repo, 'rev-parse', 'feature~1'), 'mid').branch,
    null,
    'no branch at a commit mid-branch',
  );
  assert.equal(meta(base, 'at-base').branch, 'elsewhere');
});

test('a sha two branches share takes the checkout’s branch when HEAD is there, else none', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'stack/2', tip);
  const made = createLocalStory({ home, repo, base, head: tip, id: 'on-head' });
  assert.equal(
    JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8')).branch,
    'feature',
  );
  assert.deepEqual(made.ambiguous, []);

  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const tied = createLocalStory({ home, repo, base, head: tip, id: 'tied' });
  assert.equal(JSON.parse(readFileSync(path.join(tied.dir, 'meta.json'), 'utf8')).branch, null);
  assert.deepEqual(tied.ambiguous, ['feature', 'stack/2']);

  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--head',
    tip,
    '--id',
    'tied-cli',
    '--no-serve',
    '--no-open',
  ]);
  assert.match(cli.stderr, /is the tip of feature, stack\/2, so the story has no branch/);
});

test('a sha keeps its own default story id, so it never takes over the branch’s story', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  const byHead = createLocalStory({ home, repo, base });
  const bySha = createLocalStory({ home, repo, base, head: tip });
  assert.match(byHead.id, /-feature$/);
  assert.match(bySha.id, new RegExp(`-${tip.slice(0, 9)}$`));
  assert.notEqual(bySha.id, byHead.id);
  const metaOf = (made: { dir: string }) =>
    JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8'));
  assert.equal(metaOf(bySha).branch, 'feature', 'but it still records the branch for the buttons');
  assert.equal(metaOf(byHead).head, 'HEAD', 'and the branch’s story still follows HEAD');
});
