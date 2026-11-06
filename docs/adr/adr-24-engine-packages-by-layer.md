# ADR-24: The engine splits into seven packages by layer: adapters, foundation, stories, usage, state, core and board

Decided 11/5 by Eric. Built in the commit that adds this file (11/5), and descriptive of the code on main at that commit. It supersedes parts of [ADR-20](adr-20-core-server-cli-split.md) (what `packages/core` holds and what imports what) and of [ADR-21](adr-21-core-tiers-and-their-rules.md) (the five tiers as folders of one package). What it leaves alone is below, under Supersedes. The lint that holds all of it is [ADR-22](adr-22-dependency-cruiser-one-home-for-layer-rules.md).

## Context

ADR-20 and ADR-21 put the adapters and five tiers of services in one package, `core`, about 23,000 lines. The tier order held, but the folder order was the only boundary: nothing separated the pieces that are large and have few readers (the agent board, 3.5k lines, which only the HTTP app needs; the story files, 3.7k, which both apps use; the usage capture, 1.8k, which is dev instrumentation) from the rest. The CLI imported the whole board (one of its commands printed the board's link), and a change anywhere in `core` was a change to a package every app depends on. Eric wanted these split out as packages, bottom-up, with the order between them something the lint enforces.

The package rule of ADR-15 (a package only for its own runtime, dependencies or an outside consumer) is not met by the new packages: they share Node 24 and the one process. Like `ui-kit` and the three of ADR-20, they are packages for tidiness and for the lint, by decision.

## Decision

Seven packages replace the one. Bottom to top (`configs/layers.mjs` is the one list), a package imports only the packages above it in this table (`usage` is outside the order, see below):

| Package | Holds | Imports |
|---|---|---|
| `adapters` | every side effect, one module per outside system: files and locks (`stores/`), git, gh, the shell (`os.ts`), iTerm, Larmor, Claude's own files (`claude-sessions/`), `bridge-health.ts`, `heavy-lock.ts` (the heavy-run lock) | contracts, domain |
| `foundation` | settings, the repo list, ids, errors, input checks, `shared-files.ts`, `node-version.mjs` | adapters |
| `stories` | what a story is on disk: placement, reads, validation, rebuilds, local stories, the push default | adapters, foundation |
| `state` | what is stored and the work waiting on it, in two tiers: `records/` (agents, github, listeners, page-links, worktrees) under `queues/` (requests, backlog) | adapters, foundation, stories |
| `core` | what the reviewer does with it, in two tiers: `features/` (heavy, listeners, publishing, review, sessions) under `orchestration/` (`bridge/`: serve, `setBridgeFactory`, `doctor.ts`) | adapters, foundation, stories, state |
| `board` | the agent board's data: `board.ts`, the columns, `stages/`, `agent-home.ts`, `voice.ts` | everything above |
| `usage` | the usage capture of ADR-18: counters, the report, coverage; its own `src/adapters/` folder holds the files that touch the inspector and the usage files | adapters, foundation |

`usage` sits beside the stack, not in it: nothing in the engine imports it. The CLI and the HTTP app do (`cli-log` and the `usage` command, `UsageCounters` and the capture hooks), and so do the shell's entry shims and instrumentation. `server` and `cli` import every package but `adapters` by name (`@once-upon-a-diff/stories/store`, `@once-upon-a-diff/state/queues/requests/builds`), and only `server` imports `board`.

Why each is where it is:

- **`foundation` is its own package.** The card that started this wanted foundation to stay in `core`. But `state`, `stories` and `usage` all import it, so it has to sit under them, and it imports adapters (`settings.ts`, `repos.ts` and `gh.ts` read and write files through them), so it cannot sit under adapters. Folding it into `adapters` would stop that package meaning "the only place that runs programs".
- **`stories` is under `state`, not over it.** Stories import nothing from state, only adapters and foundation. State's request queue imports five things from stories (`isRebuild`, `REBUILD_MODES`, and the `StoryMeta`, `ServedStory` and `StoryStore` types). Putting stories over state would mean moving those down into state, so a story's own types would live in the wrong package.
- **`usage` is beside the stack.** It imports adapters and foundation only, and its two side-effect files (the session that starts the inspector, and the usage file store) moved out of `adapters/` into `usage/src/adapters/`, because nothing else uses them. `session.ts` imports nothing from this repo: the shell preloads it before any other module loads.
- **`board` is its own package** so that only the server imports it: no `cli`, `core` or other engine file does. The shell (`bin/once-upon.ts`) imports `server/index`, which imports the board, so a CLI run still loads it through the server; loading the server lazily is not done here. The `once-upon board` command is gone: the board page is reached from the extension's Open board button, and a page opened without a key says so and to start the server with `once-upon serve`. Nothing prints a board link with a key now.
- **No separate definitions and implementation packages.** Every service has one implementation. A fake store may get its own package later.

## Rules

All in `configs/.dependency-cruiser.mjs`, generated from `configs/layers.mjs` where a list is involved, each with a probe in `packages/bridge/test/layer-rules.test.ts`:

1. **`adapters-are-bottom` and `<package>-imports-only-below`:** a package imports only the packages under it.
2. **`state-records-below`, `core-features-below` and the two `-tier-siblings-apart` rules:** the tiers that survive inside `state` and `core` keep ADR-21's rule: a tier imports only the tiers under it, and folders in one tier never import each other. `foundation`, `stories`, `usage` and `board` have no tiers, so their files may import each other.
3. **`usage-for-apps-only`, `usage-imports-only-the-floor`, `usage-adapters-are-bottom`:** only the apps and the shell import usage; usage imports adapters and foundation; usage's own adapters folder imports no other usage file.
4. **`board-is-the-servers`:** only `server` imports `board`.
5. **`listening-through-service`**, repointed: the CLI, the HTTP app, the board and `core/orchestration` import `features/listeners/service.ts`, not the listener files behind it (`state/records/listeners/` and the rest of `core/features/listeners/`).
6. **The side-effect rules** (`only-adapters-run-programs-or-network*`, and ESLint's block for each package): every engine package but `adapters`, and `usage` but for its `adapters/` folder, runs no program and reaches no network.
7. **The CLI never calls the server** (ADR-15) holds as before. `cli-never-calls-server.test.ts` scans `cli`, every engine package the CLI process can load (`adapters`, `foundation`, `stories`, `usage`, `state`, `core`) and the shell's `bin` and `instrumentation`; `board` is not scanned because `board-is-the-servers` keeps `cli` and the engine from importing it; the shell does load it, through the server, which the scan does not cover either. The health check is still the doctor's alone (`health-check-is-the-doctors`).

`packages/bridge/test/package-layout.test.ts` pins which folders each package holds, and that the package list in `layers.mjs` is the list of folders under `packages/` that are engine packages.

## Consequences

- Old paths. `packages/core/src/adapters/` is `packages/adapters/src/`; `core/src/foundation/` is `foundation/src/`; `core/src/records/stories/` is `stories/src/`; `core/src/records/usage/` is `usage/src/`, plus `core/src/adapters/usage/session.ts` and `core/src/adapters/stores/usage-file.ts`, which are `usage/src/adapters/session.ts` and `usage-file.ts`; `core/src/records/` (the rest) and `core/src/queues/` are `state/src/records/` and `state/src/queues/`; `core/src/orchestration/board/` is `board/src/`. `core/src/features/` and `core/src/orchestration/bridge/` stay. Older ADRs and notes name the old paths.
- Each package's `exports` is `./*` (to `src/*.ts`); `state` also exports `./test/*` for the helper that registers agent runs. Narrowing them is still open.
- The usage report keys coverage by file path (ADR-18): a moved file starts its history again, and its scope list and area table name the new packages.
- Tests follow what they import: five in `adapters`, two in `foundation`, six in `stories`, three in `usage`, six in `state` (and `test/helpers.ts`), six in `board`, four left in `core`; the integration tests, and the architecture tests, stay in the shell.
- `once-upon board` is removed, with its tests, its usage-area row and `pageOrigin`.
- `node-version.mjs` is `foundation/src/node-version.mjs`: every package's `test` script, `bin/once-upon.mjs` and the skill's `story.mjs` name it there.
- A deploy needs `yarn install` on main before any `once-upon` command works again, since the new packages are linked by it.

## Supersedes

- **ADR-20, in part:** "Four packages, not three" and what `core` holds (`src/adapters/` and five tiers), "What imports what" (the apps import core by name, now each package by its own name, never `adapters`), the file counts under "Tests follow what they drive", and the location of `node-version.mjs`. ADR-20 keeps the shell staying in `bridge`, the apps staying apart, and its open questions.
- **ADR-21, in part:** the five-tier table and its rule 1 ("a tier imports only its own folder, a lower tier or `adapters/`"). `foundation`, `records` (less stories and usage) and `queues`, and the board half of `orchestration`, are packages now, and the order between them is the package order. Rule 2 (folders in one tier never import each other) stays, inside `state` and `core`. `configs/core-tiers.mjs` is `configs/layers.mjs`, and `core-layout.test.ts` is `package-layout.test.ts`.

## Open questions

- Making usage loaded by the shell and tests only, by handing the CLI its command and the server its counters from `bin/once-upon.ts`, so that `cli` and `server` stop importing it.
- Narrowing each package's `exports` to the folders an app may use.
- `core/src/orchestration/` holds one folder (`bridge/`) now: flatten it, or keep the tier for what may join it.
