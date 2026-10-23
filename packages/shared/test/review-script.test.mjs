import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from 'once-upon-a-diff/test/helpers';
import { scriptDrafts, reviewScript } from '../src/panel/review-script.ts';

const RELS = ['src/a.js', 'lib/b.js'];
const NASTY = 'It\'s "quoted" $(touch PWNED) `touch PWNED2` $HOME\nONCE_UPON_REVIEW_JSON\n\\n end';
const CHAPTERS = [
  {
    comments: [
      { path: 'src/a.js', line: 2, body: 'Could you confirm?' },
      { path: 'b.js', line: 7, side: 'L', body: NASTY },
      { path: '(general)', line: 0, body: 'Thanks for this.' },
    ],
  },
  {
    comments: [
      { path: 'src/a.js', line: 9, body: 'Dismissed one.' },
      { path: 'src/a.js', line: 10, body: 'Posted one.' },
      { path: 'src/a.js', line: 11, body: 'Added one.' },
      { path: 'src/a.js', line: 12, body: 'Fix one.' },
    ],
  },
];
const ROWS = [
  { chapter: 1, index: 0, status: 'draft', dismissed: false },
  { chapter: 2, index: 0, status: 'draft', dismissed: true },
  { chapter: 2, index: 1, status: 'posted', dismissed: false },
  {
    chapter: 2,
    index: 2,
    status: 'draft',
    dismissed: false,
    added: { at: '2026-10-22T12:00:00Z' },
  },
  { chapter: 2, index: 3, status: 'draft', dismissed: false, fix: { id: 'n1' } },
];

test('only line drafts still to post go in, with full paths and sides', () => {
  const drafts = scriptDrafts(CHAPTERS, ROWS, RELS);
  assert.deepEqual(drafts.comments, [
    { path: 'src/a.js', line: 2, side: 'RIGHT', body: 'Could you confirm?' },
    { path: 'lib/b.js', line: 7, side: 'LEFT', body: NASTY },
  ]);
  assert.equal(drafts.general, 1, 'the general draft is left for Copy');
  assert.equal(drafts.inReview, 1, 'the one Add to my review put in their pending review');
  const script = reviewScript({ repo: 'acme/widgets', number: 7, ...drafts });
  assert.match(
    script,
    /^# Once Upon a Diff: 2 drafted comments on acme\/widgets#7, as one pending review\./,
  );
  assert.match(script, /# You do: 1 draft is in it already/);
  assert.match(script, /# Left out: 1 general comment/);
  assert.doesNotMatch(script, /"event"/, 'no event, so GitHub keeps the review PENDING');
  assert.throws(() => reviewScript({ repo: 'acme/widgets; rm -rf ~', number: 7, comments: [] }));
});

test('the script sends the comments to gh api as JSON on stdin, untouched by the shell', () => {
  const dir = tmp('script');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // a stand-in gh: records its arguments, its stdin and whether GITHUB_TOKEN reached it
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\nprintf '%s' "\${GITHUB_TOKEN:-unset}" > "${dir}/token"\n`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const home = path.join(dir, 'home');
  writeJson(path.join(home, 'config.json'), { gh_unset_github_token: true });
  const drafts = scriptDrafts(CHAPTERS, ROWS, RELS);
  const script = reviewScript({ repo: 'acme/widgets', number: 7, ...drafts });
  execFileSync('sh', ['-c', script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ONCE_UPON_HOME: home,
      GITHUB_TOKEN: 'not-this-one',
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'stdin'), 'utf8')), {
    comments: drafts.comments,
  });
  const args = readFileSync(path.join(dir, 'args'), 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 6), [
    'api',
    '--method',
    'POST',
    'repos/acme/widgets/pulls/7/reviews',
    '--input',
    '-',
  ]);
  assert.ok(!existsSync(path.join(dir, 'PWNED')) && !existsSync(path.join(dir, 'PWNED2')));
  let hasJq = true;
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
  } catch {
    hasJq = false;
  }
  if (hasJq) {
    assert.equal(
      readFileSync(path.join(dir, 'token'), 'utf8'),
      'unset',
      'gh_unset_github_token is honored',
    );
  }
});
