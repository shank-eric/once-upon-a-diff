import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, repoSettings, shipsByPr } from '../src/settings.ts';

const homeWith = (config: unknown): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ou-repos-'));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
};

test('repos: keyed by name or owner/name in any case, only valid fields kept', () => {
  const settings = readSettings(
    homeWith({
      repos: {
        Larmor: { skips_review: true, stories: false, deploy: 'local' },
        'Acme/Widgets': { skips_review: 'yes', stories: true, deploy: 'ftp', keep_branches: 1 },
        gadgets: 'nope',
      },
    }),
  );
  assert.deepEqual(repoSettings(settings, 'naveenvasou/larmor'), {
    skips_review: true,
    stories: false,
    deploy: 'local',
  });
  assert.deepEqual(repoSettings(settings, 'acme/widgets'), { stories: true });
  assert.deepEqual(repoSettings(settings, 'gadgets'), {});
  assert.deepEqual(repoSettings(settings, 'other/thing'), {});
  assert.deepEqual(repoSettings(settings, null), {});
});

test('repos: an owner/name entry wins over a bare name; no repos block means nothing set', () => {
  const settings = readSettings(
    homeWith({ repos: { widgets: { deploy: 'pr' }, 'acme/widgets': { deploy: 'local' } } }),
  );
  assert.equal(repoSettings(settings, 'acme/widgets').deploy, 'local');
  assert.equal(repoSettings(settings, 'other/widgets').deploy, 'pr');
  assert.deepEqual(repoSettings(readSettings(homeWith({})), 'acme/widgets'), {});
  assert.deepEqual(readSettings(homeWith({ repos: [1] })).repos, {});
});

test('repos: keep_branches adds the repo to the branches Clean up never deletes, with board_keep_branches', () => {
  const settings = readSettings(
    homeWith({
      repos: { 'EverFi-Frontend': { keep_branches: true }, other: { keep_branches: false } },
      board_keep_branches: ['Acme/Widgets'],
    }),
  );
  assert.deepEqual(settings.board.keepBranches, ['acme/widgets', 'everfi-frontend']);
  assert.deepEqual(readSettings(homeWith({})).board.keepBranches, []);
});

test('repos: a bare repo name finds an owner/name entry by its name part, in any case', () => {
  const settings = readSettings(homeWith({ repos: { 'Acme/Widgets': { stories: false } } }));
  assert.deepEqual(repoSettings(settings, 'widgets'), { stories: false });
  assert.deepEqual(repoSettings(settings, 'WIDGETS'), { stories: false });
  assert.deepEqual(repoSettings(settings, 'acme/widgets'), { stories: false });
  assert.deepEqual(repoSettings(settings, 'other/widgets'), {});
  assert.deepEqual(repoSettings(settings, 'widget'), {});
});

test('shipsByPr: true unless the repo skips review or deploys locally (no entry is a PR repo)', () => {
  assert.equal(shipsByPr({}), true);
  assert.equal(shipsByPr({ deploy: 'pr' }), true);
  assert.equal(shipsByPr({ skips_review: false }), true);
  assert.equal(shipsByPr({ skips_review: true }), false);
  assert.equal(shipsByPr({ deploy: 'local' }), false);
  assert.equal(shipsByPr({ skips_review: true, deploy: 'local' }), false);
});
