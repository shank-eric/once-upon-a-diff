# ADR-04: JSON files as the store

> Paths in this ADR are as of its date. The code has moved since; `docs/flows.md` and ADR-26 cite where it lives now.

Descriptive, of the code on main at 7fa8447 (11/4). Since 11/5: the services are in `packages/core` under tiers (ADR-20, ADR-21), so the request queue is `queues/requests/` (it was `services/inbox/`) and the adapters are `packages/adapters/src/`. The stores and their rules are unchanged.

See [ADR-26](adr-26-the-data-model.md) for every store, its key, its writers and the rules, as of 11/6.

## Context

The bridge, a dozen CLI commands and the skills' shell lines all need the same state, and the bridge has no runtime dependencies. People (and Claude) read the files to debug, and sometimes edit them.

## Decision

- **Plain JSON files**, one per concern: `builds.json`, `fixes.json`, `handed.json`, `asking.json`, `stories.json`, `checkouts.json`, `prefs.json`, `worktrees.json` (the board's worktree scan, saved so a restart shows the last one), `listener-history.json`, `listener-stops.json`, `github-answers.json` (what GitHub last said, so a restart shows it until GitHub answers again), and `state/<key>/*.json` per story or PR (now including `agent.json`, a subagent's binding, and `approved.json`). `state-map.md` lists them all.
- **Append-only JSONL logs.** `inbox.jsonl` holds questions, answers, notes, reads and fix events. Readers keep a byte-offset cursor in `cursors/<consumer>.json` and skip a half-written last line. `backlog.jsonl` holds the board's Backlog as events (add, edit, start, assign, claim, done, hold, move, drop, reopen) that are folded on read, so the bridge and the CLI can both write it with no lock and nothing is lost to a crossed rewrite. `agents.jsonl` is the agent registry (a run names its card and the card owns its runs: [ADR-25](adr-25-the-card-owns-its-runs.md)), the events `once-upon agent start|state|beat|finish` append, folded on read the same way. `worktree-cleanups.jsonl` is a record of each worktree Clean up and the line that restores its branch.
- **Files that other tools write.** `statusline/<session id>.json` is copied there by a status line script on each render and read by the board (ADR-11). The board also reads Claude Code's and Larmor's files, so those formats are not ours to change.
- **Reads are forgiving.** `readJson` returns a fallback on a missing file or bad JSON (`packages/adapters/src/stores/fs/json-file.ts`), and callers check shapes. Settings are read on every request, so an edit needs no restart.
- **Writes rewrite the whole file, atomically.** Every JSON file, and every file the bridge rewrites in place, goes to a unique temp file and is renamed (`writeJsonAtomic`, `writeFileAtomic` and `copyFileAtomic` in `packages/adapters/src/stores/fs/json-file.ts`). Appends go through `appendText` (`packages/adapters/src/stores/fs/files.ts`). Only adapters write files, and a lint rule keeps services and apps from calling `node:fs` writes themselves (ADR-15). Two writes in place remain: an empty `inbox.jsonl` when it is made, and Larmor's `paused` marker.
- **Locks only where processes really cross, no schema version, no migrations.** `builds.json` and `fixes.json` (with every `notes.json`) are written under a lock folder, `<file>.lock`, made with mkdir by the proper-lockfile package (`packages/adapters/src/stores/fs/lock.ts`, over `folder-lock.ts`, through `packages/state/src/queues/requests/queue.ts`). Nothing in it names a holder: a lock no one has touched for 30 s is taken over, whoever made it, so a crashed holder blocks waiters for up to 30 s, and a holder stalled past 30 s (a stopped process, a sleeping laptop) can lose its lock to another process (decided 11/13: the package's age-only staleness is accepted over the pid-and-token lock it replaced, which never took over a live holder); its release then fails or removes the new holder's lock, and `withLock` swallows that. A wait past 35 s throws an error that names the folder and says to remove it if that process is not once-upon, so a stopped holder stops a request or a command with a message instead of freezing it (the bridge answers 500, the CLI prints it and exits 1). A lock file an earlier version left at the path is cleared once it is 2 s old. `backlog claim` and `agent start` also take the log's lock (`backlog.jsonl`, `agents.jsonl`) around their check and append (for a claim that makes claims take turns and nothing more: the latest wins either way). Usage capture locks `coverage-cli.json` the same way (5 s stale, and it runs without the lock after a 1.5 s wait), as does the heavy-run lock (60 s stale, kept fresh while its command runs). New fields are optional, and old shapes are read with fallbacks.
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
3. ~~Add a pruning policy (inbox rotation, state for merged or deleted stories, consumer cursors) and run it from `doctor --fix` or on bridge start?~~ Answered for the logs 11/17: `once-upon doctor --fix` rewrites `agents.jsonl` (runs over 14 days old on a closed card go, a run keeps its last beat) and `inbox.jsonl` (old reads and positions go, cursors move with the file) and keeps the old files as `.bak`; nothing runs on bridge start, and `backlog.jsonl` is left whole. State for merged or deleted stories and the cursors of consumers nobody uses are still unpruned.
4. Fix existing file modes once (`chmod -R go-rwx ~/.once-upon`) and have `doctor` check them?
5. ~~Should `builds.json` and `fixes.json` become append-only event logs, as the backlog is, so a claim and a click can't cross?~~ Not needed now that they're locked (11/4).
