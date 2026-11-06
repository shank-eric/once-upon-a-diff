# ADR-20: The bridge splits into core, server and cli, with `bridge` left as the shell

> Superseded in part by [ADR-24](adr-24-engine-packages-by-layer.md) (11/5): what `packages/core` holds and what imports what. The rest of this ADR stands.

Decided 11/4 by Eric. Built in 168b6b1 (11/5), and descriptive of the code on main at that commit. It supersedes the bridge's four-folder layout in [ADR-15](adr-15-layered-packages-and-protocol.md) and [ADR-16](adr-16-what-the-rebuild-built.md) (`server/` and `cli/` over `services/` over `adapters/`, all in one package) and the rule there that the CLI "stays in `bridge`". The research of 11/4 (`notes/research/2026-11-04-ou-core-split.md`) recommended skipping a core package until a second consumer appeared. Eric decided otherwise, for the reasons under Context. How core is laid out inside is [ADR-21](adr-21-core-tiers-and-their-rules.md), and the lint that holds all of it is [ADR-22](adr-22-dependency-cruiser-one-home-for-layer-rules.md).

## Context

One package held the HTTP app, the CLI and every service, kept apart by folder rules. The rules held, but nothing in the layout showed where an app ended and the rules began, and the research of 11/4 found that the services fall into five levels once a few symbols and files move. Eric wanted the apps and the rules in separate packages, and the folder order to be something the lint enforces.

The package rule of ADR-15 (a package only for its own runtime, its own dependencies or an outside consumer) is not met by any of the three new ones: they share Node 24 and the one process, and services and adapters import only `node:` built-ins, `contracts` and `domain`. Like `ui-kit`, they are packages for tidiness and for the lint, by decision.

## Decision

- **Four packages, not three.** `packages/core` (`@once-upon-a-diff/core`: `src/adapters/` and, over them, the services in five tiers), `packages/server` (`@once-upon-a-diff/server`: the HTTP app, with `routes/`), `packages/cli` (`@once-upon-a-diff/cli`: the commands, with `commands/`) and `packages/bridge`, which stays and shrinks to the shell. The shell holds `bin/once-upon.mjs` and `bin/once-upon.ts`, `instrumentation/usage-probe.ts` and `test/` (integration, architecture and browser tests, fixtures and goldens). Its package name is still `once-upon-a-diff`.
- **Why the shell stays.** `bin/once-upon.ts` has to be the one file that knows both apps (`main` from `cli`, `createBridge` from `server`, `setBridgeFactory` from `core`), so it has to live in a package that depends on both. Putting it in `cli` would make `cli` know `server`; a new package would change the path `packages/bridge/bin/once-upon.mjs`, which every agent, `beat.sh`, `deploy-local.sh` (it runs from `MAIN/packages/bridge`), the skills, `cliCommand()` and the live bridge's working directory name. Keeping `packages/bridge` costs a fourth, small package and no edit outside the repo. A shim in a new package was the alternative, and was not chosen.
- **What imports what.** `core` imports `contracts` and `domain`. `server` and `cli` import `core` by package name (`@once-upon-a-diff/core/records/stories/meta`), never `core/src/adapters`, and never each other. Nothing under `core`, `server` or `cli` imports the shell. Valibot stays behind `contracts`. `bin/once-upon.mjs` reaches `requireNode` in core's `foundation/node-version.mjs` by relative path, because it runs before anything else resolves.
- **The two edges that broke the tier order went first.** `doctor.ts` imported `bin/node-version.mjs`, which moved into core (`foundation/node-version.mjs`; the other packages' `test` scripts and the skill's `story.mjs` run it from there), and `worktrees.ts` named the agent fields it reads instead of importing the registry's type.
- **Tests follow what they drive.** A test that starts a bridge (`startBridge`), runs the CLI (`runCli`) or drives the board stays in the shell: `packages/bridge/test/` has 80 files. The rest moved to `core` (32 files), `cli` (3) and `server` (2). The isolation env (the dev dir, the Claude dir, the host check) is `@once-upon-a-diff/test-kit/env`.

## Consequences

- Core's `exports` are `./*` (to `src/*.ts`) and `./test/*` (its test helpers): core's whole `src` is importable by name. The boundary that matters is the lint rule against `adapters/`, not a narrowed export list.
- The usage report keys coverage by file path (ADR-18): a moved file starts its history again.
- `records/listeners/listeners.ts` still computes the path of `packages/bridge/bin/once-upon.mjs` as a string (`'../../../../bridge/bin/once-upon.mjs'`), for the command it prints into listen prompts. It is not an import, so no lint rule sees it.
- A deploy needs `yarn install` on main before any `once-upon` command works again, since the new packages are linked by it.
- The move renamed 201 files (169 outside `test/`) and changed no behavior. Older ADRs, notes and commit messages name the old paths: `services/<name>/` is `packages/core/src/<tier>/<name>/` (ADR-21), `server/` is `packages/server/src/`, `cli/` is `packages/cli/src/`, and `adapters/` is `packages/core/src/adapters/`.

## Open questions

- Narrowing core's `exports` to the folders an app may use.
- Grouping `.once-upon-parts.json` by tier.
- Having `bin` hand its own path to core, as it does the bridge factory, so `listeners.ts` needn't compute it by string.
