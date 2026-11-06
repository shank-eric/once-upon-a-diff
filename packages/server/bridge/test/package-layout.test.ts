/*
 * The shape of the engine (ADR-24): the packages in configs/layers.mjs (plus usage, beside them) and the folders each holds.
 * configs/.dependency-cruiser.mjs enforces the import order (PACKAGES and TIERS are its lists) and keeps the folders of one tier
 * apart; this pins which packages and folders exist, so a new package, tier or folder is an edit here too and not something that
 * appears by accident. Nothing sits loose where a folder belongs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirOf, GROUPS, PACKAGES, TIERS } from '../../../../configs/layers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const manifestOf = (name: string) => path.join(PACKAGES_DIR, dirOf(name), 'package.json');
const src = (name: string) => path.join(PACKAGES_DIR, dirOf(name), 'src');
const entries = (dir: string) => readdirSync(dir).sort();
const folders = (dir: string) =>
  entries(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());

// the folders each package holds (the folders of a package without tiers; the tiers' folders are in UNITS)
const FOLDERS: Record<string, string[]> = {
  adapters: ['claude-sessions', 'stores'],
  foundation: [],
  stories: [],
  state: TIERS.state,
  core: TIERS.core,
  board: ['stages'],
  usage: ['adapters'],
};
// the folders in each tier of a package with tiers: one folder per unit, and no loose file in a tier
const UNITS: Record<string, Record<string, string[]>> = {
  state: {
    records: ['agents', 'github', 'listeners', 'page-links', 'worktrees'],
    queues: ['backlog', 'requests'],
  },
  core: {
    features: ['heavy', 'listeners', 'publishing', 'review', 'sessions'],
    orchestration: ['bridge'],
  },
};

const NAMED_OTHERWISE: Record<string, string> = {
  bridge: 'once-upon-a-diff',
};

test('packages/ holds the five groups and nothing loose, each group holds its packages, and each package is named for its folder', () => {
  assert.deepEqual(entries(PACKAGES_DIR), Object.keys(GROUPS).sort(), 'the five groups');
  for (const [group, names] of Object.entries(GROUPS)) {
    const dir = path.join(PACKAGES_DIR, group);
    assert.ok(
      !existsSync(path.join(dir, 'package.json')),
      `${group} is a folder of packages, not a package`,
    );
    assert.deepEqual(entries(dir), names.slice().sort(), `${group}'s packages`);
    for (const name of names) {
      const pkg = JSON.parse(readFileSync(manifestOf(name), 'utf8')) as { name: string };
      assert.equal(
        pkg.name,
        NAMED_OTHERWISE[name] ?? `@once-upon-a-diff/${name}`,
        `${group}/${name}`,
      );
    }
  }
});

test('the depcruise script crawls every package’s src, so no package goes unchecked', () => {
  const scripts = (
    JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const crawled = scripts.depcruise!;
  for (const name of Object.values(GROUPS).flat()) {
    const dir = `packages/${dirOf(name)}`;
    const roots = {
      bridge: [`${dir}/bin`, `${dir}/instrumentation`],
      web: [`${dir}/public`],
    }[name as 'bridge' | 'web'] ?? [`${dir}/src`];
    for (const root of roots) {
      assert.ok(crawled.includes(root), `the depcruise script lists ${root}`);
    }
  }
});

test('the engine packages are the lint’s, plus usage, and each has its src and its package.json', () => {
  assert.deepEqual(
    PACKAGES,
    ['adapters', 'foundation', 'stories', 'state', 'core', 'board'],
    'the order in layers.mjs',
  );
  assert.deepEqual(
    Object.keys(FOLDERS).sort(),
    [...PACKAGES, 'usage'].sort(),
    'the folders pinned here',
  );
  for (const name of Object.keys(FOLDERS)) {
    assert.ok(existsSync(src(name)), `packages/${dirOf(name)}/src exists`);
    const pkg = JSON.parse(readFileSync(manifestOf(name), 'utf8')) as {
      name: string;
      exports: Record<string, string>;
    };
    assert.equal(pkg.name, `@once-upon-a-diff/${name}`);
    assert.equal(pkg.exports['./*'], './src/*.ts', `${name} exports its sources`);
  }
});

test('each package holds the folders listed here, and the packages with tiers hold only those', () => {
  for (const [name, expected] of Object.entries(FOLDERS)) {
    assert.deepEqual(folders(src(name)), expected.slice().sort(), `${name}'s folders`);
  }
  for (const name of Object.keys(UNITS)) {
    assert.deepEqual(entries(src(name)), TIERS[name]!.slice().sort(), `${name} has no loose file`);
  }
});

test('each tier holds the folders listed here, and no loose file', () => {
  for (const [name, tiers] of Object.entries(UNITS)) {
    assert.deepEqual(Object.keys(tiers), TIERS[name], `${name}'s tiers are the lint’s, in order`);
    for (const [tier, units] of Object.entries(tiers)) {
      assert.deepEqual(
        entries(path.join(src(name), tier)),
        units.slice().sort(),
        `${name}/${tier}`,
      );
    }
  }
});

test('state exports its test helper, and the others only their sources', () => {
  for (const name of Object.keys(FOLDERS)) {
    const pkg = JSON.parse(readFileSync(manifestOf(name), 'utf8')) as {
      exports: Record<string, string>;
    };
    assert.deepEqual(
      pkg.exports,
      name === 'state'
        ? { './*': './src/*.ts', './test/*': './test/*.ts' }
        : { './*': './src/*.ts' },
      name,
    );
  }
});
