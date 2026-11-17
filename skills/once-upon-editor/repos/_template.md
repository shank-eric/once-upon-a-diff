# <repo directory name>

Copy this file to `~/.once-upon/editor/<repo directory name>.md` (or `$ONCE_UPON_HOME/editor/`) and fill it in. The editor reads that file first, then `repos/<repo directory name>.md` in this folder. Delete the lines that don't apply.

- Checkout: `<absolute path of the live checkout>`, GitHub `<owner>/<name>`. Worktrees go in `<repo's parent>/<repo>-worktrees/<branch>`. Briefs say to read `<checkout>/AGENTS.md` first.
- Agents are launched with `once-upon dispatch` and end with `once-upon handback` (they claim, register and finish through `once-upon`'s own files): a repo needs no claim or agent command line.
- Stories: does a branch get a story for the reader before it ships? (yes: add storytellers; no: critics only)
- Heavy for `once-upon heavy`: the commands that take turns, for example the full test suite, a browser run, a whole-repo typecheck or lint (not the deploy command: `once-upon deploy` takes the lock for it). A single-spec browser run may name `once-upon heavy --lane browser` instead, its own one-at-a-time lock. A single-file test is light.
- Deploy (the editor runs it itself, never an author or an agent): the full line, `<VAR=value ...> ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon deploy <name> <program> <arguments>` (any environment variable goes before the wrapper: `once-upon deploy` takes a program and its arguments, not shell syntax), and what it must never do (push, restart something live). Or `none`, for a repo with no local deploy (a PR-based repo): the card ends at an approved story, and the user opens the PR.
- Card order: where the cards come from (`once-upon backlog list`) and any parked line or dependencies.
- Reviews: the folder for critic reports, used when your user file names none (else `~/.once-upon/reviews`).
- Memory or notes to read: any extra files the editor should read at start.
- Optional, for the repo's own AGENTS.md (copy it there so every agent reads it): `Never git stash (the stash is shared by every worktree). Run scratch probes under a hard timeout (timeout 30 ...) and check ps for leftovers.`
