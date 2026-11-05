# ADR-17: A host-github package, and the end of `shared`

Decided 11/3. Follows ADR-15 and ADR-16, which left `packages/shared` as the place for everything the apps, the panel and the bridge had in common and listed "domain helpers" and `ui` as deferred.

## Context

`shared` held three kinds of thing under one name: pure helpers the server also needs (`html`, text, time, PR keys), browser helpers (`dom`, `clipboard`), and the GitHub host adapter (`host/diff-dom.ts`, with GitHub's URL routing in `github-paths.ts`). The lint rules for `shared` were the loosest common denominator, and a reader looking for where GitHub's markup is handled had to know it sat under `shared/src/host`. ADR-15's rule is a package only for its own runtime, its own dependencies or an outside consumer.

## Decision

`shared` is gone. Each piece went where its layer says:

- **`packages/host-github`** is the one new package: `diff-dom.ts` (the diff-page reader, GitHub's `/changes` and `/files`, also used by the local page) and `pages.ts` (what a github.com path says about the page). It has its own runtime (GitHub's DOM, a tsconfig with the DOM lib that the protocol must not have) and two consumers, the extension and the local page. It implements the panel's port (`panel/src/host/host.ts`, `panel/src/host/diff-types.ts`), so it imports those and the protocol, never the panel's `overlay.ts` or a region. The panel, the protocol and the server never import it.
- **`protocol/src/domain/`** takes what is pure and what the server also reads: `html`, `text`, `time`, `choice`, `line-refs`, `bridge-port`, `pr-key` (PR keys and the commit range in a diff URL), and `chapters` (a chapter's key, where each file is finished, the chapter numbers). They import nothing. Two took a structural type in place of a wire type to stay that way: `gateText` reads `{ name, gate }`, and `Side` is defined in the domain and re-exported by `types.ts`. The bridge serves the whole folder to the pages.
- **`packages/panel`** takes what only the panel's side needs: `dom.ts` and `clipboard.ts` (the extension and the local page import them from the panel, which the layering allows for apps), `diff-types.ts` (the panel owns the port the host adapter implements) and `story-model.ts` (`createStoryModel`, which needs `StoryData`, so it can't be in the domain).
- **`packages/web/public/board/`** takes the board-only view helpers: `worktree-text.ts` (beside `shared.ts`, below the regions), `columns/story-answers.ts` and `backlog/started-chips.ts`.
- `eslint.boundaries.mjs` has a `host-github` layer in place of the three `shared` ones, and `bridge/test/boundary-lint.test.ts` probes it. `bridge/test/no-shared.test.ts` fails if `packages/shared` or any import of it comes back.
- `bridge/src/server/assets.ts` rewrites `@once-upon-a-diff/{panel,protocol,host-github}/…` to `/assets/<package>/…` URLs, and serves `/assets/host-github/*` and every module under `/assets/protocol/domain/`. The old `/assets/util/` and `/assets/host/` URLs are gone.

### Options considered

| Option | Why not chosen |
|---|---|
| Promote the domain to its own package | Nothing needs its own manifest: it has no runtime or dependency of its own, and the folder plus its lint rule (imports nothing) already hold the line. |
| A `ui` package for `dom` and `clipboard` | 66 lines and no components yet. They move there when `ui` has a second kind of thing in it (ADR-16). Done on 11/4: `ui` exists (ADR-15) and both moved into it. |
| `rangeOfPath` as a `commitRange()` on `PanelHost` | It would change the panel's port and both hosts. It stays in the domain as a pure path rule the panel reads. |

## Consequences

- A change in GitHub's markup or URLs touches `packages/host-github`. A pure helper has one home the server, the pages and the panel all import.
- ADR-15's open question 4 is answered for these helpers. The ledger-line parsing and the board's column rules are still in the bridge.
- The extension's tag UI imported the DOM helpers from the panel package. That oddity ended on 11/4: they are in `ui`.
- Every import of a moved helper changed, so branches in flight that touch those lines rebase over this one.
