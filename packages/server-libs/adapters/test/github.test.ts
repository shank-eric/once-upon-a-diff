import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { ghApiJson, ghGraphql, runGh } from '../src/github.ts';

/** A fake gh that prints this shell body's output (its arguments are "$*"). */
function fakeGh(body: string): string {
  const file = path.join(tmp('fake-gh'), 'gh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function withGh<T>(binary: string, run: () => Promise<T>): Promise<T> {
  const was = process.env.ONCE_UPON_GH;
  try {
    process.env.ONCE_UPON_GH = binary;
    return await run();
  } finally {
    if (was === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = was;
    }
  }
}

test('runGh: stdout on success, the first line of stderr on failure', async () => {
  await withGh('/bin/echo', async () => {
    assert.equal((await runGh(['api', 'user'])).trim(), 'api user');
  });
  await withGh('/bin/sh', async () => {
    await assert.rejects(
      runGh(['-c', 'echo first >&2; echo second >&2; exit 1']),
      /^Error: first$/,
    );
  });
});

test('ghApiJson and ghGraphql build the gh api arguments (numbers as -F, strings as -f) and parse the answer', async () => {
  // the arguments come back as one JSON string
  await withGh(fakeGh(`printf '"%s"' "$*"`), async () => {
    assert.equal(await ghApiJson('user'), 'api user');
    assert.deepEqual(await ghApiJson('repos/o/r/pulls', { paginate: true }), [
      'api repos/o/r/pulls --paginate',
    ]);
    assert.equal(
      await ghGraphql('query { a }', { owner: 'o', pr: 7 }),
      'api graphql -f query=query { a } -f owner=o -F pr=7',
    );
  });
});

test('ghApiJson with paginate joins the pages; text that is not JSON is refused', async () => {
  await withGh(fakeGh(`printf '[1,2]\\n[3]\\n'`), async () => {
    assert.deepEqual(await ghApiJson('items', { paginate: true }), [1, 2, 3]);
  });
  await withGh(fakeGh('echo not json'), async () => {
    await assert.rejects(ghApiJson('user'), /isn't JSON/);
  });
});
