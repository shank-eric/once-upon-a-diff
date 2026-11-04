# ADR-04: JSON files as the store

Descriptive, of the code on main at 7fa8447 (11/4).

## Context

The bridge, a dozen CLI commands and the skills' shell lines all need the same state, and the bridge has no runtime dependencies. People (and Claude) read the files to debug, and sometimes edit them.

## Decision

- **Plain JSON files**, one per concern: `builds.json`, `fixes.json`, `handed.json`, `asking.json`, `stories.json`, `checkouts.json`, `prefs.json`, `worktrees.json` (the board's worktree scan, saved so a restart shows the last one), `listener-history.json`, `listener-stops.json`, `github-answers.json` (what GitHub last said, so a restart shows it until GitHub answers again), and `state/<key>/*.json` per story or PR (now including `agent.json`, a subagent's binding, and `approved.json`). `state-map.md` lists them all.
- **Append-only JSONL logs.** `inbox.jsonl` holds questions, answers, notes, reads and fix events. Readers keep a byte-offset cursor in `cursors/<consumer>.json` and skip a half-written last line. `backlog.jsonl` holds the board's Backlog as events (add, edit, start, assign, claim, done, hold, move, drop, reopen) that are folded on read, so the bridge and the CLI can both write it with no lock and nothing is lost to a crossed rewrite. `agents.jsonl` is the agent registry, the events `once-upon agent start|state|beat|finish` append, folded on read the same way. `worktree-cleanups.jsonl` is a record of each worktree Clean up and the line that restores its branch.
- **Files that other tools write.** `statusline/<session id>.json` is copied there by a status line script on each render and read by the board (ADR-11). The board also reads Claude Code's and Larmor's files, so those formats are not ours to change.
- **Reads are forgiving.** `readJson` returns a fallback on a missing file or bad JSON (`adapters/stores/json-file.ts`), and callers check shapes. Settings are read on every request, so an edit needs no restart.
- **Writes rewrite the whole file, atomically.** Every JSON file, and every file the bridge rewrites in place, goes to a unique temp file and is renamed (`writeJsonAtomic`, `writeFileAtomic` and `copyFileAtomic` in `adapters/stores/json-file.ts`). Appends go through `appendText` (`adapters/stores/files.ts`). Only adapters write files, and a lint rule keeps services and apps from calling `node:fs` writes themselves (ADR-15). Two writes in place remain: an empty `inbox.jsonl` when it is made, and Larmor's `paused` marker.
- **Locks only where processes really cross, no schema version, no migrations.** `builds.json` and `fixes.json` (with every `notes.json`) are written under an O_EXCL lock file, `<file>.lock` holding `{pid, at}` (`adapters/stores/lock.ts`, through `services/inbox/queue.ts`). A lock whose pid is gone, or that is 10 s old, is taken over. Usage capture keeps its own lock folder for `coverage-cli.json`. New fields are optional, and old shapes are read with fallbacks.
- **Privacy by umask.** The CLI entry sets `umask 077` (`bin/once-upon.ts`). `ownerOnly` tightens `~/.once-upon` and each `.once-upon/`.

## Consequences

- Anyone can `cat` or `jq` the whole state, and tests isolate it with `ONCE_UPON_HOME`.
- **Lost updates between processes, outside the locked stores.** `state-map.md` §7 lists the races. `builds.json` claims and the `notes.json` and `fixes.json` pair are closed by the lock (11/4). Cursors and `meta.json` in local story folders are still open.
- **Atomic writes stop torn reads, not lost updates.** A reader never sees half a file, but two read-modify-write cycles can still cross, as the races say.
- **Growth with no pruning.** `inbox.jsonl` is never rotated and is reread whole on every pulse. `state/`, `cursors/`, `listeners/`, `handed.json`, `fixes.json` and the logs only grow.
- **Duplicated facts.** Reads, notes and fix events are in both `state/` and the inbox log. Keeping a log and a current-state file side by side is the pattern, and nothing reconciles them.
- Files made before the umask was added keep their old modes. A home made by an older version can have world-readable `builds.json`, `stories.json`, `checkouts.json`, `prefs.json` and state files, despite what the README says.
- Old id schemes linger as orphaned state folders (`state/repo-123` from before ids carried the owner).

## Open questions
1. ~~Add a lock (an `O_EXCL` lock file per store), or make the bridge the only writer when it's up (ADR-05)?~~ Answered 11/4: an O_EXCL lock file for `builds.json` and `fixes.json`. The CLI has to work with the bridge down, so the bridge can't be the only writer.
2. ~~Move the stores with real concurrency (builds, fixes, notes, the inbox) to SQLite?~~ Not now (11/4): on Node 24.14 `node:sqlite` still prints an ExperimentalWarning on load, which every CLI call would show, and it would end `cat` and `jq` on the store. Look again once it's stable, if the JSON stores outgrow the lock.
3. Add a pruning policy (inbox rotation, state for merged or deleted stories, consumer cursors) and run it from `doctor --fix` or on bridge start?
4. Fix existing file modes once (`chmod -R go-rwx ~/.once-upon`) and have `doctor` check them?
5. ~~Should `builds.json` and `fixes.json` become append-only event logs, as the backlog is, so a claim and a click can't cross?~~ Not needed now that they're locked (11/4).
