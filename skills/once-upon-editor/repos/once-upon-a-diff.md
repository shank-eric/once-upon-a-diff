# once-upon-a-diff

This checkout's profile. To override it, put your own at `~/.once-upon/editor/once-upon-a-diff.md`; that file wins.

- Checkout: this repo's main checkout (the folder that holds `skills/`), GitHub owner from `git remote get-url origin`. Worktrees go in `../once-upon-a-diff-worktrees/<branch>`, next to the checkout. Briefs say to read `<checkout>/AGENTS.md` first.
- Claim: `once-upon backlog claim <id> --agent <name> --branch <b> --sid <your sid8> --repo <owner>/once-upon-a-diff`
- Agent command (start, state, finish, list): `once-upon agent`
- Stories: none for this repo's own changes unless the user asks. Nothing is pushed.
- Heavy for `once-upon heavy`: the full `yarn test`, `yarn test:extension`, `yarn typecheck`, `yarn lint` and `scripts/deploy-local.sh --batch`. A targeted `node --test test/<file>.test.ts` is light.
- Deploy (a deploy agent, never the author): `OU_MAIN=<checkout> scripts/deploy-local.sh --yes <branch>` (fast-forward) or `--yes --batch main <sha>`. If a batch cherry-pick conflicts, `git cherry-pick --abort` in the deploy worktree, have the author rebase onto main, then ff-deploy. Never restart the live bridge and never reload the extension.
- Card order: `once-upon backlog list`, top first, skipping done, claimed and held cards.
