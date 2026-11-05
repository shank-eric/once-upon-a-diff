# ADR-21: Core's services sit in five tiers, and the folder order is the import order

Decided 11/4 by Eric, from the research of that day (`notes/research/2026-11-04-ou-services-tiers.md`). Built in 168b6b1 (11/5) together with the package split ([ADR-20](adr-20-core-server-cli-split.md)), after the import cycles were broken in dd272df, 82bc676 and a0036f5. Descriptive, of the code on main at 168b6b1. It replaces the flat `services/` list of 15 folders (14 when the research measured it) that [ADR-15](adr-15-layered-packages-and-protocol.md) and [ADR-16](adr-16-what-the-rebuild-built.md) describe, and ADR-15's rule that a service may import any other. The lint that enforces it is [ADR-22](adr-22-dependency-cruiser-one-home-for-layer-rules.md).

## Context

`services/` held 14 folders with no direction among them when the graph was measured (15 by the split, with `publishing/`), plus a few loose files. Parsing the import graph on 11/4 showed one cluster of four folders that imported each other at run time (stories, inbox, review, listeners), joined by two more through type-only imports, and one file-level cycle (`approve.ts`, `story-lists.ts`, `local-story.ts`, `push-default.ts`). Nothing else was tangled: if eight small symbols and six files moved, every folder fell into one of five levels. A reader could not say from the folder list which service might call which, and the cycles meant a change in one folder could not be reasoned about without the others.

## Decision

`packages/core/src/` holds `adapters/` (every side effect, under all the tiers) and five tiers, bottom to top:

| Tier | Holds | What belongs there |
|---|---|---|
| `foundation` | settings, repos, gh, ids, errors, input, `node-version.mjs` | the helpers every service reads: configuration, ids and patterns, the `gh` wrapper, error types and input checks. Files here may import each other |
| `records` | stories, agents, github, worktrees, listeners, usage, page-links | what is stored or known: a story and its state, the agent registry, GitHub's facts, worktrees, who listens, usage counts, page keys and links |
| `queues` | requests, backlog | work waiting for someone: the inbox, build and fix requests, and the Backlog's events |
| `features` | review, sessions, publishing | what the reviewer does with records and queues: drafts, approval, freshness, the watcher, typing into sessions, publishing a story |
| `orchestration` | board, bridge | the folders that put features together: the board (with voice) and the bridge's own start-up and `doctor` |

Two rules, and they are the whole of it:

1. **A tier imports only its own folder, a lower tier, `adapters/`, `contracts` or `domain`.** A tier never imports one above it.
2. **Folders in one tier never import each other.** What two siblings both need moves down a tier. Foundation is one unit, so rule 2 does not apply inside it.

The apps sit over all of it: `server` and `cli` import core's tiers by package name and never `adapters/` (ADR-20).

Renames and splits that made the tiers possible: `config` is `foundation` (and takes `errors.ts`, `input.ts` and the Node version check), `ledger` is `agents` (the registry; folder only, no identifier renamed), `inbox` is `requests` (`queues/requests/inbox.ts` keeps its name: it is the `inbox.jsonl` store), `pages` is `page-links`, `review` splits into `records/github` (the four files that state GitHub's facts: checks, merge rules, pending review, PR info) and `features/review` (the six files that act on them: approve, drafts, freshness, story lists, the default branch and the GitHub watcher), `voice` becomes `orchestration/board/voice.ts`, and `doctor.ts` moves in with `bridge.ts`. The symbol moves that broke the cycles (the story id pattern into the patterns, approval into its own file, `publishing/`, `binding` into listeners, `auto-stop` and `working` into the request queue) had landed before the split.

Two tests keep the folders honest beside the lint: `packages/core/test/core-layout.test.ts` pins which folders exist in each tier and fails on a loose file where a folder belongs, and `configs/core-tiers.mjs` is the one list of the tier names. The dependency-cruiser tier rules (`core-<tier>-below` and `core-tier-siblings-apart`), the core file glob in `configs/eslint.side-effects.mjs`, and the tier probes in `layer-rules.test.ts` are all built from it, so renaming or adding a tier is an edit to that file (plus the folder pins in `core-layout.test.ts`, and a probe for a new tier's rule).

## Consequences

- The import direction is the folder order. A change in `records` cannot reach `queues` by import, so the cycles stay out. `no-circular` is an error (a0036f5).
- Moving a file down a tier to share it is the fix for a sibling import, and the usual one. It is sometimes a type moved into a small file of its own, as in a0036f5, rather than the whole module.
- A new folder is a decision about its tier, and the layout test makes it visible in the diff.
- The tiers are a rule about imports, not a promise about behavior. `orchestration/board` still reads from more than a dozen sources, and the board's size (ADR-07) is unchanged.
- The two edges that still broke the order on 11/5 were fixed first thing in the split commit (ADR-20), so the graph had no exception when the rules went in.

## Open questions

- Narrowing core's `exports` to the folders an app may use (ADR-20).
