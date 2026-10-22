---
name: once-upon
description: Tell the story of a GitHub pull request one chapter at a time, with Q&A between chapters, in Once Upon a Diff's side panel on the PR's GitHub page (filtered to the chapter's files). Every changed file is placed in a chapter, and review comments are drafted paste-ready, never posted. Use when the user asks for the story of a PR, to walk them through a PR, or to guide a review "so I've seen every file", or types /once-upon.
---

# Once Upon a Diff

The reviewer (the user) reads a chapter, asks questions, says "next". The chapter's story sits in Once Upon a Diff's panel on the PR page, the diff is filtered to that chapter's files, and Q&A happens in the panel's Ask box, by voice or in chat. Once Upon a Diff (a Chrome extension plus a local bridge) is the only way a story shows on GitHub, so this skill needs it. Check for it before step 1, as "Once Upon a Diff" below says, which also covers what to do when it isn't there.

`<skill>` is this folder, `skills/once-upon` in the Once Upon a Diff repo, linked in as `~/.claude/skills/once-upon`. `<once-upon-repo>` is that checkout: `$(cd "$(dirname "$(realpath ~/.claude/skills/once-upon/SKILL.md)")/../.." && pwd)`. `<cli>` is `node <once-upon-repo>/bridge/bin/once-upon.mjs`, the Once Upon a Diff CLI.

## House rules

Before step 1, read the reviewer's own rules if they have any:

```bash
h="${ONCE_UPON_HOME:-$HOME/.once-upon}"; f=$(jq -r '.house_rules // empty' "$h/config.json" 2>/dev/null); f="${f/#\~/$HOME}"; cat "${f:-$h/house-rules.md}" 2>/dev/null
```

That's the file named by `house_rules` in `~/.once-upon/config.json`, else `~/.once-upon/house-rules.md`. It lives outside this repo, on the reviewer's machine. Follow it alongside the rules here: it adds rules (where checkouts live, how to name people, a time zone, the voice for comments) and wins where it's more specific. It can't loosen the read-only rule below. If there's no file, the rules here are all there is.

## Hard rules

- Read-only on GitHub. Never post comments, submit or approve reviews, click Viewed, or push. Comments are drafted in fenced blocks for the reviewer to post. The one place Viewed gets ticked is the reviewer's own click on a file's Mark viewed button in Once Upon a Diff's panel, which ticks that file's checkbox for them. Claude never clicks it, and nothing ticks it automatically or in bulk.
- `gh` runs as the reviewer's own gh login. When `gh_unset_github_token` is true in `~/.once-upon/config.json`, every `gh` call runs after `unset GITHUB_TOKEN` (the scripts do this).
- Read old code from a local checkout (`checkouts.txt`, from the folders in `checkout_dirs`, default `~/Development`) with `git show <base-oid>:<path>`. If the base commit is missing, `git fetch origin <base>` is fine. If you need the PR head, fetch it into `refs/tmp/pr-N` and delete the ref when done. If there's no checkout, ask before cloning.
- All working files go in `<scratchpad>/once-upon/<repo>-<N>/`, never in a repo. The one copy made elsewhere is the published Once Upon a Diff copy (below).
- Name people by their GitHub login unless the house rules say how to look up names. Times in the reviewer's time zone (`time_zone` in the config, else the system's).
- Verify a claim against code, CI logs or the old code before stating it. Say whether a problem was reproduced or only suspected.

## Steps

1. **Gather.** With a PR number or URL (repo from the URL, an `owner/repo` argument, or the cwd):
   ```bash
   <skill>/bin/gather.sh <number|url> [owner/repo] -o <D>
   node <skill>/bin/story.mjs brief --dir <D> > <D>/brief.json
   ```
   This writes `pr.json`, `pr.diff`, `threads.json` (review threads with resolved/outdated), `checks.json`, `viewed.tsv` and `checkouts.txt` (local clones, freshest first). Read `brief.json`, not the raw diff, then read the diff and old code file by file as you plan. If `gh pr diff` fails on a huge PR, make `pr.diff` from the local checkout with `git diff <base-oid>...<head-oid>`.

2. **Plan chapters.** Tell it as a user journey unless the reviewer asks for chronological ("in order", "commit by commit", "how it got here"). Don't ask. **The result comes first:** each chapter tells how a user meets the code as it's built, not how it was written. Write `<D>/chapters.json`:
   ```json
   {"mode": "journey", "title": "≤60 chars", "summary": "≤240 chars", "plan": "2-4 sentences",
    "overview": "markdown: what the PR is for, the story map, where it stands",
    "decisions": [], "outcome": "completed|partial|failed|blocked", "outcome_note": "…",
    "chapters": [{"title": "Chapter 1: …", "headline": "one spoken sentence", "scenario": "one line",
      "summary": "one sentence", "answer": "≤400 chars, filled once told", "narrative": "",
      "files": ["path", {"rel": "path", "partial": true, "note": "which part",
        "lines": [{"side": "R", "start": 40, "end": 58, "label": "the timeline select"}]}],
      "comments": [{"path": "…", "line": 12, "body": "…"}]}]}
   ```
   - **Journey:** one chapter per thing a user does, in the order they'd do it (install, first command, next command, …). Introduce a shared file where the flow first reaches it. If only part of it is used there, list it as `partial` and list it plainly in the chapter that covers the rest. When a step would run past ≈8 files or ≈300 words, split it into smaller steps (by screen, interaction or layer) rather than letting one chapter grow.
   - **Chronological:** chapter 1 is "before" (the old code), then one chapter per commit or coherent commit group, each review round folded into the chapter after it, and a last "where it stands" chapter. Files are placed in the chapter whose commit last shaped them.
   - **Default order, a hint.** When the journey doesn't settle the order, start with schema, contracts and types, then take each feature through its logic, its call sites and wiring, and its UI, with that feature's tests right after it. Docs go last. The narrative wins whenever it needs a different order.
   - Tests go in the chapter of the code they test. Lockfiles and config go where they first matter.
   - `build` fails unless every PR file is in a chapter and every partial is finished somewhere.
   - **Every hunk has a home,** not only every file. `build` also fails with "hunks not covered" while a hunk of a file bigger than 40 changed lines has no chapter pointing at a line inside it: a `lines` range, a `` `path:N-M` `` in the narrative or a comment on one of its lines. Listing a file covers it when it's that small, deleted or a lockfile, or when the entry says `"whole": true` because one chapter tells all of it. Fix each one it names before telling the story, usually with a `lines` range in the chapter that tells it (the first build has no narratives yet).
   - **The story map goes in `overview`,** not at the top of chapter 1's `narrative`. Each `narrative` starts at its own `### Chapter N: …` heading. (The panel moves a story map it finds before that heading to the Overview, but write it in the right place.)
   - **Line references.** For the key hunks a chapter discusses, add 2-4 `lines` ranges to that chapter's file entries, with real line numbers read from `pr.diff` (`R` is the new side, `L` the old side for removed lines) and a short label. In the narrative, write file mentions in backticks (a path, a unique suffix or a basename) and line mentions as `` `path:40` `` or `` `path:40-58` `` (`path:L12` for an old-side line). Only lines inside the diff's hunks are on the page, so point at changed or nearby context lines.

3. **Build and publish.**
   ```bash
   node <skill>/bin/story.mjs build --dir <D>
   ```
   `build` writes `file-map.json` (file → chapters, partial_in, finished_in) and publishes the story for Once Upon a Diff (`--no-bridge` skips that). It refuses to publish while a file is unplaced or a hunk isn't covered (step 2). `--allow-uncovered` publishes anyway, and the panel's Overview then lists those hunks in a quiet note. Keep it for an update to a story that was built before this check. Fill in each chapter's `narrative`, `comments` and `answer` as you tell it, then build again: the panel picks it up within a few seconds.

4. **Tell the story,** one chapter per step. The panel shows the chapter, so the chat reply for a step is one line ("Chapter 2 is up in the panel: …" plus its headline).
   - **Answer questions in place** from the diff and the code, checking the old code or CI where it matters. Stay on the chapter until they say "next".
   - **Offer comments** in fenced blocks, flush left, one per thread, naming the file and line to put it on. Never post them. Also add every comment drafted in conversation (chat, voice or a panel question) to the panel: write the body to a file and run `<cli> comment --story <id> --chapter <N> --path <file> --line <L> --body-file <f>` (no `--path`/`--line` for a general comment). It appends to the chapter's `comments` in both the published copy and `<D>/chapters.json`, so a later render keeps it, and the panel's Draft comments show it within a few seconds. Do both: the fenced block in chat and the command. Before drafting comments for a PR that already has a story, run `<cli> drafts --story <id>`. It lists each draft as posted, pending (in the reviewer's unsubmitted review), dismissed or still a draft. Don't re-suggest a dismissed or posted one. Dismissals are kept per PR by the bridge, so a rebuilt or regenerated story keeps them.

5. **Finish.** After the last chapter: every file accounted for (for example, 74 of 74 placed and 70 viewed), any still unviewed, and "Your comments, in priority order" with file and line for each. If the PR is mergeable, say whether you'd lean approve, comment or request changes, and that it's their call.

## How the story sounds

- **Story map first.** One short paragraph on what the PR is for, then a numbered map: each chapter's bold title and the files it covers, with the total file count.
- **Chapter shape.** `### Chapter N: title`, then "The scenario: …" in a sentence. Then numbered steps that follow what happens, with nested bullets for branches and checks. Name each file in backticks the moment the flow reaches it and say what it does in plain words.
- **Follow the calls.** Open each chapter at the entry point the code flows from (the function its callers reach first), say what it does and where it lives, then follow its calls outward, helpers after the code that calls them. Give every function the text names a `` `file:line` `` reference, since a bare name like `getAffectedSourceFiles` doesn't link.
- **Then what you checked.** Against the old code ("I compared these against the old scripts"), against prod or CI logs, against the other repo. Say what holds up.
- **Questions worth asking.** "One question worth asking" or "What to raise in this chapter", numbered, each with the reason, then the paste-ready comment. Mark nits as optional: "Not worth a comment unless you're already writing one on that file."
- **Files to mark viewed,** grouped by directory, with partials called out ("`report.ts` comes back in chapter 4, so leave it unticked until then if you'd rather") and "Still held: …".
- **Close** with "Next is chapter N, <title>." and nothing else.
- **Chronological variant.** "Short version" first, then Before, each commit with its date, each review round by reviewer, a "where it stands against your asks" table, and "things to look at before approving".
- Plain, hedged where unsure, no zingers. Draft comments in the reviewer's voice: short, "I think", "Could you confirm", framed by what the change does to its users, no names. ≈150-300 words and ≈3-8 files a chapter. Favor more, shorter chapters over long ones: split a big step by screen, interaction or layer, and don't repeat a point from an earlier chapter.
- For a merged PR, comments become follow-up notes, and say so.

## Voice mode

If a voice mode is on (for example Larmor), speak the chapter's `headline` and one line on what to look at, then put the full chapter on screen. Answer spoken questions briefly aloud with detail on screen. Never read paths, code or comment blocks aloud.

## Once Upon a Diff: where the story shows

Once Upon a Diff (`<once-upon-repo>`, an unpacked Chrome extension plus a local bridge) shows the story in a side panel on the PR's /changes or /files page by itself. It survives reloads and in-page navigation, remembers the step per PR, follows GitHub's light or dark theme, and picks up each re-render within ≈5s.

1. **Check the bridge.** `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(jq -r .token ~/.once-upon/config.json)" "http://127.0.0.1:$(jq -r .port ~/.once-upon/config.json)/api/health"` prints 200 when it's up.
   - **No `~/.once-upon/config.json`** means Once Upon a Diff isn't set up. Tell the reviewer in one line that the story needs it, point them to `<once-upon-repo>/GETTING-STARTED.md` (the bridge's config, the extension and the skills), and wait until they say it's ready. Don't tell the story in chat or inject anything into the page instead.
   - **A config but no 200** means the bridge isn't running. Ask once whether to start it (`<cli> serve`, as a background task) or whether they'll run `yarn bridge` in `<once-upon-repo>` themselves.
   - **The extension.** After the first `build`, the panel should open on the PR page. If it doesn't, `<cli> doctor` says whether the bridge has ever heard from the extension. If it hasn't, the extension isn't loaded or doesn't have the port and token: point them to step 5 of `GETTING-STARTED.md`.
2. **Publish.** `build` runs `<cli> publish --dir <D>`, which copies `chapters.json` and `file-map.json`, with a `meta.json` naming the PR and its head commit, into the repo's checkout (`<checkout>/.once-upon/<owner>-<repo>-<N>/`) or `~/.once-upon/<owner>-<repo>-<N>/` (`publish --dir <D>` does just that step, `--no-bridge` skips it). The bridge reads only published stories, never the scratch folder.
3. **Questions from the panel.** The panel's Ask box appends to `~/.once-upon/inbox.jsonl`. While telling the story, keep `<cli> wait --consumer once-upon` running as a background task. When it exits it has printed a question (id, chapter, file, text). Answer it in chat as usual, also run `<cli> answer --question <id> --file <answer.md>` so the answer shows under the question in the panel, then start the wait again. The wait also returns `build_request` lines: the reviewer clicked "Build story" on a PR that has none. Tell them in one line, and run this skill on that URL if they say so (or already asked for it in this session). `build` publishes the story, and the bridge then marks the request done and the page opens the panel by itself. If it can't be built, `<cli> done <id> --failed --note "…"`. `<cli> builds` lists pending requests. A request with `mode: 'update'` means the story is out of date: follow "Updating a story" below. The new `head_oid` finishes the request.
4. **Where they are.** `~/.once-upon/state/<story id>/position.json` has the step and the file at the top of their screen. Use it when they say "this one" or "here", and read its `step` for the `--chapter N` of a comment drafted in Q&A, so it lands on the chapter they're on.
5. **Local commits.** For a story about commits that aren't pushed, `<cli> local --repo <checkout> --base <ref> --head HEAD --chapters <D>/chapters.json --no-open` serves the same chapters over the local diff at `http://127.0.0.1:<port>/local/<id>/` and opens it. Viewed toggles and "fix before push" notes there are kept by the bridge (`<cli> notes --story <id>`), and comments in `chapters.json` show as "Fix before push". Place every file, as for a PR. Any that aren't placed land in a last "Not in a chapter yet" step.

### What the panel shows

- **Steps.** Step 0 is the Overview: the `overview` markdown (or `summary` and `plan`), every file with its chapters, and no filter. Then one step per chapter.
- **A chapter step** shows the narrative, the draft comments with Copy buttons and "Files in this chapter", and hides every other chapter's files and file-tree rows ("show all files" undoes it).
- **Copy as gh script,** in the Overview's list of every draft, copies a shell script that puts the line drafts still to post into one pending review with `gh api`. It only copies. The reviewer runs it if they want to, and the review stays unsubmitted until they submit it.
- **Jumps.** Backticked file names in the narrative, the file list and the comment headers scroll the page to that file's diff. `path:40-58` mentions, `lines` entries and comment lines scroll to the line and highlight the range. A name matches a file on screen in that step, and an ambiguous one goes to the first match in chapter order. Clicking a file or line link opens a collapsed file (Viewed files collapse) and expands hunks until the line is on the page, without unmarking Viewed or dropping `?w=1`.
- **What to tick.** Each file says "Mark viewed", "Leave unviewed: comes back in chapter N (…)" or "Already finished in chapter N", from the same placement rules as `file-map.json`. Only the files a chapter finishes get a Mark viewed button there, and the first mention in the narrative carries a small pill with the same status.

The panel clicks only two kinds of GitHub control, and only on the reviewer's own click in it: a file or line link may click GitHub's expand controls (a file's expand toggle, Load diff, hunk expanders) to open the target, and a file's Mark viewed button (or its "Viewed ✓", to untick it) clicks that one file's own Viewed toggle. It never clicks comment, review, approve or resolve controls, submits nothing, and talks only to the bridge on 127.0.0.1. Hiding the panel (its × or the toolbar button) is remembered per PR.

### Updating a story: "Since you read it"

An update request (`mode: 'update'`) carries `base_sha` (the commit the story was told from), `since_sha` (where the reviewer's reading stopped: the story head they read their earliest chapter at, from the bridge's `state/pr-<owner>-<repo>-<N>/read.json`, or `base_sha` when they read none) and `reads` (each chapter they read, its commit and when). `<cli> builds --json` shows the same. The default is an addendum, not a re-tell:

1. Gather again into the same `<D>`, so `pr.json` has the new head. Read `git log --oneline <since_sha>..<new head>` and `git diff <since_sha>..<new head>` in the local checkout (fetch the head into `refs/tmp/pr-<N>` if it's missing).
2. Write one new chapter for just those commits and put it **first** in `chapters`:
   ```json
   {"key": "since-<since7>-<head7>", "title": "Since you read it: N new commits",
    "since": {"from": "<since_sha, full>", "to": "<new head, full>", "commits": N},
    "headline": "…", "scenario": "…", "summary": "…", "narrative": "### Since you read it\n\n…",
    "files": ["every file git diff --name-only <since_sha>..<new head> lists"], "comments": []}
   ```
   - Its `files` are exactly the files those commits touched, so the panel's filter shows only them, and it marks them "Mark viewed" here.
   - The narrative says what the new commits do (one step per commit, or per coherent group), which review threads they answer, and what to check. Same voice and length as a chapter. Name files and lines as usual, with line numbers from the new head. Link GitHub's diff of just these commits, `[these N commits on GitHub](<pr url>/changes/<since_sha>..<new head>)`, with full SHAs. The panel adds the same link.
   - Draft comments about the new commits go on this chapter.
3. **Keep every earlier chapter as it is,** byte for byte: title (with its "Chapter N:"), `key`, narrative, files, lines and comments. Don't renumber them. The panel doesn't number "Since you read it" chapters, so the old chapters keep the numbers the reviewer read them with, and chapter numbers in their text stay right. Only two things change: a file the new commits deleted or renamed leaves its old chapter (it's in the new one), and a file they added goes only in the new one. Old line ranges may now be a few lines off, and the panel jumps to the nearest shown line, so leave them.
4. An earlier "Since you read it" chapter stays where it is, after the new one.
5. `build`, and say in one line which commits the new chapter covers.

**Re-tell from scratch** instead when the request has `retell: true` (the reviewer clicked "Re-tell from scratch"), when `git merge-base --is-ancestor <since_sha> <new head>` fails (a rebase or force-push), or when the new commits rework most of the PR. Plan it as a new story (steps 2 and 3). The bridge keeps the drafts' posted and dismissed marks per PR, so they carry over. Say in one line why it was re-told.

## Files

- `bin/gather.sh`: read-only `gh` fetch into the scratch folder.
- `bin/viewed.sh`: the gh user's viewed state per file (GraphQL `viewerViewedState`), for `brief`.
- `bin/story.mjs`: `brief`, `build`, `publish`. It reads the diff and places files with the bridge's and the panel's own code from this checkout, so `file-map.json` matches the panel, and checks hunk coverage with `bridge/stories/hunk-coverage.mjs`.
