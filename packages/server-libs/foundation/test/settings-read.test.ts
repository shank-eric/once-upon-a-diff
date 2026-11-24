import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings } from '../src/settings.ts';

const homeWith = (config: unknown): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ou-read-'));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
};
const read = (config: unknown) => readSettings(homeWith(config));
const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

test('readSettings: an empty or wrongly shaped config reads as the defaults', () => {
  for (const config of [{}, [], 'text', null]) {
    const got = read(config);
    assert.equal(got.displayName, null);
    assert.equal(got.timeZone, undefined);
    assert.equal(got.timeZoneLabel, null);
    assert.equal(got.openCommand, null);
    assert.equal(got.unsetGithubToken, false);
    assert.equal(got.repoListenerIdleMinutes, null);
    assert.deepEqual(got.allowedHosts, ['once-upon.test', 'once-upon.fidev.net']);
    assert.equal(got.publicHost, 'once-upon.test');
    assert.equal(got.publicHostSet, false);
    assert.deepEqual(got.board, {
      it2Path: null,
      sessionsDir: path.join(claude, 'sessions'),
      projectsDir: path.join(claude, 'projects'),
      ledgerFile: null,
      progressFile: null,
      larmorDir: null,
      doneHours: 1,
      finishedWaitMinutes: 30,
      worktrees: true,
      keepBranches: [],
    });
    assert.deepEqual(got.repos, {});
    assert.equal(got.extensionIds.length, 1);
  }
});

test('readSettings: text, number, list and path settings of the wrong type or empty are dropped', () => {
  const bad = read({
    display_name: '   ',
    time_zone: '',
    time_zone_label: 3,
    open_command: [],
    gh_unset_github_token: 'true',
    listen_idle_minutes: 0,
    board_it2_path: '',
    board_sessions_dir: 5,
    board_ledger_file: [],
    board_done_hours: -1,
    board_finished_wait_minutes: 'x',
    board_worktrees: 'no',
    board_keep_branches: 'widgets',
    extension_ids: 'abc',
    checkout_dirs: 'x',
    allowed_hosts: 'x',
  });
  assert.equal(bad.displayName, null);
  assert.equal(bad.timeZone, undefined);
  assert.equal(bad.timeZoneLabel, null);
  assert.equal(bad.openCommand, null);
  assert.equal(bad.unsetGithubToken, false);
  assert.equal(bad.repoListenerIdleMinutes, null);
  assert.equal(bad.board.it2Path, null);
  assert.equal(bad.board.sessionsDir, path.join(claude, 'sessions'));
  assert.equal(bad.board.ledgerFile, null);
  assert.equal(bad.board.doneHours, 1);
  assert.equal(bad.board.finishedWaitMinutes, 30);
  assert.equal(bad.board.worktrees, true);
  assert.deepEqual(bad.board.keepBranches, []);
  assert.equal(bad.extensionIds.length, 1);
  assert.deepEqual(bad.allowedHosts, ['once-upon.test', 'once-upon.fidev.net']);
});

test('readSettings: good values are kept, trimmed or expanded as each setting says', () => {
  const got = read({
    display_name: ' Sam ',
    time_zone: 'America/New_York',
    time_zone_label: 'ET',
    open_command: ['open', 1],
    gh_unset_github_token: true,
    listen_idle_minutes: 3,
    board_it2_path: '~/bin/it2',
    board_sessions_dir: '/s',
    board_projects_dir: '~/p',
    board_progress_file: '/progress.md',
    board_larmor_dir: '~/larmor',
    board_done_hours: 2,
    board_finished_wait_minutes: 10,
    board_worktrees: false,
    board_keep_branches: [' Widgets ', '', 3],
    checkout_dirs: ['~/Dev', '', 4, '/abs'],
    repos: { 'Acme/Kept': { keep_branches: true }, other: { keep_branches: false } },
    extension_ids: ['abcdefghijklmnopabcdefghijklmnop', 'nope'],
  });
  assert.equal(got.displayName, 'Sam');
  assert.equal(got.timeZone, 'America/New_York');
  assert.equal(got.timeZoneLabel, 'ET');
  assert.deepEqual(got.openCommand, ['open', '1']);
  assert.equal(got.unsetGithubToken, true);
  assert.equal(got.repoListenerIdleMinutes, 3);
  assert.equal(got.board.it2Path, path.join(os.homedir(), 'bin/it2'));
  assert.equal(got.board.sessionsDir, '/s');
  assert.equal(got.board.projectsDir, path.join(os.homedir(), 'p'));
  assert.equal(got.board.ledgerFile, null);
  assert.equal(got.board.progressFile, '/progress.md');
  assert.equal(got.board.larmorDir, path.join(os.homedir(), 'larmor'));
  assert.equal(got.board.doneHours, 2);
  assert.equal(got.board.finishedWaitMinutes, 10);
  assert.equal(got.board.worktrees, false);
  assert.deepEqual(got.board.keepBranches, ['widgets', 'acme/kept']);
  assert.ok(got.checkoutDirs.includes(path.join(os.homedir(), 'Dev')));
  assert.ok(got.checkoutDirs.includes('/abs'));
  assert.deepEqual(got.extensionIds.slice(1), ['abcdefghijklmnopabcdefghijklmnop']);
});

test('readSettings: allowed hosts keep valid names in lower case, and the public host follows them', () => {
  const hosts = (config: object) => {
    const got = read(config);
    return [got.allowedHosts, got.publicHost, got.publicHostSet];
  };
  assert.deepEqual(hosts({ allowed_hosts: ['Board.Test', 'bad host', '-x', 'a.b'] }), [
    ['board.test', 'a.b'],
    'board.test',
    false,
  ]);
  assert.deepEqual(hosts({ allowed_hosts: ['a.test', 'b.test'], public_host: ' B.TEST ' }), [
    ['a.test', 'b.test'],
    'b.test',
    true,
  ]);
  assert.deepEqual(hosts({ allowed_hosts: ['a.test'], public_host: 'elsewhere.test' }), [
    ['a.test'],
    'a.test',
    false,
  ]);
  assert.deepEqual(hosts({ allowed_hosts: ['a.test'], public_host: 'none' }), [
    ['a.test'],
    null,
    false,
  ]);
  assert.deepEqual(hosts({ allowed_hosts: ['a.test'], public_host: '' }), [
    ['a.test'],
    null,
    false,
  ]);
  assert.deepEqual(hosts({ allowed_hosts: [] }), [[], null, false]);
});
