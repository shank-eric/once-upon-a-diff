# Agent rules for this repo

Standing rules for any agent working in Once Upon a Diff. A brief only needs to add the task.

## Git

- Never push. Never open a PR.
- One commit per branch. Squash your own work before handing back.
- Worktrees go in `../once-upon-a-diff-worktrees/<name>`, next to the main checkout, never inside it.
- Never delete branches or worktrees.

## The live bridge

- Never restart the live bridge (port 4823) and never reload the extension.
- Deploys happen only through `scripts/deploy-local.sh`, run by the main session.

## Tests and checks

- Run quiet. Targeted first (`node --test test/<file>.test.ts` from `packages/bridge`), then the full suite once. Print failures only.
- One heavy test run at a time. Check the load before starting a second one.
- Before handing back: `yarn lint`, `yarn typecheck`, `yarn format:check`, `yarn test`.
- The `/api/board` goldens live in `packages/bridge/test/fixtures/board-worlds/golden/`. A change that should alter the board rewrites them with `UPDATE_SNAPSHOTS=1 node --test test/board-snapshot.test.ts`. Review the diff.

## Browsers

- Never open a browser or drive one.

## Structure

- The layer rules live in `eslint.boundaries.mjs` (branch stack/48). Do not work around them. Change the rule file if a layer really has to move.
- Prefer codemods for moves and renames: `git mv` plus ts-morph or sed, then check the diff is only the move.

## Reporting

- Post progress beats with `~/Configuration/scripts/beat.sh <name> <N>/<M> <step> "<few words>"`.
- Ledger lines are the main session's job. Do not write to the ledger.
- Keep the final report short: what changed, the checks you ran, anything left open.
