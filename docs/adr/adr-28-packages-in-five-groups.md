# ADR-28: Packages sit in five folders, and `domain` is `terms`

Decided 11/6 (card bl_mw58benh117d5a, plan and plan check in `notes/` for `package-regroup`), built in the commit that adds this file, and descriptive of the code on main at that commit. It changes where every package lives and what two of them are called. It changes no behavior: the move is `git mv` plus one rewrite of the path strings.

## Context

`packages/` held 19 packages side by side. Which of them were the server's, the browser's or both's was a fact in `configs/layers.mjs`, `configs/.dependency-cruiser.mjs` and a reader's head, and the folder listing said none of it. The two lib stacks (the engine, and the client's shared packages) sat between the apps with nothing to show which side they were on. The bridge, which is a shell over the server's apps, sat in a list with the browser's packages. `domain` was a floor everything imported, but it was named for a word that also means the engine.

## Decision

- **Five folders, `packages/<group>/<name>`.** `configs/layers.mjs` `GROUPS` is the one list; `package-layout.test.ts` and the dependency-cruiser rules read it.
  - `server`: `server` (the HTTP app), `cli`, `bridge` (the shell).
  - `server-libs`: `adapters`, `foundation`, `stories`, `state`, `core`, `board`, `usage` (the engine, and usage beside it).
  - `client`: `panel`, `extension`, `web`, `github-page`.
  - `client-libs`: `bridge-client`, `ui-kit`.
  - `domain`: `contracts`, `terms`, `test-kit`.
- **`domain` the package is `terms`** (`@once-upon-a-diff/terms`, at `packages/domain/terms`), served at `/assets/terms/` (it was `/assets/domain/`). `domain` is now the folder that holds it, the contracts and the test kit: the floor under both sides. Only the name moves; the pure rules, the one-module-per-area layout and the "imports nothing" rule do not.
- **The test kit lives in `domain/`.** It is dev-only and imports Node and linkedom only, so it sits under both sides and is the one package of the floor the dependency rules still keep out of shipped code (`shipped-code-not-the-test-kit`).
- **The shell is a server package.** `bridge` (`bin/once-upon.ts`, the usage probe and the integration tests) is the one place that knows both apps, so it goes with the server's apps. Its integration tests import the panel, the pages and the extension, as they did: the rules below run over each package's shipped folders (`src/`, `bin/`, `public/`), not its tests, so tests are exempt (`domain/contracts`'s schema test likewise reads a type from `server-libs/state`).
- **The rules, in `configs/.dependency-cruiser.mjs`**, four new ones over the five folders, beside the ones that already name packages:
  - `domain-is-the-floor`: `packages/domain` imports nothing of the other four folders (its own folder and npm only).
  - `client-side-not-server-side` and `server-side-not-client-side`: the client side (`client`, `client-libs`) and the server side (`server`, `server-libs`) never import each other. They meet at the contracts package. The bridge serves client files by name (`import.meta.resolve` in `server/src/assets.ts`), which is a serving dependency, not an import, and the rules do not see it.
  - `libs-not-apps`: a libs folder imports nothing in its own side's apps folder, but the vendored Preact (`client/web/public/vendor/preact.mjs`), which the pages serve and `ui-kit` loads.
  - The older rules (the engine's order, the tiers, `contracts-is-bottom`, `terms-imports-nothing` (was `domain-imports-nothing`), the page and extension apps, the host-free panel) keep their names and meaning with the new paths. `packages/server/bridge/test/layer-rules.test.ts` probes every one, and works out the group rules a probe also trips from `GROUPS`, so the probes do not repeat them.
- **Layout test.** `package-layout.test.ts` pins five folders, that every `GROUPS` package has a folder and a manifest named `@once-upon-a-diff/<name>` (`bridge` is `once-upon-a-diff`), and that the `depcruise` script lists every package's `src`.
- **Workspaces** are `packages/*/*`. The CLI's bin is `packages/server/bridge/bin/once-upon.mjs`; the extension builds to `packages/client/extension/.output/chrome-mv3`.

## Consequences

- **Old paths.** Anything that names the old layout needs the new one:
  - A path: `packages/<name>` is `packages/<group>/<name>`, by the table below; `packages/domain/src/` is `packages/domain/terms/src/`. Historical ADRs (01 to 27) keep the paths they were written with, and their `file:line` references are updated.
  - The bin: `once-upon` is linked from `packages/server/bridge`. Run `scripts/install-cli.sh` after the deploy.
  - The extension: load `packages/client/extension/.output/chrome-mv3` (it was `packages/extension/.output/chrome-mv3`).
  - A page or module that named `/assets/domain/...` names `/assets/terms/...`; a package that named `@once-upon-a-diff/domain/...` names `@once-upon-a-diff/terms/...`.
  - The bridge's usage coverage (ADR-18) is keyed by path, so the numbers restart under the new paths once.
- **A deploy past this commit** moves the checkout's `bridge` directory. `scripts/deploy-local.sh` finds the bridge with `bridge_dir()` (the new path, or `packages/bridge` on a checkout from before this commit, so a rollback works) and the vendored Preact the same way. The first deploy runs the new script from the worktree, since the running script is the old one.
- **A new package** is a line in `GROUPS` (and `PACKAGES` or `TIERS` if it is an engine package), a folder under its group, and a probe in `layer-rules.test.ts`.

## The move

| Old | New |
| --- | --- |
| `packages/server` | `packages/server/server` |
| `packages/cli` | `packages/server/cli` |
| `packages/bridge` | `packages/server/bridge` |
| `packages/adapters` | `packages/server-libs/adapters` |
| `packages/foundation` | `packages/server-libs/foundation` |
| `packages/stories` | `packages/server-libs/stories` |
| `packages/state` | `packages/server-libs/state` |
| `packages/core` | `packages/server-libs/core` |
| `packages/board` | `packages/server-libs/board` |
| `packages/usage` | `packages/server-libs/usage` |
| `packages/panel` | `packages/client/panel` |
| `packages/extension` | `packages/client/extension` |
| `packages/web` | `packages/client/web` |
| `packages/github-page` | `packages/client/github-page` |
| `packages/bridge-client` | `packages/client-libs/bridge-client` |
| `packages/ui-kit` | `packages/client-libs/ui-kit` |
| `packages/contracts` | `packages/domain/contracts` |
| `packages/domain` | `packages/domain/terms` (`@once-upon-a-diff/domain` is `@once-upon-a-diff/terms`) |
| `packages/test-kit` | `packages/domain/test-kit` |

## Not changed

- **No package changed what it holds or imports.** The engine's order and tiers, the apps' rules, the pages' regions and the contracts package are as ADR-24 and ADR-26 left them.
- **The CLI link and the live bridge are not touched by the move.** `install-cli.sh` and the extension's folder are the main session's and Eric's steps after the deploy.
