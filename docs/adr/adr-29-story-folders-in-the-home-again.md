# ADR-29: Story folders in `~/.once-upon` again

Decided 11/16 (card bl_mwceyeaj15c587, plan and plan check in `notes/` for `stories-home`), built in the commit that adds this file. It supersedes ADR-03's placement and answers its open question 3 as "moved".

## Context

ADR-03 put a story in `<checkout>/.once-upon/<id>/`, kept out of git by the checkout's `.git/info/exclude`. A PR branch can track files under `.once-upon/<story>/`, and checking it out then replaces the story's `chapters.json`, `file-map.json` or `meta.json` with the branch's text: git overwrites an ignored file that is in its way. A story the bridge serves, and a diff it builds from `meta.json`, would be the branch author's. An earlier fix (`checkedMeta` and `refusalOf` in `meta.ts`) vetoed a tampered `meta.json` but not the chapter text or the file map.

## Decision

- **One place: `~/.once-upon/<id>/`** (`ONCE_UPON_HOME`), for PR stories (`<Owner>-<repo>-<N>`) and local stories (`local-<folder>-<branch>`). `storyDirFor(home, id, {kind})` in `placement.ts` is the one path function: no checkout, no exclude line, no index write. It refuses an id that names one of the home's own entries (`state`, `parts`, ...).
- **`StoryStore.dirs()` reads only the home's child folders.** It no longer follows `stories.json`, so an index entry can never point back into a checkout. This is the line that closes the hole.
- **Migration** (`stories/src/migrate.ts`): every `stories.json` entry whose folder is in a checkout is a legacy story. It moves into `<home>/<id>` (rename; across filesystems copy to `.<id>.moving`, rename into place, remove the source), under the index's lock, which `storyDirFor` takes too, and its entry is dropped. A folder moves only when no branch tracks files in it (`git ls-files`), neither it nor anything in it is a symbolic link, its `meta.json` and recorded kind pass `refusalOf`'s checks, and `<home>/<id>` is not there already. Any other stays where it is, unserved, never deleted, and `once-upon doctor` names it with why (`Story folders`: WARN). A second run does nothing.
- **No manual step.** `main()` in the CLI runs the migration before every command but `setup` (a JSON read when there is nothing to move, silent unless something moved or was left); `once-upon setup` runs it and prints the result. Doctor reports and moves nothing.
- **An id two checkouts share** (same folder name, same branch) is now one folder. `createLocalStory` refuses when `<home>/<id>/meta.json` names another checkout's `repo_path` ("pass --id") instead of overwriting the first.
- The `/.once-upon/` exclude line older versions wrote stays; nothing edits a user's git config. `.once-upon-parts.json`, the repo's own parts file read from the working tree, is out of scope: it only labels the parts strip.
- `scripts/lib/worktree-cleanup.sh` still moves a landed worktree's `.once-upon/<id>` to `<home>/<id>`, but only through `once-upon move-story --dir`, which runs the migration's checks (tracked files under any letter case, symbolic links, meta.json, recorded kind) under the stories lock and leaves a folder that fails them, so the worktree stays; for new stories it finds nothing.

## Consequences

- A story survives its worktree being deleted and `git clean -fdX`; deleting a worktree no longer removes its local stories, which pile up in the home until the idle rules hide them.
- An agent in a worktree reads story files from `~/.once-upon/<id>`, outside its worktree, as it already reads `~/.once-upon/state` and the inbox.
- A follow-up can delete what the move retires (`inCheckout`, `refusalOf`'s checkout branch, `recordKind`, the index) once a release has run the migration; until then `refusalOf` still guards the legacy folders.
