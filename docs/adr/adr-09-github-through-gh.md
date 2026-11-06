# ADR-09: GitHub through `gh`, read-mostly, never waited on

Descriptive, of the code on main at 0741c6c (10/29). Since 11/5: the GitHub code is in `packages/core`. What `review/` held is split by tier: the GitHub facts (`github-checks.ts`, `pending-review.ts`) are `records/github/`, and the features that use them (`drafts.ts`, `freshness.ts`, the watcher) are `features/review/` (ADR-21). `foundation/gh.ts` is the old `config/gh.ts`. The decision is unchanged.

## Context

The panel and the board need GitHub facts: the PR's head (is the story out of date?), your posted and pending comments (what became of each draft?), reviews, Viewed state, merge state, checks and threads. The reviewer already has `gh` logged in. The product promises it never posts on its own.

## Decision

- **Every GitHub call goes through the `gh` CLI** (`runGh` in `packages/adapters/src/github.ts`, which `packages/foundation/src/gh.ts` wraps to drop `GITHUB_TOKEN`), as the reviewer's own login, with `GITHUB_TOKEN` dropped when `gh_unset_github_token` is set. There's no GitHub API client, no app and no webhook.
- **Reads:** REST GETs for comments, reviews, pull and compare (`packages/core/src/features/review/drafts.ts`, `packages/core/src/features/review/freshness.ts`), and GraphQL queries for PR facts, a branch's PR and review requests (`packages/state/src/records/github/github-checks.ts`). The skills' `gather.sh` and `viewed.sh` are read-only too.
- **Four writes, each on a click.** One goes through `gh`: Add to my review (`packages/state/src/records/github/pending-review.ts`), which puts a draft into your pending review and never submits it. Three are `git push` from the story's checkout with your own git login, all from a local story's page and the full key's alone (ADR-02, ADR-08): Create pull request's `git push -u origin <branch>`, Push for a branch whose open PR is behind it (a fast-forward of the commits made since), and Push to the default branch (a fast-forward of the approved commit). None forces, and each is refused when the remote has commits this checkout doesn't. Nothing runs `gh pr create`, and Copy as gh script only copies.
- **`gh` also checks before the default-branch push,** read-only: the branch's protection and its rulesets, and whether a branch already has an open PR. A protection answer it can't get stops the push.
- **Caching in the bridge's memory:** 60 s for comments and freshness, 3 min per PR for AutoReview facts (one check per PR for everything on the board), 3 min per branch, 30 min for branch-protection rules. The `gh` login is kept until restart. Nothing uses `gh --cache`.
- **Pages never wait on GitHub.** The board starts checks in the background and render what's known. A PR's details fill in a few seconds after first sight.

## Consequences

- No credentials to manage beyond `gh auth`. Logged out, the story still works, and freshness, drafts and board details stay empty.
- The bridge process holds the same `gh` and git power as the user. Read-only behavior is a property of the code, not of the token. The README asks listeners to use a read-only `GH_TOKEN`, but the bridge needs write scope for Add to my review, and its pushes use whatever git credentials the checkout has.
- GitHub state is up to 60 s to 3 min stale. Back to you and auto-review marks lag that much.
- Load grows with open pages and PRs. The PR-facts query is large (reviews, threads, comments, files, paginated), run per PR every 3 min while the board is open, plus one per session branch with no story.
- The caches are unbounded maps keyed by PR and branch. They reset on restart.

## Open questions

1. Should the bridge run `gh` with a fine-grained token scoped to pull-request writes only, separate from the listeners' read-only one?
2. Should the PR-facts query drop to a lighter one for PRs the board shows only as Done or PR open?
3. Is a GitHub App or webhooks ever worth it, or is polling `gh` the line for a local tool?
