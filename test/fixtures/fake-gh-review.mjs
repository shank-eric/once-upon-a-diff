#!/usr/bin/env node
// A stand-in for `gh api graphql`: logs each call to $FAKE_GH_LOG and answers the
// three queries review.mjs makes. Set FAKE_GH_PENDING=1 to pretend a pending review exists,
// FAKE_GH_FAIL=1 to have GitHub refuse the thread.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const query = (args.find((arg) => arg.startsWith('query=')) || '').slice('query='.length);
if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
}

let data;
if (query.includes('reviews(states: PENDING')) {
  data = {
    viewer: { login: 'octocat' },
    repository: {
      pullRequest: {
        id: 'PR_1',
        reviews: {
          nodes: process.env.FAKE_GH_PENDING
            ? [{ id: 'PRR_old', author: { login: 'octocat' } }]
            : [{ id: 'PRR_other', author: { login: 'someone-else' } }],
        },
      },
    },
  };
} else if (query.includes('addPullRequestReview(')) {
  data = { addPullRequestReview: { pullRequestReview: { id: 'PRR_new', state: 'PENDING' } } };
} else if (query.includes('addPullRequestReviewThread') && process.env.FAKE_GH_FAIL) {
  process.stderr.write('GraphQL: Line could not be resolved\n');
  process.exit(1);
} else if (query.includes('addPullRequestReviewThread')) {
  data = {
    addPullRequestReviewThread: {
      thread: {
        id: 'T_1',
        comments: { nodes: [{ url: 'https://github.com/acme/widgets/pull/7#discussion_r1' }] },
      },
    },
  };
} else {
  process.stderr.write('fake gh: unexpected query\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ data }));
