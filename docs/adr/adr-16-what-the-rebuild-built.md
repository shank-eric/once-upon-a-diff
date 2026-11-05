# ADR-16: What the rebuild built under ADR-14 and ADR-15, and what it left

Decided 10/29. Descriptive, of the code on main at 0741c6c. ADR-14 and ADR-15 chose the direction. This records what was built from them, where it differs from the plan, and what was deferred on purpose. It is a record of 10/29, so it keeps that day's layout. Since 11/5 the names are: `protocol` is `contracts`, `api-client` is `bridge-client`, `ui` is `ui-kit`, `host-github` is `github-page`, and the bridge's four layers are packages ([ADR-20](adr-20-core-server-cli-split.md), tiers in [ADR-21](adr-21-core-tiers-and-their-rules.md)). Each place below says so where it matters.

## Context

The worry behind both ADRs was tracing: "I don't feel like I can easily trace it." The rebuild ran as four branches, each reviewed by a fresh agent and deployed by fast-forward before the next started. This ADR is the one place that lists the result, so the other ADRs can stay about their decisions.

## Decision

What exists now:

- **`packages/protocol`** (now `packages/contracts`, ADR-15): wire types, the route table of 57 calls (64 by 11/4), a Valibot schema for each body, a transport-injected client, and `src/domain/` with the id patterns. The bridge registers its handlers from the table and checks bodies against the schemas. The extension's service worker forwards only the routes the extension calls.
- **The bridge in four layers** (`packages/bridge/src` on 10/29; since 11/5 `packages/server`, `packages/cli` and `packages/core`, whose services are in five tiers: ADR-20, ADR-21): `server/` (HTTP, with `routes/`) and `cli/` are apps over `services/`, which sit over `adapters/`. Only an adapter writes a file, runs a program or reaches the network: `github.ts`, `git.ts`, `iterm.ts`, `larmor.ts`, `os.ts`, `claude-sessions/` and `stores/` (atomic JSON, appends, the backlog, the ledger tails). `bin/once-upon.ts` is the one place that knows both apps: it hands the server's factory to `setBridgeFactory`, so the CLI never imports the HTTP app. `types.ts` is split three ways (`services/stories/`, `server/`, `cli/`).
- **Sessions outside Board.** `services/sessions/sessions.ts` holds the live registry, focus, typing and the listen offers. It asks the board for the snapshot, the last listening input and invalidation through a `SessionsFeed` interface, so it imports nothing from `Board`. The board's routes call `app.sessions`. `Board` keeps one-line delegates (`storyListenSessions`, `type`), which the story routes (`packages/server/src/routes/story.ts:205` (`app.board.storyListenSessions(story.id)`) and `packages/server/src/routes/story.ts:216` (`app.board.type('listen'`), the local page's Start listening) and `board.test.ts` still use.
- **`packages/panel`**: the story panel with no host in it. `overlay.ts` composes it, and each app hands it a `PanelHost` (`src/host/host.ts`: the diff-page adapter and the bridge client). Its regions are folders: `ask`, `drafts`, `fixes`, `reading`, `rebuild`.
- **`packages/web`**: the board and local pages, moved out of the bridge with the same URLs. The board's regions are folders under `public/board/`: `header`, `columns`, `backlog`, `worktrees`, `voice`, with `shared.ts` for what two regions use. The bridge's `server/assets.ts` (`packages/server/src/assets.ts` since 11/5) serves from web, panel and `shared`, and rewrites package specifiers to `/assets/` URLs. `test/assets-graph.test.ts` walks every import from the two page scripts so a bare specifier can't reach a browser.
- **The GitHub DOM reader, first in `packages/shared/src/host/diff-dom.ts`, then in `packages/host-github` (ADR-17), and since 11/5 in `packages/github-page`.** The plan put it in the extension. The local page's diff view has `/changes`' DOM shapes and needs the same reader, and `web` can't import the extension. Both apps inject it into the panel, and the panel never imports it. The pure story model moved to `shared/src/util/story-model.ts` (since split, ADR-17) for the same reason: the server may not import the panel.
- **The whole board page in Preact** (ADR-14): one tree in `#ou-board-app`, with the voice panel inside it. Regions can't import each other, so the columns get the Backlog card and its Add controls as props from the page (`renderCard` and `slots.backlog`). `board.ts` is a transport, the poll and a root component. Before the old code went, the old and the new page were rendered from the four board-world goldens and gave the same DOM apart from whitespace and attribute order. `packages/web/test/board-page.test.ts` keeps the page's flows under test.
- **Boundary lint** (`eslint.boundaries.mjs`; superseded 11/4, when dependency-cruiser became the one home for layer rules, [ADR-22](adr-22-dependency-cruiser-one-home-for-layer-rules.md)): one table of layers, each named once. It covers the bridge's four layers, the pages, the board and panel regions, `host-github`, protocol, and Node built-ins in browser code. `test/boundary-lint.test.ts` probes each rule with a violating file. It runs in the pre-commit hook and in CI.
- **Process.** `AGENTS.md` holds the standing rules for any agent (no push, one commit per branch, never restart the live bridge, run the checks). `.github/workflows/ci.yml` runs install, lint, typecheck, format check, tests and the extension build on every push and pull request. `scripts/deploy-local.sh` takes `--yes <branch-or-sha>` and fast-forwards main with no gates, refusing unless the target descends from the live HEAD and the checkout is clean. `--batch <base> <sha>...` cherry-picks onto the base in one reusable worktree and runs the gates. A failure after main is switched puts the previous commit back, and the check afterwards compares the served vendor files with their `.sha256`. The `/api/board` goldens in `packages/bridge/test/fixtures/board-worlds/golden/` are a committed test that proves a refactor left the board's data alone.

### Deferred on purpose

| Left | Why | What it would take |
|---|---|---|
| **The panel's Preact conversion** | The panel is about 5,900 lines with 48 `innerHTML` and `setHtml` uses, and it lives in GitHub's page, where a wrong render is hard to see. The board is where the pain was. | Started 11/3: the frame, the body, the file list and the viewed, change and working marks draw with Preact, proven by DOM goldens recorded from the string panel (`panel/test/panel-dom.test.ts`). The Ask dock, the status light, the drafts, the fixes, the working banner, the freshness line and the rebuild box followed, so the panel is all Preact. Checked by hand on a GitHub PR and a local story. |
| **A `board-core` package** | `services/board` imports about thirty modules from eight other services and nine adapters by path. A package would need a ports object that the bridge passes in for each. | Define the ports (config, stories, inbox, listeners, review, sessions, backlog, worktrees, voice, and the adapters), then move it. Only the apps import `services/board` today, so the folder and its lint rule already hold the line. |
| **The `web` and `bridge` workspace cycle** | The bridge resolves web's files to serve them, and web's tests import the bridge's test helpers. Yarn allows it. | Done: the helpers moved to `test-kit`, and web's two startBridge tests moved into the bridge, so web has no dependency on the bridge. |
| **`ui` and `api-client` packages** (`ui-kit` and `bridge-client` since 11/5) | Neither has a second consumer yet. The pages use the protocol's `client.ts`, and the panel is the only code with shared components. | Make them when the panel's conversion gives `ui` its components, and when a poll hook is shared. `api-client` was made on 11/3 (ADR-15), with `client.ts` and the poll. `ui` was made on 11/4 (ADR-15), with `dom`, `clipboard` and Start listening. |
| **Domain helpers** | Only the id patterns are in `protocol/src/domain/`. Time, `gateText`, ledger parsing and the column rules all need types the domain would then own. | One at a time, with their types. Most moved on 11/3 (ADR-17), and the domain has 13 modules on 11/4. Ledger parsing and the column rules are still in the bridge. |

### What a reader should know about the move

- Agent reviews found things the plan didn't have, and they were fixed before deploy: the lint missed several write and load routes (`promises`, `createRequire`, `globalThis.fetch`), and `deploy-local.sh` still read the old vendor folder, so it skipped its served-file check.
- The Preact board page was checked by rendering, not by a browser. The first load in Chrome under the pages' policy, and the by-eye checks for dragging, focus and the voice panel, are Eric's.

## Consequences

- A change has one obvious place. A side effect goes in an adapter, a rule in a service, a route in the table, a board region in its folder, and the lint says so when it isn't.
- A page or the panel can't reach the server, and the server can't reach a page, except through the protocol.
- The bridge has one runtime dependency (Valibot), and the extension and pages have none of it.
- More manifests, more lint rules to keep right, and each route touches `protocol`. That is the cost ADR-15 accepted.
- Until the panel converts, two idioms live in the client: components on the board page and the panel's frame and body, strings in the rest of the panel, the local page and the extension's tags.
- `Board` still has delegates to `Sessions`, and the story routes still call them (`packages/server/src/routes/story.ts:205` (`app.board.storyListenSessions(story.id)`), checked 11/5). Pointing those routes at `app.sessions` would end the panel's run-time dependency on the board object.

## Open questions

1. Which panel region converts first: `ask` (the most state), or `drafts`? Answered 11/3: neither. The frame and the body went first, because the regions draw into the body's slots and need a Preact parent. The ask dock is the one region outside the body and can go at any point.
2. Is `board-core` worth its ports, or does the folder and its lint rule do enough?
3. Should CI also run the extension's browser tests? It runs none today, because they need Playwright's Chromium.
