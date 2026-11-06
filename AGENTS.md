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

- Run quiet. Targeted first (`node --test test/<file>.test.ts` from the package that holds the test: `packages/core`, `cli` or `server` for the pure ones, `packages/bridge` for the ones that start a bridge or run the CLI (`startBridge`, `runCli` and the fixtures live there), then the full suite once. Print failures only.
- One heavy test run at a time. Check the load before starting a second one.
- Before handing back: `yarn lint`, `yarn typecheck`, `yarn format:check`, `yarn test`.
- The `/api/board` goldens live in `packages/bridge/test/fixtures/board-worlds/golden/`. A change that should alter the board rewrites them with `UPDATE_SNAPSHOTS=1 node --test test/board-snapshot.test.ts`. Review the diff.

## Browsers

- `yarn test:extension` is fine: it runs headless in a throwaway profile against its own bridge and a fake `gh`, never port 4823 or Eric's GitHub login. It does read public github.com, logged out: a PR of Eric's (`shank-eric/inbox-in-gmail#91`, and `#92` as the PR with no story; `--pr` and `--no-story-pr` pick others), so it needs the network. Treat it as a heavy run (one at a time), through `~/Configuration/scripts/heavy.sh`.
- It ends its checks with pixel checks (`test/browser/pixels.ts`): 14 screenshots (the panel on the PR page, the local page, its Q&A and error state, the board, a toast and a story tag, each in light and dark) compared with the PNGs in `packages/bridge/test/browser/pixels/<platform>/`, strictly (a near-miss color fails). A miss writes `packages/bridge/test-results/pixel-diff/<name>-actual.png` and `-diff.png`. A change that should alter the look rewrites the baselines with `UPDATE_SNAPSHOTS=1 yarn test:extension`: review the PNG diff. A platform with no baseline folder skips the step with a `SKIP pixels` line.
- Claude in Chrome may be used to look at the board or a page, as long as Eric keeps control of his browser: open your own new tab and work only there, never touch his tabs, never resize or focus windows, never trigger dialogs, and close your tab when done.

## Structure

- `configs/.dependency-cruiser.mjs` is the one home for which package, layer or region may import which, and for import cycles (`yarn depcruise`, run by `yarn lint`). Do not work around it: if a layer really has to move, change its rules there. ESLint (`eslint.config.mjs`) keeps style and `eslint.side-effects.mjs`, the rules that only adapters run programs, write files or reach the network.
- The server side is four packages. `packages/core` is the adapters and, over them, the services in five tiers (`src/foundation`, `records`, `queues`, `features`, `orchestration`, bottom to top). `packages/server` (the HTTP app, with `routes/`) and `packages/cli` (the `once-upon` commands) are apps over core, apart from each other. `packages/bridge` is the shell: `bin/once-upon.ts` is the one file that knows both apps, beside the usage probe (`instrumentation/`) and the integration tests. A tier imports only the tiers under it, and folders in one tier never import each other (what two need moves down a tier); the apps import core by its package name (`@once-upon-a-diff/core/records/stories/meta`), never `core/src/adapters`. The tiers are in `configs/core-tiers.mjs` and `packages/core/test/core-layout.test.ts` pins the folders. Only an adapter runs a program, writes a file or reaches the network: add a function to `packages/core/src/adapters/` (`os.ts`, `git.ts`, `stores/fs/files.ts`...) instead of calling `child_process`, `node:fs` writes or `fetch` from a tier, a route or a command.
- The client has packages too: `packages/bridge-client` (the typed client over a host's transport, and the poll: `createPoll`, and `usePoll`, its Preact hook, which only a page loads (the panel, the extension and the local page's timers use `createPoll` directly, so no one hand-rolls a poll loop; `createPoll` takes `everyMs` as a number or a function and `whenHidden` for a keepalive); it sits over the contracts package and under the panel and the pages), `packages/panel` (the story panel, host-agnostic; `src/` has the regions `ask`, `drafts`, `fixes`, `reading`, `rebuild` beside `host/` (the port: `host.ts`, `diff-types.ts`, the context, the bridge options), `state/`, `shell/` (the overlay), `components/` and `css/`; it draws with the vendored Preact, named `/assets/preact.mjs`, which the bridge serves and the extension's Vite config aliases to the same file), `packages/ui-kit` (what the board, the local page, the panel and the extension share: `src/components/` holds the generic Preact components with no region state (`Busy`, `LinkButton`, `Banner`, `Chip`, `Meter`, `Elapsed`, `CopyButton`, `Dialog`, `PartsStrip`) and `src/css/ui.css` their stylesheet, which the pages link before `page.css` and their own sheets; the DOM and clipboard helpers, Start listening, the popover menu and `parseMarkup` sit beside them in `src/`; time text and the markdown renderer are pure, so they live in the domain (`time.ts`, `html.ts`); it imports the contracts package, the domain and the vendored `/assets/preact.mjs` only, never a region, a host adapter, an app or the bridge-client; the pages load it at `/assets/ui-kit/`, the extension by package name, so there is one Preact), `packages/github-page` (GitHub's diff-page reader and URL routing, which the apps inject into the panel), `packages/web` (the board and local pages; the board's regions are `public/board/<region>/`) and `packages/extension` (GitHub's host adapter wiring). The pure helpers the server, the pages, the panel and the extension share are in `packages/domain` (`@once-upon-a-diff/domain`, imports nothing, not even the contracts package: the contracts package imports it; pages load it at `/assets/domain/`, everything else by package name). There is no `shared` package. A region imports no other region. The panel gets its host adapters injected (`panel/src/host/host.ts`) and never imports them.
- `packages/test-kit` holds the dev-only test helpers every package's tests share (`files`: `tmp`, `writeJson`; `git`: `git`, `localRepo`, `worktreeFixture`; `stories`: `githubStory`; `dom`: `installDom`; `env`: the isolation env a test of the bridge's files imports first). Add a helper there when a second package's tests need it. A package lists it under `devDependencies` only, and nothing that ships imports it (the layer rules refuse). The bridge-coupled helpers (`startBridge`, `runCli`) stay in `packages/bridge/test/helpers.ts`, which re-exports the kit's.
- Prefer codemods for moves and renames: `git mv` plus ts-morph or sed, then check the diff is only the move.

## Reporting

- Post progress beats with `~/Configuration/scripts/beat.sh <name> <N>/<M> <step> "<few words>"`.
- Ledger lines are the main session's job. Do not write to the ledger.
- Pass long text to once-upon with `--<flag>-file PATH` or `--<flag> -` (stdin), never as one long argument: a watchdog on this Mac kills node when a single argument passes about 1,000 bytes.
- Keep the final report short: what changed, the checks you ran, anything left open.
