import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';

// `once-upon repo settings` prints what config.json's `repos` block says about a repo (the editor reads it; the board reads the same)
const homeWithRepos = () => {
  const home = tmp('repo-settings-cli');
  writeJson(path.join(home, 'config.json'), {
    port: 1,
    token: 't',
    repos: {
      larmor: { skips_review: true, stories: false, deploy: 'local' },
      'Acme/Widgets': { stories: true, deploy: 'pr', keep_branches: true },
    },
  });
  return home;
};

test('repo settings --json prints the fields for a repo, by name or owner/name', async () => {
  const home = homeWithRepos();
  const larmor = await runCli(home, ['repo', 'settings', 'naveenvasou/larmor', '--json']);
  assert.equal(larmor.code, 0, larmor.stderr);
  assert.deepEqual(JSON.parse(larmor.stdout), {
    repo: 'naveenvasou/larmor',
    skips_review: true,
    stories: false,
    deploy: 'local',
    keep_branches: false,
  });
  const widgets = await runCli(home, ['repo', 'settings', 'acme/widgets', '--json']);
  assert.deepEqual(JSON.parse(widgets.stdout), {
    repo: 'acme/widgets',
    skips_review: false,
    stories: true,
    deploy: 'pr',
    keep_branches: true,
  });
});

test('repo settings on an unknown repo prints the defaults, and plain output names each value', async () => {
  const home = homeWithRepos();
  const unknown = await runCli(home, ['repo', 'settings', 'other/thing', '--json']);
  assert.deepEqual(JSON.parse(unknown.stdout), {
    repo: 'other/thing',
    skips_review: false,
    stories: null,
    deploy: null,
    keep_branches: false,
  });
  const text = await runCli(home, ['repo', 'settings', 'larmor']);
  assert.match(text.stdout, /Skips review: yes/);
  assert.match(text.stdout, /Stories: no/);
  assert.match(text.stdout, /Deploy: local/);
  const bare = await runCli(home, ['repo', 'settings', 'other/thing']);
  assert.match(bare.stdout, /Stories: not set/);
  assert.match(bare.stdout, /Deploy: not set/);
});

test('repo settings with no repo and no checkout says so', async () => {
  const home = homeWithRepos();
  const result = await runCli(home, ['repo', 'settings'], {}, tmp('not-a-repo'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /usage: once-upon repo settings/);
});
