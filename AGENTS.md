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
- A deploy marks a card done by the commit its agent recorded, never by a branch name: finish a card's run with `--commit <sha> --card <id>` (a fix round's new run records its new tip). `deploy-local.sh` runs `backlog land`, which prints the claimed cards it could not match, to close by hand with `backlog done <id> --sha <sha>`. A card whose work also lands outside the repo gets `backlog hold <id>` so a deploy never closes it.
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

- `configs/.dependency-cruiser.mjs` is the one home for which package, layer or region may import which, and for import cycles (`yarn depcruise`, run by `yarn lint`). Do not work around it: if a layer really has to move, change its rules there. ESLint (`eslint.config.mjs`) keeps style and `eslint.side-effects.mjs`, the rules that only adapters run programs, write files or reach the network.
- The bridge's server (`packages/bridge/src`) has four layers: `server/` (HTTP, with `routes/`) and `cli/` are apps over `services/`, which sit over `adapters/`. Only an adapter runs a program, writes a file or reaches the network: add a function to `adapters/` (`os.ts`, `git.ts`, `stores/fs/files.ts`...) instead of calling `child_process`, `node:fs` writes or `fetch` from a service, a route or a command. `bin/once-upon.ts` is the one place that knows both apps.
- The client has packages too: `packages/api-client` (the typed client over a host's transport, and the poll: `createPoll`, and `usePoll`, its Preact hook, which only a page loads (the panel keeps its own tick); it sits over the protocol and under the panel and the pages), `packages/panel` (the story panel, host-agnostic; `src/` has the regions `ask`, `drafts`, `fixes`, `reading`, `rebuild` beside `host/` (the port: `host.ts`, `diff-types.ts`, the context, the bridge options), `state/`, `shell/` (the overlay), `components/` and `css/`; it draws with the vendored Preact, named `/assets/preact.mjs`, which the bridge serves and the extension's Vite config aliases to the same file), `packages/ui` (what the board, the local page, the panel and the extension share: the DOM and clipboard helpers, Start listening, the popover menu, time text, `parseMarkup` and the markdown renderer, and generic Preact components with no region state (`Meter`, `Chip`, `CopyButton`, `Elapsed`), with their stylesheet `ui.css`, which the pages link before `local.css`; it imports the protocol, the domain and the vendored `/assets/preact.mjs` only, never a region, a host adapter, an app or the api-client; the pages load it at `/assets/ui/`, the extension by package name, so there is one Preact), `packages/host-github` (GitHub's diff-page reader and URL routing, which the apps inject into the panel), `packages/web` (the board and local pages; the board's regions are `public/board/<region>/`) and `packages/extension` (GitHub's host adapter wiring). The pure helpers the server, the pages, the panel and the extension share are in `packages/domain` (`@once-upon-a-diff/domain`, imports nothing, not even the protocol: the protocol imports it; pages load it at `/assets/domain/`, everything else by package name). There is no `shared` package. A region imports no other region. The panel gets its host adapters injected (`panel/src/host/host.ts`) and never imports them.
- `packages/test-kit` holds the dev-only test helpers every package's tests share (`files`: `tmp`, `writeJson`; `git`: `git`, `localRepo`, `worktreeFixture`; `stories`: `githubStory`; `dom`: `installDom`). Add a helper there when a second package's tests need it. A package lists it under `devDependencies` only, and nothing that ships imports it (the layer rules refuse). The bridge-coupled helpers (`startBridge`, `runCli`) stay in `packages/bridge/test/helpers.ts`, which re-exports the kit's.
- Prefer codemods for moves and renames: `git mv` plus ts-morph or sed, then check the diff is only the move.

## Reporting

- Post progress beats with `~/Configuration/scripts/beat.sh <name> <N>/<M> <step> "<few words>"`.
- Ledger lines are the main session's job. Do not write to the ledger.
- Keep the final report short: what changed, the checks you ran, anything left open.
