import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartsFile, partOf, storyPartsOf, touchedParts } from '../src/parts.ts';

const file = parsePartsFile({
  version: 1,
  groups: ['Server', 'Repo'],
  parts: [
    { id: 'api', name: 'API', group: 'Server', paths: ['src/api/'], note: 'the routes' },
    { id: 'billing', name: 'Billing', group: 'Server', paths: ['src/api/billing/', 'src/pay.ts'] },
    { id: 'docs', name: 'Docs', group: 'Repo', paths: ['docs/', 'README.md'] },
  ],
})!;

test('a file is in the part with its longest matching path, a folder or the exact file', () => {
  assert.equal(partOf('src/api/users.ts', file), 'api');
  assert.equal(partOf('src/api/billing/charge.ts', file), 'billing');
  assert.equal(partOf('src/pay.ts', file), 'billing');
  assert.equal(partOf('README.md', file), 'docs');
  assert.equal(partOf('src/pay.tsx', file), 'other', 'an exact path is not a prefix');
  assert.equal(partOf('src/apiary/x.ts', file), 'other', 'a folder path is not a name prefix');
  assert.equal(partOf('lib/unknown.ts', file), 'other');
});

test('the parts a set of files touches come once each, in the file’s order, other last', () => {
  assert.deepEqual(touchedParts(['docs/a.md', 'src/api/x.ts', 'docs/b.md'], file), ['api', 'docs']);
  assert.deepEqual(touchedParts(['lib/x.ts', 'src/pay.ts'], file), ['billing', 'other']);
  assert.deepEqual(touchedParts([], file), []);
});

test('a story’s parts: each chapter’s touched ids and the file counts, with other only when a file needs it', () => {
  const chapters = [['src/api/a.ts', 'README.md'], ['src/pay.ts'], []];
  const parts = storyPartsOf(file, chapters, ['src/api/a.ts', 'README.md', 'src/pay.ts']);
  assert.deepEqual(parts.by_chapter, [['api', 'docs'], ['billing'], []]);
  assert.deepEqual(parts.files, { api: 1, docs: 1, billing: 1 });
  assert.deepEqual(parts.groups, ['Server', 'Repo']);
  assert.deepEqual(
    parts.parts.map((part) => part.id),
    ['api', 'billing', 'docs'],
  );
  assert.equal(parts.parts[0].note, 'the routes');
  assert.ok(!('note' in parts.parts[1]));

  const withOther = storyPartsOf(file, [['x/y.ts']], ['x/y.ts']);
  assert.deepEqual(withOther.groups, ['Server', 'Repo', 'Other']);
  assert.deepEqual(withOther.parts.at(-1), { id: 'other', name: 'Other', group: 'Other' });
  assert.deepEqual(withOther.by_chapter, [['other']]);
});

test('a parts file that does not check out is refused whole', () => {
  const part = { id: 'a', name: 'A', group: 'G', paths: ['a/'] };
  const ok = { version: 1, groups: ['G'], parts: [part] };
  assert.ok(parsePartsFile(ok));
  const bad: unknown[] = [
    null,
    'text',
    [],
    { ...ok, version: 2 },
    { ...ok, groups: 'G' },
    { ...ok, groups: ['G', 'G'] },
    { ...ok, parts: [part, part] },
    { ...ok, parts: [{ ...part, id: 'Not Ok' }] },
    { ...ok, parts: [{ ...part, id: 'other' }] },
    { ...ok, parts: [{ ...part, name: 'x'.repeat(25) }] },
    { ...ok, parts: [{ ...part, group: 'Missing' }] },
    { ...ok, parts: [{ ...part, paths: 'a/' }] },
    { ...ok, parts: [{ ...part, paths: [''] }] },
    { ...ok, parts: [{ ...part, note: 3 }] },
    { ...ok, parts: [null] },
    { ...ok, parts: Array.from({ length: 41 }, (_, i) => ({ ...part, id: `p${i}` })) },
  ];
  bad.forEach((one, index) => assert.equal(parsePartsFile(one), null, `case ${index}`));
});

test('a file with its own group named Other gets one Other group, not two', () => {
  const file = parsePartsFile({
    version: 1,
    groups: ['Other'],
    parts: [{ id: 'a', name: 'A', group: 'Other', paths: ['a/'] }],
  })!;
  const story = storyPartsOf(file, [['z.txt']], ['z.txt']);
  assert.deepEqual(story.groups, ['Other']);
  assert.equal(story.parts.at(-1)!.id, 'other');
});

test('paths are normalized: ./ and backslashes work, an absolute path refuses the file with a warning', () => {
  const part = { id: 'a', name: 'A', group: 'G', paths: ['./src\\x/', './README.md'] };
  const file = parsePartsFile({ version: 1, groups: ['G'], parts: [part] })!;
  assert.deepEqual(file.parts[0].paths, ['src/x/', 'README.md']);
  assert.equal(partOf('src/x/y.ts', file), 'a');
  assert.equal(partOf('README.md', file), 'a');
  for (const bad of ['/etc/x', 'C:\\x', './']) {
    const lines: string[] = [];
    const raw = { version: 1, groups: ['G'], parts: [{ ...part, paths: [bad] }] };
    assert.equal(
      parsePartsFile(raw, (line) => lines.push(line)),
      null,
      bad,
    );
    assert.equal(lines.length, 1, bad);
  }
});
