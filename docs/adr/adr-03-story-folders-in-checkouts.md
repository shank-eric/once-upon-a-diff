# ADR-03: Story folders in each checkout's `.once-upon/`

Descriptive draft, 10/27, of the code on `stack/5-board-checks` (8710395). Since 11/5: the placement code is `placement.ts` in `packages/stories` (it was `records/stories/` in `packages/core` and `services/stories/` before, ADR-20 and ADR-24). The rules are unchanged.

## Context

A story is a folder: `chapters.json` (the once-upon skill's format), `meta.json` (what it's a story of), and either `file-map.json` (a PR story) or `local.diff` (a local story). Stories are about a repo, and the skill and listeners work in that repo's checkout. Before this, stories lived in `~/.once-upon/<id>/`.

## Decision

`packages/stories/src/placement.ts`:

- **A PR story** goes in the repo's **main** checkout: `<main checkout>/.once-upon/<Owner>-<repo>-<N>/` (`mainCheckout` follows a worktree to the checkout its `.git` belongs to, since worktrees come and go).
- **A local story** goes in the worktree it diffs: `<worktree>/.once-upon/local-<folder>-<branch>/`.
- **No known checkout** means `~/.once-upon/<id>/`, as before.
- The checkout comes from `checkouts.json` (last seen by `wait --repo`, `once-upon local`, or a local page load), else `<checkout_dirs>/<name>` with the same origin.
- `.once-upon/` is kept out of git by one line in the common `.git/info/exclude`, written by `excludeStories`. Nothing is committed and `git status` stays clean.
- Every placed story is recorded in `~/.once-upon/stories.json` (`{id: folder}`). `StoryStore.dirs()` reads the index first, then every child folder of `~/.once-upon`.
- `once-upon publish` and `once-upon local` are the only ways a story is placed.
- **The state about a story stays in `~/.once-upon/state/<key>/`**, not in its folder (ADR-04).

## Consequences

- Stories sit beside the code they describe, and a session working in the checkout can read them with plain paths.
- Deleting a worktree deletes its local stories. Their `stories.json` entries and `state/` folders stay behind.
- PR story folders build up in the main checkout, with no cleanup for merged PRs. `merged.json` only hides them from the board.
- `git clean -fdX` (capital X, ignored files) would remove `.once-upon/` along with every story in that checkout, because exclude patterns count as ignored. The state in `~/.once-upon` would survive, pointing at nothing.
- The story and the state about it live apart, with two key schemes (story id, or PR key for drafts and reads). Moving or renaming one doesn't move the other.
- `checkouts.json` can name a worktree (say `owner/repo` → `~/code/repo-worktrees/feature`). PR stories still go to the main checkout through `mainCheckout`, but listen prompts say to work in the worktree.
- Any child folder of `~/.once-upon` with `chapters.json` and `meta.json` is a story. Folders left by the retired turn capture (`turn-t_*`) are listed that way.

## Open questions

1. Should merged PR stories be archived or deleted after a while, and their state with them?
2. Should `stories.json` drop entries whose folder is gone, on read or in `doctor`?
3. Should a story's state live in its own folder, so the two can't drift apart, or should stories move back under `~/.once-upon` so nothing sits in checkouts?
4. Should `doctor` warn about stories that `git clean -X` would remove?
