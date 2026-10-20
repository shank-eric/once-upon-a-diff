#!/usr/bin/env node
// A stand-in for `gh api` in tests: prints canned JSON for the GETs the bridge makes, and fails anything else.
const args = process.argv.slice(2);
if (args[0] !== 'api' || args.some(a => /^-(f|F|X)$|^--(method|field|raw-field|input)$/.test(a))) { process.stderr.write('fake gh: only read-only api calls\n'); process.exit(2); }
const url = args[1];
const me = { login: 'shank-eric' };
const other = { login: 'someone' };
const out = {
  user: me,
  'repos/acme/widgets/pulls/7/comments?per_page=100': [
    { user: me, path: 'src/a.js', line: 3, body: 'Could you confirm what happens with an empty list here? I think it throws.', html_url: 'https://github.com/acme/widgets/pull/7#discussion_r1' },
    { user: other, path: 'src/b.js', line: 1, body: 'Nice tidy-up of the old code.', html_url: 'https://github.com/acme/widgets/pull/7#discussion_r2' },
  ],
  'repos/acme/widgets/pulls/7/reviews?per_page=100': [{ id: 55, user: me, state: 'PENDING', body: '', html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-55' }],
  'repos/acme/widgets/pulls/7/reviews/55/comments?per_page=100': [{ user: me, path: 'src/b.js', line: 10, body: 'Optional: this name reads oddly next to the other helpers.' }],
  'repos/acme/widgets/issues/7/comments?per_page=100': [],
}[url];
if (out === undefined) { process.stderr.write(`fake gh: no fixture for ${url}\n`); process.exit(1); }
process.stdout.write(JSON.stringify(out));
