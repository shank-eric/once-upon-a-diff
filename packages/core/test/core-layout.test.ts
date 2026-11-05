/*
 * The shape of core: adapters under five tiers, and in each tier the folders it holds. configs/.dependency-cruiser.mjs enforces
 * the order (TIERS is its list) and keeps the folders of one tier apart; this pins which folders exist, so a new tier or a new
 * folder is an edit here too and not something that appears by accident. Nothing sits loose where a folder belongs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS } from '../../../configs/core-tiers.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(CORE, 'src');

// foundation is one unit (its files may import each other); the other tiers hold one folder per unit
const UNITS: Record<string, string[]> = {
  foundation: [],
  records: ['agents', 'github', 'listeners', 'page-links', 'stories', 'usage', 'worktrees'],
  queues: ['backlog', 'requests'],
  features: ['publishing', 'review', 'sessions'],
  orchestration: ['board', 'bridge'],
};
const entries = (dir: string) => readdirSync(dir).sort();
const folders = (dir: string) =>
  entries(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());

test('core/src holds the adapters and the tiers in the lint, and nothing else', () => {
  assert.deepEqual(entries(SRC), ['adapters', ...TIERS].sort());
  assert.deepEqual(Object.keys(UNITS), TIERS, 'the tiers in this test are the lint’s, in order');
});

test('each tier holds the folders listed here: foundation has files only, the others only folders', () => {
  for (const tier of TIERS) {
    const dir = path.join(SRC, tier);
    assert.deepEqual(folders(dir), UNITS[tier], `${tier}'s folders`);
    if (tier !== 'foundation') {
      assert.deepEqual(
        entries(dir),
        UNITS[tier],
        `${tier} has no loose file: a file belongs in one of its folders`,
      );
    }
  }
});

test('core exports its sources and its test helpers', () => {
  const pkg = JSON.parse(readFileSync(path.join(CORE, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  assert.deepEqual(pkg.exports, { './*': './src/*.ts', './test/*': './test/*.ts' });
});
