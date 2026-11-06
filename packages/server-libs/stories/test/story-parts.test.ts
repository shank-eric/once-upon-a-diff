import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { localRepo } from '@once-upon-a-diff/test-kit/git';
import { StoryStore } from '../src/store.ts';
import { createLocalStory } from '../src/local-story.ts';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';
import { PARTS_FILE, MAX_PARTS_BYTES, partsFileOf, userPartsFile } from '../src/parts.ts';

const parts = (name: string) => ({
  version: 1,
  groups: ['Code', 'Docs'],
  parts: [
    { id: 'source', name, group: 'Code', paths: ['src/'] },
    { id: 'docs', name: 'Docs', group: 'Docs', paths: ['README.md'] },
  ],
});

/** A PR story for acme/widgets#7 whose checkout the bridge has seen, and the checkout's folder. */
function prStory() {
  const home = tmp('home');
  const checkout = tmp('checkout');
  githubStory(path.join(home, 'acme-widgets-7'));
  seenCheckout(home, 'acme/widgets', checkout);
  return { home, checkout, store: new StoryStore({ home }) };
}

test('a story of a repo with no parts file has no parts: the field is absent', () => {
  const { store } = prStory();
  const data = store.load('acme-widgets-7')!;
  assert.ok(!('parts' in data));
});

test('a PR story reads its checkout’s parts file: what each chapter touches, the leftover chapter too, and the file counts', () => {
  const { store, checkout } = prStory();
  writeJson(path.join(checkout, PARTS_FILE), parts('Source'));
  const data = store.load('acme-widgets-7')!;
  // chapters 1 and 2 tell src/*, and README.md, which no chapter places, lands in the last "Not in a chapter yet" chapter
  assert.equal(data.chapters.length, 3);
  assert.deepEqual(data.parts!.by_chapter, [['source'], ['source'], ['docs']]);
  assert.deepEqual(data.parts!.files, { source: 2, docs: 1 });
  assert.deepEqual(data.parts!.groups, ['Code', 'Docs']);
  assert.deepEqual(
    data.parts!.parts.map((part) => part.name),
    ['Source', 'Docs'],
  );
});

test('the reviewer’s own file in <home>/parts wins over the checkout’s', () => {
  const { store, home, checkout } = prStory();
  writeJson(path.join(checkout, PARTS_FILE), parts('In the repo'));
  writeJson(userPartsFile(home, 'Acme/Widgets'), parts('Mine'));
  assert.equal(userPartsFile(home, 'Acme/Widgets'), path.join(home, 'parts', 'acme-widgets.json'));
  assert.equal(store.load('acme-widgets-7')!.parts!.parts[0].name, 'Mine');
});

test('a parts file that does not check out shows no strip and does not stop the story; a broken own file falls back to the repo’s', () => {
  const { store, home, checkout } = prStory();
  writeJson(path.join(checkout, PARTS_FILE), { version: 1, groups: [], parts: 'no' });
  assert.ok(!('parts' in store.load('acme-widgets-7')!));
  mkdirSync(path.dirname(userPartsFile(home, 'acme/widgets')), { recursive: true });
  writeFileSync(userPartsFile(home, 'acme/widgets'), '{not json');
  assert.equal(store.load('acme-widgets-7')!.chapters.length, 3);
  assert.ok(!('parts' in store.load('acme-widgets-7')!));
  writeJson(path.join(checkout, PARTS_FILE), parts('In the repo'));
  assert.equal(store.load('acme-widgets-7')!.parts!.parts[0].name, 'In the repo');
});

test('a local story reads the parts file of the worktree it diffs, and a file that left the diff is not counted', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  writeJson(path.join(repo, PARTS_FILE), {
    version: 1,
    groups: ['All'],
    parts: [
      { id: 'lib', name: 'Lib', group: 'All', paths: ['lib/'] },
      { id: 'text', name: 'Text', group: 'All', paths: ['one.txt', 'gone.txt'] },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD' });
  const data = new StoryStore({ home }).load(id)!;
  assert.deepEqual(
    data.parts!.files,
    { lib: 1, text: 2 },
    'one.txt changed, gone.txt deleted, lib/two.js added',
  );
  assert.ok(data.parts!.by_chapter.length === data.chapters.length);
});

test('a too-big or invalid personal parts file warns and falls back to the repo’s; an edit is picked up', () => {
  const { home, checkout } = prStory();
  const meta = { kind: 'github', repo: 'acme/widgets' } as never;
  writeJson(path.join(checkout, PARTS_FILE), parts('Repo'));
  mkdirSync(path.join(home, 'parts'), { recursive: true });
  const user = userPartsFile(home, 'acme/widgets');
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);

  writeFileSync(user, ' '.repeat(MAX_PARTS_BYTES + 1));
  assert.equal(partsFileOf(home, meta, warn)!.parts[0].name, 'Repo');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /KB/);

  // cached: the same bad file does not warn again
  partsFileOf(home, meta, warn);
  assert.equal(lines.length, 1);

  writeFileSync(user, '{"version":2}');
  assert.equal(partsFileOf(home, meta, warn)!.parts[0].name, 'Repo');
  assert.equal(lines.length, 2);

  writeJson(user, parts('Mine'));
  assert.equal(partsFileOf(home, meta, warn)!.parts[0].name, 'Mine');
  writeJson(user, parts('Mine2'));
  assert.equal(partsFileOf(home, meta, warn)!.parts[0].name, 'Mine2');
});
