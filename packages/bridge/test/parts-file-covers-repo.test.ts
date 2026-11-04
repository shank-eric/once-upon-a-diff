import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OTHER_PART_ID, parsePartsFile, partOf } from '@once-upon-a-diff/protocol/domain/parts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// this repo's own parts file is what its stories draw: a new folder with no part fails here, so the names keep up with the tree
test('every tracked file of this repo is in a named part of .once-upon-parts.json', () => {
  const file = parsePartsFile(JSON.parse(readFileSync(`${root}.once-upon-parts.json`, 'utf8')));
  assert.ok(file, 'the parts file checks out');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(tracked.length > 100);
  const loose = tracked.filter((rel) => partOf(rel, file) === OTHER_PART_ID);
  assert.deepEqual(loose, [], 'files in no part: add a path to one in .once-upon-parts.json');
  const unused = file.parts.filter((part) => !tracked.some((rel) => partOf(rel, file) === part.id));
  // a part with no files left is worth a look, not a failure
  if (unused.length) {
    console.log(`note: parts no tracked file is in: ${unused.map((part) => part.id).join(', ')}`);
  }
});
