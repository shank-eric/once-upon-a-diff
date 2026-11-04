# ADR-18: Usage capture, counting what the tool actually uses

Descriptive, of the code on main at 7fa8447 (11/4). Built in 9bf7b6f. No earlier ADR covered it.

## Context

The services grew faster than the layers got cleaner (ADR-16), and the question "which of this does anyone use?" had no answer but memory. Trimming needs data: which code runs, which routes are called from which surface, which buttons that never reach the bridge get clicked, and which CLI commands run. The bridge has one runtime dependency and no telemetry, and nothing it keeps may carry story text, ids, paths or what someone typed.

## Decision

- **Four sources, all under `<home>/usage/`, all local.** State map §1 lists the files.
  - **Code coverage.** `bin/once-upon.mjs` loads `adapters/usage/boot.ts` before any other module, and it starts V8's precise coverage through `node:inspector` (function level by default, block ranges with `usage on --lines`, which costs about 2.4x CPU on hot code). `services/usage/capture.ts` reduces each take to uncovered-line bitsets of this checkout's own files and merges them into `coverage-bridge.json` (the bridge) or `coverage-cli.json` (a CLI run, under its own lock folder so runs at once keep each other's lines). The skill's `story.mjs` loads the same shim.
  - **Route counts.** The bridge counts every call by its key in the protocol's route table (or `unmatched`) and by surface (`server/index.ts`, `services/usage/counters.ts`) into `actions.json`, per Eastern Time day.
  - **UI actions.** What never reaches the bridge (a tab switch, a fold) is counted in the page by `count('<name>')` from `api-client/src/usage.ts`, batched at most once a minute and sent to `POST /api/usage` or a story's `/usage`. The names come from one closed list, `protocol/src/domain/usage-actions.ts` `ACTIONS`, each tagged with the feature area it belongs to. The bridge drops any other name.
  - **CLI runs.** Each run appends `YYYY-MM-DD command[.verb]` to `cli-runs.log` (`services/usage/cli-log.ts`), which stops growing at 1 MB.
- **Flushing.** The bridge writes coverage every 5 minutes, on SIGUSR2 and on SIGTERM. `once-upon usage report` asks a running bridge for fresh data with SIGUSR2, never HTTP (ADR-05), and only a bridge that advertised its handler in `bridge-pid.json`. A deploy changes the files on disk before it stops the old bridge, so a script's text and sha are snapshotted the first time it shows up, and a take is never mapped onto text the process didn't run.
- **`once-upon usage report | status | on [--lines] | off | clear`.** The report merges the four sources per feature area on partial data (the whole window, since the last report, `--since`, `--last`). A running bridge sees `off` within 5 seconds (`services/usage/enabled.ts`). A run from a linked worktree is never captured.

## Consequences

- Trims can be argued from counts, not memory (the "usage-led trims" in the architecture notes).
- Every CLI run and the bridge pay a small cost for function-level coverage, and `lines` mode is opt-in for that reason.
- The capture is the only code that talks to `node:inspector`, and `boot.ts` imports nothing from the repo so it can start first. It is an adapter by the layer rules, though the entry shim loads it directly.
- The files only grow until `usage clear`, bounded by the code's size (coverage), 60 days (`actions.json`) and 1 MB (`cli-runs.log`).

## Open questions

1. When a trim is decided, should its area's counts be cleared so the next report starts clean, or kept for comparison?
2. Should `doctor` say when the capture is off, so a report on partial data isn't read as "unused"?
