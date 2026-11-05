# ADR-05: HTTP only between browser and bridge, with the CLI using the stores in-process

Descriptive, of the code on main at 0741c6c (10/29). Since 11/5: "the stores the bridge uses" are in `packages/core`, which the CLI imports by package name, never through the HTTP app, and the lint (ADR-22) keeps `cli` and `server` from importing each other (ADR-20). The rule here, HTTP only between browser and bridge, is unchanged.

## Context

There are three kinds of caller. The extension and the bridge's own pages are in a browser and can only speak HTTP. The CLI and the skills are processes on the same machine with the same file access as the bridge. Listeners have to work, and questions have to queue, even when the bridge is down.

## Decision

- **The browser talks to the bridge over HTTP only.** The extension's service worker, the local page and the board call `/api/...`.
- **The CLI never calls the bridge's API for state.** Every command builds the same stores the bridge uses (`StoryStore`, `Inbox`, `Builds`, `readFixes`, `listeners`) on the same `~/.once-upon` and reads and writes the files directly. `wait`, `ask`, `asking`, `answer`, `bind`, `fixed`, `working`, `publish`, `local`, `comment`, `approve`, `pr-draft`, `done`, `builds` and `backlog` all work with no bridge running.
- **The one HTTP call the CLI makes:** `doctor` calls `/api/health` on purpose, as the check that walks the browser's road. `local`, `page` and `board` print links, made from `config.json`'s token with no call to the bridge. `local` recognises its own bridge from `bridge.json` rather than by calling it, and `board` builds a `Board` in the CLI process to count cards.
- **Two probes that aren't API calls.** The board's voice module connects a TCP socket to Larmor's phone-bridge sink port on 127.0.0.1 (`bridgeUp` in `packages/core/src/adapters/larmor.ts`) to see whether it is listening, and runs Larmor's `voice_ctl` as a child process for phone mode (ADR-11). Neither calls the bridge.
- **The skill helper imports modules straight from its checkout** (`skills/once-upon/bin/story.ts`: diff parsing, chapters, text refs and hunk coverage from `packages/core/src/records/stories/`, atomic writes from `packages/core/src/adapters/stores/`, and `finishedInOf` from `packages/domain/src/chapters.ts`; the arguments parser comes from `packages/cli/src/args.ts`), so `file-map.json` is made by the panel's own rules. It then runs `once-upon publish` as a child process.

## Consequences

- Nothing a listener does depends on the bridge being up. Questions and requests queue in files.
- The CLI needs no token. The file system's permissions are the only boundary for local processes.
- **Two writers.** Business rules (routing, claims, rebuild vetting, fix state) run in whichever process acts, against shared files with no lock (ADR-04). The rules agree because it's the same module. The writes can still cross.
- **The bridge's in-memory caches don't hear about CLI writes.** It rereads files on each request, so most views catch up within one poll. The PR-tag `statusCache` lags up to 5 s, and the AutoReview maps until their own windows run out.
- **Version skew is possible.** A CLI or skill from one checkout can write files that a bridge from another checkout reads. Nothing checks they match, and the stores have no schema version.
- Changing a store's shape means changing every process that opens it, including the shell lines in the skills (`jq` on `config.json`).

## Open questions

1. When the bridge is up, should CLI writes go through it (a small internal API with the token), so there's one writer and the caches stay true? The fallback to direct files would stay for when it's down.
2. Should `bridge.json` carry the bridge's code version, so the CLI can warn on skew?
3. Should the skill import a published entry point rather than reaching into `packages/core/src` and `packages/cli/src` (`packages/bridge/src` before the split)?
