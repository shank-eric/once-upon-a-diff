import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeOfPath } from '@once-upon-a-diff/terms/pr-key';
import { createHostPage } from '../src/diff-dom.ts';
import { GITHUB_HOST_LINKS, backFromRange, rangeStepOf, rangeUrl } from '../src/ranges.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/7';

/** Runs `run` with location standing at `url`, then puts the old one back. */
function atUrl<T>(url: string, run: () => T): T {
  const saved = globalThis.location;
  const place = Object.assign(new URL(url), {
    replace(target: string) {
      place.hash = target;
    },
  });
  Object.assign(globalThis, { location: place });
  try {
    return run();
  } finally {
    Object.assign(globalThis, { location: saved });
  }
}

test('a "Since you read it" chapter finds its range page, and GitHub\'s link to it', () => {
  const chapters = [
    { title: 'Since you read it', since: { from: SHA_A, to: SHA_B } },
    { title: 'Chapter 1: Start' },
  ];
  assert.deepEqual(rangeOfPath(`/acme/widgets/pull/7/files/${SHA_A}..${SHA_B}`), {
    from: SHA_A,
    to: SHA_B,
  });
  assert.deepEqual(rangeOfPath('/acme/widgets/pull/7/changes/aaaaaaa..bbbbbbb/'), {
    from: 'aaaaaaa',
    to: 'bbbbbbb',
  });
  for (const prCase of [
    '/acme/widgets/pull/7/files',
    '/acme/widgets/pull/7/changes',
    `/acme/widgets/pull/7/commits/${SHA_A}`,
  ]) {
    assert.equal(rangeOfPath(prCase), null, prCase);
  }
  assert.equal(
    rangeStepOf(chapters, '/acme/widgets/pull/7/files/aaaaaaa..bbbbbbb'),
    1,
    'short SHAs match the full ones',
  );
  assert.equal(rangeStepOf(chapters, `/acme/widgets/pull/7/files/${SHA_B}..${SHA_A}`), null);
  assert.equal(rangeStepOf(chapters, '/acme/widgets/pull/7/files'), null);
  assert.equal(
    rangeUrl(PR_URL, { from: SHA_A, to: SHA_B }),
    `${PR_URL}/changes/${SHA_A}..${SHA_B}`,
  );
  assert.equal(
    rangeUrl(null, { from: SHA_A, to: SHA_B }),
    null,
    'a local story has no GitHub link',
  );
});

test('GitHub host: rangeLink is the /changes URL of the range', () => {
  const since = { from: SHA_A, to: SHA_B };
  assert.equal(GITHUB_HOST_LINKS.rangeLink(PR_URL, since), `${PR_URL}/changes/${SHA_A}..${SHA_B}`);
  assert.equal(
    GITHUB_HOST_LINKS.rangeLink(`${PR_URL}/`, since),
    `${PR_URL}/changes/${SHA_A}..${SHA_B}`,
  );
  assert.equal(GITHUB_HOST_LINKS.rangeLink(undefined, since), null);
  assert.equal(GITHUB_HOST_LINKS.rangeLink(PR_URL, null), null);
});

test("GitHub host: backFromRange is the whole PR_URL changes link, only on that range's own page", () => {
  const since = { from: SHA_A, to: SHA_B };
  const onRange = `https://github.com/acme/widgets/pull/7/changes/${SHA_A}..${SHA_B}`;
  assert.equal(
    atUrl(onRange, () => backFromRange(PR_URL, since)),
    `${PR_URL}/changes`,
  );
  assert.equal(
    atUrl('https://github.com/acme/widgets/pull/7/changes', () => backFromRange(PR_URL, since)),
    null,
  );
  assert.equal(
    atUrl(onRange, () => backFromRange(undefined, since)),
    null,
  );
});

test('GitHub host: canPostDrafts is true', () => {
  assert.equal(GITHUB_HOST_LINKS.canPostDrafts, true);
});

test('the page names the file the URL hash points at, and points the hash at a file', () => {
  const sha = 'c'.repeat(64);
  const other = 'd'.repeat(64);
  const page = createHostPage({
    shaToPath: new Map([[sha, 'src/a.ts']]),
    pathToSha: new Map([['src/a.ts', sha]]),
    allPaths: new Set(['src/a.ts']),
    hostId: 'h',
    panelId: 'p',
  });
  assert.equal(
    atUrl(`${PR_URL}/changes#diff-${sha}`, () => page.fileOfHash()),
    'src/a.ts',
  );
  assert.equal(
    atUrl(`${PR_URL}/changes#diff-${sha}R45`, () => page.fileOfHash()),
    'src/a.ts',
  );
  assert.equal(
    atUrl(`${PR_URL}/changes#diff-${other}`, () => page.fileOfHash()),
    null,
    'not a story file',
  );
  assert.equal(
    atUrl(`${PR_URL}/changes#diff-abc`, () => page.fileOfHash()),
    null,
    'not a sha256',
  );
  assert.equal(
    atUrl(`${PR_URL}/changes`, () => page.fileOfHash()),
    null,
  );
  assert.equal(
    atUrl(`${PR_URL}/changes`, () => {
      page.hashToFile('src/a.ts');
      return location.hash;
    }),
    `#diff-${sha}`,
  );
});
