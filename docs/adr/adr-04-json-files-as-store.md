# ADR-04: JSON files as the store

Descriptive, of the code on main at 0741c6c (10/29).

## Context

The bridge, a dozen CLI commands and the skills' shell lines all need the same state, and the bridge has no runtime dependencies. People (and Claude) read the files to debug, and sometimes edit them.

## Decision

- **Plain JSON files**, one per concern: `builds.json`, `fixes.json`, `handed.json`, `asking.json`, `stories.json`, `checkouts.json`, `prefs.json`, `worktrees.json` (the board's worktree scan, saved so a restart shows the last one), `listener-history.json`, `listener-stops.json`, and `state/<key>/*.json` per story or PR (now including `agent.json`, a subagent's binding, and `approved.json`). `state-map.md` lists them all.
- **Append-only JSONL logs.** `inbox.jsonl` holds questions, answers, notes, reads and fix events. Readers keep a byte-offset cursor in `cursors/<consumer>.json` and skip a half-written last line. `backlog.jsonl` holds the board's Backlog as events (add, start, assign, move, drop) that are folded on read, so the bridge and the CLI can both write it with no lock and nothing is lost to a crossed rewrite. `worktree-cleanups.jsonl` is a record of each worktree Clean up and the line that restores its branch.
- **Files that other tools write.** `statusline/<session id>.json` is copied there by a status line script on each render and read by the board (ADR-11). The board also reads Claude Code's and Larmor's files, so those formats are not ours to change.
- **Reads are forgiving.** `readJson` returns a fallback on a missing file or bad JSON (`adapters/stores/json-file.ts`), and callers check shapes. Settings are read on every request, so an edit needs no restart.
- **Writes rewrite the whole file, atomically.** Every JSON file, and every file the bridge rewrites in place, goes to a unique temp file and is renamed (`writeJsonAtomic`, `writeFileAtomic` and `copyFileAtomic` in `adapters/stores/json-file.ts`). Appends go through `appendText` (`adapters/stores/files.ts`). Only adapters write files, and a lint rule keeps services and apps from calling `node:fs` writes themselves (ADR-15). Two writes in place remain: an empty `inbox.jsonl` when it is made, and Larmor's `paused` marker.
- **No locks, no schema version, no migrations.** New fields are optional, and old shapes are read with fallbacks.
- **Privacy by umask.** The CLI entry sets `umask 077` (`bin/once-upon.ts`). `ownerOnly` tightens `~/.once-upon` and each `.once-upon/`.

## Consequences

- Anyone can `cat` or `jq` the whole state, and tests isolate it with `ONCE_UPON_HOME`.
- **Lost updates between processes.** The bridge and CLI processes rewrite the same files with no lock. `state-map.md` §7 lists the races, which are all still open (the atomic writes changed two of them): `builds.json` claims, the `notes.json` and `fixes.json` pairs, cursors, and `meta.json` in local story folders.
- **Atomic writes stop torn reads, not lost updates.** A reader never sees half a file, but two read-modify-write cycles can still cross, as the races say.
- **Growth with no pruning.** `inbox.jsonl` is never rotated and is reread whole on every pulse. `state/`, `cursors/`, `listeners/`, `handed.json`, `fixes.json` and the logs only grow.
- **Duplicated facts.** Reads, notes and fix events are in both `state/` and the inbox log. Keeping a log and a current-state file side by side is the pattern, and nothing reconciles them.
- Files made before the umask was added keep their old modes. A home made by an older version can have world-readable `builds.json`, `stories.json`, `checkouts.json`, `prefs.json` and state files, despite what the README says.
- Old id schemes linger as orphaned state folders (`state/repo-123` from before ids carried the owner).

## Open questions
1. Add a lock (an `O_EXCL` lock file per store), or make the bridge the only writer when it's up (ADR-05)?
2. Move the stores with real concurrency (builds, fixes, notes, the inbox) to SQLite? Node 24 ships `node:sqlite`, but check its stability flag first. That would keep "no runtime dependencies".
3. Add a pruning policy (inbox rotation, state for merged or deleted stories, consumer cursors) and run it from `doctor --fix` or on bridge start?
4. Fix existing file modes once (`chmod -R go-rwx ~/.once-upon`) and have `doctor` check them?
5. Should `builds.json` and `fixes.json` become append-only event logs, as the backlog is, so a claim and a click can't cross?
