# ADR-20: The bridge splits into core, server and cli, and core into tiers

Descriptive, of the code on the `package-split` branch (11/5). It replaces the bridge's four-folder layout in ADR-15 (`server/` and `cli/` over `services/` over `adapters/`, all in one package). The earlier research (a core package "only when a second consumer appears") is superseded by Eric's decision of 11/4.

## Context

One package held the HTTP app, the CLI and every service, kept apart by folder rules. The rules held, but the services were a flat list of 17 folders with no direction among them: the research of 11/4 found one import cycle cluster and showed that folders fall into five levels if a few symbols and files move. Eric wanted the apps and the rules in separate packages, and the folder order to be something the lint enforces.

## Decision

- **Four packages.** `packages/core` (the adapters, and the services in five tiers), `packages/server` (the HTTP app, with `routes/`), `packages/cli` (the commands) and `packages/bridge`, which stays as the shell: `bin/once-upon.ts` is the one file that knows both apps, `instrumentation/` is the usage probe, and `test/` holds the integration tests. The shell keeps `packages/bridge/bin/once-upon.mjs` where every agent, script, skill and the deploy expect it.
- **Five tiers in core, bottom to top.** `foundation` (settings, repos, gh, ids, errors, input, the Node version check), `records` (stories, agents, github, worktrees, listeners, usage, page-links), `queues` (requests, backlog), `features` (review, sessions, publishing), `orchestration` (board, bridge). Adapters sit under all of them.
- **Two rules, in dependency-cruiser.** A tier imports only the tiers under it; folders in one tier never import each other, so what two need moves down a tier. The apps import core by package name and never `core/src/adapters`; core imports neither app nor the shell. `configs/core-tiers.mjs` lists the tiers, `packages/bridge/test/layer-rules.test.ts` probes every rule on a temp tree, and `packages/core/test/core-layout.test.ts` pins the folders.
- **Renames that came with it.** `config` is `foundation`, `ledger` is `agents`, `inbox` is `requests`, `pages` is `page-links`, `review` splits into `records/github` and `features/review`, and `voice` and `doctor` fold into `orchestration`.
- **Tests follow what they drive.** A test that starts a bridge (`startBridge`), runs the CLI (`runCli`) or drives the board stays in the shell. The pure ones moved to core, cli and server. The isolation env (the dev dir, the Claude dir, the host check) is `@once-upon-a-diff/test-kit/env`.

## Consequences

- A package's `exports` are `./*`: core's whole `src` is importable by name. The boundary that matters is the lint rule against `adapters/`, not a narrowed export list.
- The usage report keys coverage by file path: a moved file starts its history again.
- `records/listeners/listeners.ts` still computes the path of `packages/bridge/bin/once-upon.mjs` as a string, for the command it prints into listen prompts.
- A deploy needs `yarn install` on main before any `once-upon` command works again, since the new packages are linked by it.

## Open questions

- Narrowing core's `exports` to the folders an app may use.
- Grouping `.once-upon-parts.json` by tier.
