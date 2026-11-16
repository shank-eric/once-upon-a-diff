import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import { createLocalStory } from '../src/local-story.ts';
import { refreshLocal } from '../src/local-diff.ts';
import { checkedMeta, isSafeRef, readMeta, refusalOf } from '../src/meta.ts';
import { indexFile, readIndex, storyDirFor } from '../src/placement.ts';
import { StoryStore } from '../src/store.ts';
import type { LocalMeta } from '../src/types.ts';

const metaOf = (dir: string): LocalMeta =>
  JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const overwrite = (dir: string, meta: object) => writeJson(path.join(dir, 'meta.json'), meta);

function localStory() {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  return { home, repo, base, ...made, store: new StoryStore({ home }) };
}

/** a story folder as an older version kept it: moved into the checkout's .once-upon/ and named in the index (a folder the checks still guard until it is migrated) */
function legacyOf(home: string, repo: string, dir: string): string {
  const id = path.basename(dir);
  const held = path.join(repo, '.once-upon', id);
  mkdirSync(path.dirname(held), { recursive: true });
  renameSync(dir, held);
  writeJson(indexFile(home), { ...readIndex(home), [id]: held });
  return held;
}

/** a PR story as publish leaves it, in the home */
function githubStory(home: string) {
  const dir = storyDirFor(home, 'acme-widgets-7', { kind: 'github' });
  writeJson(path.join(dir, 'chapters.json'), { title: 'T', chapters: [] });
  overwrite(dir, { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: 'a'.repeat(40) });
  return dir;
}

test('a meta.json whose oids are options makes no git call with them and writes nothing', () => {
  const { dir, repo, store, id } = localStory();
  const written = path.join(tmp('target'), 'written');
  const tip = git(repo, 'rev-parse', 'HEAD');
  const raw = { ...metaOf(dir), base_oid: `--output=${written}`, head_oid: `--output=${written}` };
  // followed from HEAD: the oids are dropped and the diff is made again from the refs
  overwrite(dir, raw);
  const next = refreshLocal(dir, raw as LocalMeta);
  assert.equal(existsSync(written), false);
  assert.equal(next.head_oid, tip);
  // pinned (any other --head): the stored oids would be used as they are, so they are dropped and nothing is made
  rmSync(path.join(dir, 'local.diff'));
  const pinned = { ...raw, head: 'feature' };
  overwrite(dir, pinned);
  refreshLocal(dir, pinned as LocalMeta);
  assert.equal(existsSync(written), false);
  assert.ok(store.load(id), 'the story still loads, its oids remade');
  assert.equal(existsSync(written), false);
});

test('a meta.json whose base or head is an option is refused in a folder a checkout holds, and nothing is written', () => {
  const { home, dir, repo, id } = localStory();
  const held = legacyOf(home, repo, dir);
  const written = path.join(tmp('target'), 'written');
  const good = metaOf(held);
  for (const field of ['base', 'head']) {
    const raw = { ...good, [field]: `--output=${written}`, base_oid: null, head_oid: null };
    rmSync(path.join(held, 'local.diff'), { force: true });
    overwrite(held, raw);
    refreshLocal(held, raw as LocalMeta);
    assert.equal(existsSync(written), false);
    assert.equal(refusalOf(home, id, held), `${field} is not a ref`);
  }
});

test('checkedMeta drops a non-sha oid and an option ref, and refuses a repo_path that is not the folder checkout', () => {
  const { home, dir, repo } = localStory();
  const good = metaOf(dir);
  const check = (change: object) => checkedMeta(dir, { ...good, ...change });
  assert.equal(check({}).problem, null);
  assert.equal(check({ base_oid: 'abc123' }).meta.base_oid, null);
  assert.equal(check({ head_oid: 'HEAD' }).meta.head_oid, null);
  assert.equal(check({ head_oid: 'A'.repeat(40) }).meta.head_oid, null);
  assert.equal(check({ branch: '-x' }).meta.branch, null);
  assert.equal(check({ branch: 'a b' }).meta.branch, null);
  assert.equal(check({ branch: 'a..b' }).meta.branch, null);
  assert.equal(check({ head_ref: '--force' }).meta.head_ref, null);
  assert.equal(check({ base: '-x' }).problem, 'base is not a ref');
  assert.equal(check({ head: 'a\nb' }).problem, 'head is not a ref');
  assert.equal(check({ kind: 'weird' }).problem?.includes('kind'), true);
  assert.match(check({ repo_path: 'relative' }).problem as string, /repo_path/);
  assert.equal(
    check({ repo_path: tmp('elsewhere') }).problem,
    null,
    'a story of the home keeps whatever checkout it names',
  );
  // a folder a checkout still holds must be that checkout's
  const held = legacyOf(home, repo, dir);
  const outside = checkedMeta(held, { ...good, repo_path: tmp('elsewhere') }, home);
  assert.match(outside.problem as string, /repo_path/);
  assert.equal(outside.meta.repo_path, undefined);
  assert.equal(
    checkedMeta(held, { ...good, repo_path: path.join(repo, '.') }, home).problem,
    null,
    'a path that is the same folder',
  );
  assert.equal(readMeta(held).kind, 'local');
});

test('a story folder in a checkout whose kind differs from the one it was made as is refused', () => {
  const { home, repo, store } = localStory();
  const dir = legacyOf(home, repo, githubStory(home));
  assert.equal(refusalOf(home, 'acme-widgets-7', dir), null);
  // the branch's meta.json says local, with the checkout it is in
  overwrite(dir, { kind: 'local', repo_path: repo, base: 'HEAD', head: 'HEAD' });
  assert.match(refusalOf(home, 'acme-widgets-7', dir) as string, /is not the github/);
  assert.equal(store.dirOf('acme-widgets-7'), null, 'and a folder in a checkout is never served');
  // and the other way round
  const local = Object.values(store.dirs()).find((one) => one.id.startsWith('local-'))!;
  overwrite(local.dir, { kind: 'github', repo: 'acme/widgets', number: 1 });
  assert.equal(store.dirOf(local.id), local.dir, 'a story of the home is trusted');
});

test('a story made before kinds were recorded is taken as it is, and kept to that kind', () => {
  const { home, repo } = localStory();
  const dir = legacyOf(home, repo, githubStory(home));
  rmSync(path.join(home, 'story-kinds.json'));
  assert.equal(refusalOf(home, 'acme-widgets-7', dir), null);
  overwrite(dir, { kind: 'local', repo_path: repo, base: 'HEAD', head: 'HEAD' });
  assert.match(refusalOf(home, 'acme-widgets-7', dir) as string, /is not the github/);
});

test('a story folder in a checkout whose repo_path is another checkout is refused', () => {
  const { home, dir, repo, id } = localStory();
  const held = legacyOf(home, repo, dir);
  assert.equal(refusalOf(home, id, held), null);
  overwrite(held, { ...metaOf(held), repo_path: localRepo().repo });
  assert.match(refusalOf(home, id, held) as string, /repo_path/);
  assert.equal(readMeta(held).repo_path, undefined);
});

test('a normal PR story and a normal local story load as before', () => {
  const { home, store, id, dir } = localStory();
  const before = metaOf(dir);
  const data = store.load(id);
  assert.ok(data);
  assert.equal(data.kind, 'local');
  assert.deepEqual({ ...metaOf(dir), updated_at: undefined }, { ...before, updated_at: undefined });
  githubStory(home);
  const pr = store.load('acme-widgets-7');
  assert.ok(pr);
  assert.equal(pr.kind, 'github');
  assert.equal(readMeta(path.dirname(dir) + '/acme-widgets-7').head_oid, 'a'.repeat(40));
});

test('a local story in the home folder is served even when the home is named .once-upon', () => {
  const home = path.join(tmp('root'), '.once-upon'); // the default home's name
  const { repo, base } = localRepo();
  const ambient = process.env.ONCE_UPON_HOME;
  process.env.ONCE_UPON_HOME = home; // the home the bridge and the CLI read (settings.ts homeDir)
  let made: ReturnType<typeof createLocalStory>;
  try {
    made = createLocalStory({ home, repo, base, head: 'HEAD' });
  } finally {
    process.env.ONCE_UPON_HOME = ambient;
  }
  const store = new StoryStore({ home });
  assert.ok(store.dirOf(made.id), 'the story is served');
  assert.equal(made.dir, path.join(home, made.id));
  // a story of the home keeps the checkout it says it is of: where the story says the repo is
  const homed = path.join(home, 'local-legacy-x');
  mkdirSync(homed, { recursive: true });
  const meta = { ...metaOf(made.dir), repo_path: tmp('elsewhere') };
  writeJson(path.join(homed, 'chapters.json'), { title: 'T', chapters: [] });
  overwrite(homed, meta);
  assert.equal(checkedMeta(homed, meta, home).problem, null);
  assert.equal(store.dirOf('local-legacy-x'), homed);
  assert.ok(store.load('local-legacy-x'), 'it loads through the route path');
  // read with the home from settings (ONCE_UPON_HOME) too, as the bridge and the CLI read it
  const before = process.env.ONCE_UPON_HOME;
  process.env.ONCE_UPON_HOME = home;
  try {
    assert.equal(readMeta(homed).repo_path, meta.repo_path);
  } finally {
    process.env.ONCE_UPON_HOME = before;
  }
});

test('isSafeRef accepts the refs git allows and nothing a shell reads', () => {
  for (const good of [
    'feature/x',
    'fix-1.2',
    'user/eric_test',
    'v1.0.0',
    'HEAD',
    'HEAD~1',
    'HEAD^',
    'main',
  ]) {
    assert.equal(isSafeRef(good), true, good);
  }
  for (const bad of [
    '$(id)',
    '`id`',
    'a;b',
    'a b',
    '-x',
    'a..b',
    'a@{1}',
    'a|b',
    'a&b',
    'a>b',
    'a<b',
    'a(b)',
    'a{b}',
    'a"b',
    "a'b",
    'a\\b',
    'a\nb',
    'a//b',
    '.hidden',
    'x.lock',
    'a/',
    '',
  ]) {
    assert.equal(isSafeRef(bad), false, JSON.stringify(bad));
  }
});

test('two processes recording kinds at once both land', async () => {
  const home = tmp('home');
  const script = path.join(tmp('kinds-script'), 'record.ts');
  writeFileSync(
    script,
    `import { recordKind } from ${JSON.stringify(new URL('../src/placement.ts', import.meta.url).pathname)};
for (let i = 0; i < 40; i++) recordKind(process.argv[2], process.argv[3] + i, 'local');`,
  );
  const run = (prefix: string) =>
    new Promise<number | null>((resolve) =>
      execFile(process.execPath, [script, home, prefix], { timeout: 60_000 }, (error) =>
        resolve(error ? 1 : 0),
      ),
    );
  assert.deepEqual(await Promise.all([run('a-'), run('b-'), run('c-')]), [0, 0, 0]);
  const all = JSON.parse(readFileSync(path.join(home, 'story-kinds.json'), 'utf8'));
  assert.equal(Object.keys(all).length, 120);
});
