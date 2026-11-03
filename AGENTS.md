# Agent rules for this repo

Standing rules for any agent working in Once Upon a Diff. A brief only needs to add the task.

## Git

- Never push. Never open a PR.
- One commit per branch. Squash your own work before handing back.
- Worktrees go in `../once-upon-a-diff-worktrees/<name>`, next to the main checkout, never inside it.
- Never delete branches or worktrees.

## Backlog cards

- When you take a backlog card, run `once-upon backlog claim <id> --agent <your name> [--branch <branch>]` first thing. `<your name>` is the name in your ledger line and beat lines, and `--branch` also starts the card on that branch.
- Whoever launches an agent for a card runs the same claim right after launching it, with `--sid` (its own session id's first 8 characters), so the card is linked before the agent's first line.
- A claim is for one run of the agent. It ends when that run finishes or the card lands (`done`) or is dropped, and a later run under the same name must claim again.
- The board links a card and an agent only through a claim, never by the task text, the agent's name or its worktree folder. A claimed card is one card in Working with its agent on it, and its agent holds a build slot.

## The live bridge

- Never restart the live bridge (port 4823) and never reload the extension.
- Deploys happen only through `scripts/deploy-local.sh`, run by the main session. The default is `--yes <branch-or-sha>` (fast-forward, no gates); `--batch <base> <sha>...` cherry-picks and runs the gates in the one `deploy` worktree.

## Tests and checks

- Run quiet. Targeted first (`node --test test/<file>.test.ts` from `packages/bridge`), then the full suite once. Print failures only.
- One heavy test run at a time. Check the load before starting a second one.
- Before handing back: `yarn lint`, `yarn typecheck`, `yarn format:check`, `yarn test`.
- The `/api/board` goldens live in `packages/bridge/test/fixtures/board-worlds/golden/`. A change that should alter the board rewrites them with `UPDATE_SNAPSHOTS=1 node --test test/board-snapshot.test.ts`. Review the diff.

## Browsers

- Never open a browser or drive one.

## Structure

- The layer rules live in `eslint.boundaries.mjs` (branch stack/48). Do not work around them. Change the rule file if a layer really has to move.
- The bridge's server (`packages/bridge/src`) has four layers: `server/` (HTTP, with `routes/`) and `cli/` are apps over `services/`, which sit over `adapters/`. Only an adapter runs a program, writes a file or reaches the network: add a function to `adapters/` (`os.ts`, `git.ts`, `stores/files.ts`...) instead of calling `child_process`, `node:fs` writes or `fetch` from a service, a route or a command. `bin/once-upon.ts` is the one place that knows both apps.
- The client has packages too: `packages/panel` (the story panel, host-agnostic, regions `ask`, `drafts`, `fixes`, `reading`, `rebuild`), `packages/web` (the board and local pages; the board's regions are `public/board/<region>/`) and `packages/extension` (GitHub's host adapter wiring). A region imports no other region. The panel gets its host adapters injected (`panel/src/host.ts`) and never imports them.
- Prefer codemods for moves and renames: `git mv` plus ts-morph or sed, then check the diff is only the move.

## Reporting

- Post progress beats with `~/Configuration/scripts/beat.sh <name> <N>/<M> <step> "<few words>"`.
- Ledger lines are the main session's job. Do not write to the ledger.
- Keep the final report short: what changed, the checks you ran, anything left open.
