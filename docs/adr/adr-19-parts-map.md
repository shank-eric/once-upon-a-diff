# ADR-19: A repo's parts map, read from its checkout and never stored

Descriptive, of the code on main at 7fa8447 (11/4). Built in 88b07b9. No earlier ADR covered it.

## Context

A story walks a reviewer through chapters, but nothing on a step said where in the repo it was: server or client, which layer, which package. The repo's layers are a fact the repo owns, not something a story writer should restate in every chapter, and a reviewer of someone else's repo may want their own names for its parts.

## Decision

- **A parts file names a repo's parts once.** Version 1 maps folders to named parts in groups (`{ "id", "name", "group", "paths", "note" }`). The rules are pure and live in the domain (`protocol/src/domain/parts.ts`: `parsePartsFile`, `storyPartsOf`).
- **Two places, first found wins.** The reviewer's own `<home>/parts/<owner>-<name>.json`, for a repo that isn't theirs to commit to, then the repo's `.once-upon-parts.json` at a checkout's root: a local story's worktree, or a PR story's main checkout (its working tree, not the PR's head). `services/stories/parts.ts` reads and checks it, caching by path and mtime, so an edit shows on the next fetch with no restart.
- **Worked out on each load, never stored.** `storyData` (`services/stories/story-data.ts`) adds the response-only `StoryData.parts`. Nothing on disk changes, an older story gains its strip the day its repo gets a file, and a renamed part is renamed everywhere.
- **Drawn by `ui`.** The panel draws `PartsStrip` (`packages/ui/src/parts-strip.ts`) under Steps on the Overview (every group, with file counts) and on each chapter (groups it doesn't touch fold).
- **No file, no strip, never an error.** A file over 256 KB, or one that doesn't check out, is ignored with a warning on stderr, and for the reviewer's own file the repo's is used instead.
- This repo has its own file, and `packages/bridge/test/parts-file-covers-repo.test.ts` fails when a tracked file is in no named part.

## Consequences

- The bridge reads a file from a checkout that the repo's own people control. It's data: checked on read (`parsePartsFile`), capped in size, and only ever drawn as text (ADR-13).
- A repo that restructures has to keep its parts file in step, or the strip says the wrong thing. This repo's drift test does that for itself only.
- The strip shows which parts a step touches. It doesn't judge whether a step should cross layers.

## Open questions

1. Should a step that crosses layers be flagged, using the groups (deferred in the parts plan)?
2. Should `once-upon doctor` check a checkout's parts file?
