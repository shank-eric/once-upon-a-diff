# ADR-17: A host-github package, and the end of `shared`

Decided 11/3. Follows ADR-15 and ADR-16, which left `packages/shared` as the place for everything the apps, the panel and the bridge had in common and listed "domain helpers" and `ui` as deferred.

Since 11/5, `packages/host-github` is `packages/github-page` (3a849e9), named for what it does: it reads GitHub's diff page and routes its URLs. `packages/protocol` is `packages/contracts` and its `domain/` folder has been the `packages/domain` package since 11/4, so the `protocol/src/domain/` below is `packages/domain/src/`. `ui` is `ui-kit` and `eslint.boundaries.mjs` is gone ([ADR-22](adr-22-dependency-cruiser-one-home-for-layer-rules.md)). **Superseded in part:** the domain became a package on 11/4, which this ADR's options table rejects (see [ADR-15](adr-15-layered-packages-and-protocol.md)). The text below keeps the names of 11/3, with the new one beside the first use.

## Context

`shared` held three kinds of thing under one name: pure helpers the server also needs (`html`, text, time, PR keys), browser helpers (`dom`, `clipboard`), and the GitHub host adapter (`host/diff-dom.ts`, with GitHub's URL routing in `github-paths.ts`). The lint rules for `shared` were the loosest common denominator, and a reader looking for where GitHub's markup is handled had to know it sat under `shared/src/host`. ADR-15's rule is a package only for its own runtime, its own dependencies or an outside consumer.

## Decision

`shared` is gone. Each piece went where its layer says:

- **`packages/host-github`** (`packages/github-page` since 11/5) is the one new package: `diff-dom.ts` (the diff-page reader, GitHub's `/changes` and `/files`, also used by the local page) and `pages.ts` (what a github.com path says about the page). It has its own runtime (GitHub's DOM, a tsconfig with the DOM lib that the protocol must not have) and two consumers, the extension and the local page. It implements the panel's port (`panel/src/host/host.ts`, `panel/src/host/diff-types.ts`), so it imports those and the protocol, never the panel's `overlay.ts` or a region. The panel, the protocol and the server never import it.
- **`protocol/src/domain/`** (`packages/domain/src/` since 11/4) takes what is pure and what the server also reads: `html`, `text`, `time`, `choice`, `line-refs`, `bridge-port`, `pr-key` (PR keys and the commit range in a diff URL), and `chapters` (a chapter's key, where each file is finished, the chapter numbers). They import nothing. Two took a structural type in place of a wire type to stay that way: `gateText` reads `{ name, gate }`, and `Side` is defined in the domain and re-exported by `types.ts`. The bridge serves the whole folder to the pages.
- **`packages/panel`** takes what only the panel's side needs: `dom.ts` and `clipboard.ts` (the extension and the local page import them from the panel, which the layering allows for apps), `diff-types.ts` (the panel owns the port the host adapter implements) and `story-model.ts` (`createStoryModel`, which needs `StoryData`, so it can't be in the domain).
- **`packages/web/public/board/`** takes the board-only view helpers: `worktree-text.ts` (beside `shared.ts`, below the regions), `columns/story-answers.ts` and `backlog/started-chips.ts`.
- `eslint.boundaries.mjs` had a `host-github` layer in place of the three `shared` ones, and `bridge/test/boundary-lint.test.ts` probed it (both superseded 11/4: the layer is a dependency-cruiser rule now, `github-page-implements-the-panel-port`, ADR-22). `packages/bridge/test/no-shared.test.ts` fails if `packages/shared` or any import of it comes back.
- `bridge/src/server/assets.ts` (`packages/server/src/assets.ts` since 11/5) rewrites `@once-upon-a-diff/{panel,protocol,host-github}/…` to `/assets/<package>/…` URLs, and serves `/assets/host-github/*` and every module under `/assets/protocol/domain/`. The old `/assets/util/` and `/assets/host/` URLs are gone. Since the renames the URLs are `/assets/github-page/*`, `/assets/domain/*` and `/assets/contracts/*`.

### Options considered

| Option | Why not chosen |
|---|---|
| Promote the domain to its own package | Nothing needs its own manifest: it has no runtime or dependency of its own, and the folder plus its lint rule (imports nothing) already hold the line. **Reversed 11/4:** the domain became `packages/domain` by Eric's decision, because the contracts package imports it and it imports nothing (ADR-15). |
| A `ui` package for `dom` and `clipboard` | 66 lines and no components yet. They move there when `ui` has a second kind of thing in it (ADR-16). Done on 11/4: `ui` (now `ui-kit`) exists (ADR-15) and both moved into it. |
| `rangeOfPath` as a `commitRange()` on `PanelHost` | It would change the panel's port and both hosts. It stays in the domain as a pure path rule the panel reads. |

## Consequences

- A change in GitHub's markup or URLs touches `packages/github-page`. A pure helper has one home the server, the pages and the panel all import.
- ADR-15's open question 4 is answered for these helpers. The ledger-line parsing and the board's column rules are still in the bridge.
- The extension's tag UI imported the DOM helpers from the panel package. That oddity ended on 11/4: they are in `ui` (`ui-kit`).
- Every import of a moved helper changed, so branches in flight that touch those lines rebase over this one.
