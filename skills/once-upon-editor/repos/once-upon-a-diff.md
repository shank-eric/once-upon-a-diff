# once-upon-a-diff

This checkout's profile. To override it, put your own at `~/.once-upon/editor/once-upon-a-diff.md`; that file wins.

- Checkout: this repo's main checkout (the folder that holds `skills/`), GitHub owner from `git remote get-url origin`. Worktrees go in `../once-upon-a-diff-worktrees/<branch>`, next to the checkout. Briefs say to read `<checkout>/AGENTS.md` first.
- Claim: `once-upon backlog claim <id> --agent <name> --branch <b> --sid <your sid8> --repo <owner>/once-upon-a-diff`
- Agent command (start, state, finish, list): `once-upon agent`
- Stories: every branch gets a local story the user reviews before deploy (since 11/6; this repo no longer skips review). Launch its storyteller with the critic, registered `--role storyteller --card <id>`: an open storyteller holds the card in Agent checks, the story waiting on the user shows in Ready for your review, and the approved one in Ready to ship. Nothing is pushed.
- Heavy for `once-upon heavy`: the full `yarn test`, `yarn test:extension`, `yarn typecheck`, `yarn lint`. (`scripts/deploy-local.sh` takes the lock through `once-upon deploy`, never also through `heavy`: nested, it would wait on itself.) A targeted `node --test test/<file>.test.ts` is light.
- Deploy (the editor runs it itself, never an author or an agent): `OU_MAIN=<checkout> ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon deploy <name> scripts/deploy-local.sh --yes <branch>` (fast-forward) or `... scripts/deploy-local.sh --yes --batch main <sha>` (the variable goes before the wrapper: `once-upon deploy` takes a program and its arguments, not shell syntax). If a batch cherry-pick conflicts, the diagnosis agent only reads the log and names the conflicting files (the next deploy run aborts the cherry-pick left in the deploy worktree itself), then a fresh fixer rebases onto main (the branch, the new base and the conflicting files in its brief), then ff-deploy. Never restart the live bridge and never reload the extension.
- Card order: `once-upon backlog list`, top first, skipping done, claimed and held cards.
