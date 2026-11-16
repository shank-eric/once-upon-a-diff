import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, tmp } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, i) => `${prefix} number ${i + 1}`);

/** app.js (12 lines) and other.js (12 lines) with line 8 of each changed on `feature`. */
function driftRepo() {
  const repo = tmp('repo');
  git(repo, 'init', '-q', '-b', 'feature');
  const text = (prefix: string, eighth?: string) => {
    const all = lines(12, prefix);
    if (eighth) {
      all[7] = eighth;
    }
    return all.join('\n') + '\n';
  };
  writeFileSync(path.join(repo, 'app.js'), text('app'));
  writeFileSync(path.join(repo, 'other.js'), text('other'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'app.js'), text('app', 'const changed = true;'));
  writeFileSync(path.join(repo, 'other.js'), text('other', 'const alsoChanged = true;'));
  git(repo, 'commit', '-q', '-am', 'change line 8');
  return { repo, base, text };
}

const plan = (narrative = 'It changed.') => ({
  chapters: [
    {
      title: 'The change',
      key: 'change',
      headline: 'It changed.',
      summary: 'two files.',
      narrative: `### Chapter 1: The change\n\n${narrative} [app](ref:app) and the rest.`,
      files: ['app.js', 'other.js'],
      refs: [{ id: 'app', path: 'app.js', start: 7, end: 9 }],
      hunks: ['h2'], // other.js's hunk
    },
  ],
});

function setup() {
  const home = tmp('home');
  const fixture = driftRepo();
  const chapters = path.join(tmp('chapters'), 'chapters.json');
  const tell = (head = 'HEAD', body: object | null = plan()) => {
    if (body) {
      writeFileSync(chapters, JSON.stringify(body));
    }
    return createLocalStory({
      home,
      repo: fixture.repo,
      base: fixture.base,
      head,
      id: 'drift',
      ...(body ? { chapters } : {}),
    });
  };
  const moved = () => {
    const data = new StoryStore({ home }).load('drift')!;
    const refs = Object.fromEntries(
      data.chapters[0].refs.map((ref) => [ref.id, ref.moved === true]),
    );
    return { refs, data };
  };
  return { ...fixture, home, chapters, tell, moved };
}

/** two lines added at the top of app.js, committed */
function insertAbove(repo: string, text: (prefix: string, eighth?: string) => string) {
  writeFileSync(
    path.join(repo, 'app.js'),
    'new one\nnew two\n' + text('app', 'const changed = true;'),
  );
  git(repo, 'commit', '-q', '-am', 'insert above');
}

test('a ref told over lines that a later commit shifts is marked moved, and a ref nothing touched is not', () => {
  const world = setup();
  const made = world.tell();
  const anchors = JSON.parse(readFileSync(path.join(made.dir, 'anchors.json'), 'utf8'));
  assert.deepEqual(Object.keys(anchors.chapters.change).sort(), ['app', 'h2']);
  assert.equal(anchors.chapters.change.app.text, 'line number 7'.replace('line', 'app'));
  assert.deepEqual(world.moved().refs, { app: false, h2: false }, 'nothing has changed yet');

  insertAbove(world.repo, world.text);
  const { refs, data } = world.moved();
  assert.deepEqual(refs, { app: true, h2: false });
  assert.equal(data.chapters[0].files[0].lines?.[0].moved, true, 'the file list’s copy too');
  assert.equal(data.chapters[0].files[1].lines?.[0].moved, undefined);
});

test('a ref whose anchored line a later commit rewrites is marked moved, and one whose other lines change is not', () => {
  const world = setup();
  world.tell();
  const rewrite = (line: number, message: string) => {
    const all = lines(12, 'other');
    all[7] = 'const alsoChanged = true;';
    all[line - 1] = 'rewritten';
    writeFileSync(path.join(world.repo, 'other.js'), all.join('\n') + '\n');
    git(world.repo, 'commit', '-q', '-am', message);
  };
  rewrite(10, 'rewrite line 10');
  assert.deepEqual(
    world.moved().refs,
    { app: false, h2: false },
    'a line off the anchor says nothing',
  );
  rewrite(5, 'rewrite line 5');
  assert.deepEqual(
    world.moved().refs,
    { app: false, h2: true },
    'the hunk ref’s anchor is its first line',
  );
});

test('telling the story again changes nothing it should not: no chapters keeps the file, the same chapters keep the flag, a retold chapter takes a fresh anchor', () => {
  const world = setup();
  const made = world.tell();
  const file = path.join(made.dir, 'anchors.json');
  const told = readFileSync(file, 'utf8');
  insertAbove(world.repo, world.text);
  assert.equal(world.moved().refs.app, true);

  world.tell('HEAD', null);
  assert.equal(readFileSync(file, 'utf8'), told, 'no --chapters: no new baseline');
  assert.equal(world.moved().refs.app, true);

  world.tell('HEAD', JSON.parse(readFileSync(world.chapters, 'utf8')));
  assert.equal(world.moved().refs.app, true, 'the same chapters again: still flagged');
  assert.equal(readFileSync(file, 'utf8'), told);

  const body = JSON.parse(readFileSync(world.chapters, 'utf8'));
  body.chapters[0].narrative += ' Reworded.';
  world.tell('HEAD', body);
  assert.deepEqual(
    world.moved().refs,
    { app: false, h2: false },
    'retold over the new code: fresh',
  );
});

test('an unchanged story, even told again and again, is never marked moved', () => {
  const world = setup();
  world.tell();
  world.tell('HEAD', JSON.parse(readFileSync(world.chapters, 'utf8')));
  world.tell('HEAD', null);
  assert.deepEqual(world.moved().refs, { app: false, h2: false });
  // whitespace only: indent the changed line
  writeFileSync(
    path.join(world.repo, 'app.js'),
    world.text('app', '  const changed = true;  ').replace(/\n/g, '\r\n'),
  );
  git(world.repo, 'commit', '-q', '-am', 'whitespace');
  assert.deepEqual(world.moved().refs, { app: false, h2: false });
});

test('a story with no anchors.json, and a story pinned to a commit, serve no moved', () => {
  const world = setup();
  const made = world.tell();
  const tip = git(world.repo, 'rev-parse', 'HEAD');
  rmSync(path.join(made.dir, 'anchors.json'));
  insertAbove(world.repo, world.text);
  assert.deepEqual(world.moved().refs, { app: false, h2: false });

  const pinned = createLocalStory({
    home: world.home,
    repo: world.repo,
    base: world.base,
    head: tip,
    id: 'drift',
    chapters: world.chapters,
  });
  assert.ok(readFileSync(path.join(pinned.dir, 'anchors.json'), 'utf8'));
  assert.deepEqual(world.moved().refs, { app: false, h2: false });
});
