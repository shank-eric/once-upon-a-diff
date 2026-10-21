import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmp } from './helpers.mjs';
import { readJson, writeJson, writeJsonAtomic } from '../bridge/util/json-file.mjs';
import { runGh } from '../bridge/util/gh.mjs';

test('JSON files: a fallback for a missing or broken file, pretty output, no temp file left', () => {
  const dir = tmp('json-file');
  const file = path.join(dir, 'state.json');
  assert.deepEqual(readJson(file, { empty: true }), { empty: true });
  writeFileSync(file, '{not json');
  assert.equal(readJson(file), null);
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  writeJsonAtomic(file, { b: [1, 2] });
  assert.deepEqual(readJson(file), { b: [1, 2] });
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('runGh: stdout on success, the first line of stderr on failure', async () => {
  const was = process.env.DIFF_STORY_GH;
  try {
    process.env.DIFF_STORY_GH = '/bin/echo';
    assert.equal((await runGh(['api', 'user'])).trim(), 'api user');
    process.env.DIFF_STORY_GH = '/bin/sh';
    await assert.rejects(
      runGh(['-c', 'echo first >&2; echo second >&2; exit 1']),
      /^Error: first$/,
    );
  } finally {
    if (was === undefined) {
      delete process.env.DIFF_STORY_GH;
    } else {
      process.env.DIFF_STORY_GH = was;
    }
  }
});
