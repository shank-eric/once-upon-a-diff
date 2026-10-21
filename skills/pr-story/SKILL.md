---
name: pr-story
description: Tell the story of a GitHub pull request one chapter at a time, with Q&A between chapters, either in a side panel injected into the PR's GitHub page (filtered to the chapter's files) or in chat with a session-story page. Every changed file is placed in a chapter, viewed-files are checked at chapter breaks, and review comments are drafted paste-ready, never posted. Use when Eric asks for the story of a PR, to walk him through a PR, or to guide a review "so I've seen every file", or types /pr-story.
---

# PR story

Eric reads a chapter, asks questions, says "next". When he's reviewing in GitHub (he has the PR open, or asks to do it there), the default is the overlay in "GitHub mode" below: the chapter's story sits in a panel on the PR page, the diff is filtered to that chapter's files, and Q&A happens by voice or chat. Otherwise the story is told in chat, and the pinned session-story renderer draws each chapter as a turn with its files' diffs (steps 4 and 5). Planning (steps 1 to 3) and finishing (step 6) are the same either way.

`<skill>` is this folder, `skills/pr-story` in the Diff Story Mode repo, linked in as `~/.claude/skills/pr-story`. `<dsm-repo>` is that checkout: `$(cd "$(dirname "$(realpath ~/.claude/skills/pr-story/SKILL.md)")/../.." && pwd)`. `<dsm>` is `node <dsm-repo>/bridge/bin/diff-story.mjs`, the Diff Story Mode CLI. `<renderer>` is `~/.claude/skills/session-story`, pinned at b432256. Never modify the renderer. `pr-story.mjs` only calls it.

## Hard rules

- Read-only on GitHub. Never post comments, submit or approve reviews, click Viewed, or push. Comments are drafted in fenced blocks for Eric to post.
- Every `gh` call runs after `unset GITHUB_TOKEN` (the scripts do this).
- Never clone octo-org repos. Read old code from a local checkout under `~/Development` (`git show <base-oid>:<path>`). If the base commit is missing, `git fetch origin <base>` is fine. If you need the PR head, fetch it into `refs/tmp/pr-N` and delete the ref when done.
- All working files go in `<scratchpad>/pr-story/<repo>-<N>/`, never in a repo. The one copy made elsewhere is the Diff Story Mode copy in `~/.diff-story/` (below).
- Name people only after looking up logins in `~/Documents/notes/github-users.md`. Times in ET.
- Verify a claim against code, CI logs or the old code before stating it. Say whether a problem was reproduced or only suspected.

## Steps

1. **Gather.** With a PR number or URL (repo from the URL, an `owner/repo` argument, or the cwd):
   ```bash
   <skill>/bin/gather.sh <number|url> [owner/repo] -o <D>
   node <skill>/bin/pr-story.mjs brief --dir <D> > <D>/brief.json
   ```
   This writes `pr.json`, `pr.diff`, `threads.json` (review threads with resolved/outdated), `checks.json`, `viewed.tsv` and `checkouts.txt` (local clones, freshest first). Read `brief.json`, not the raw diff, then read the diff and old code file by file as you plan. If `gh pr diff` fails on a huge PR, make `pr.diff` from the local checkout with `git diff <base-oid>...<head-oid>`.

2. **Plan chapters.** Tell it as a user journey unless Eric asks for chronological ("in order", "commit by commit", "how it got here"). Don't ask. **The result comes first:** each chapter tells how a user meets the code as it's built, not how it was written. History only supports that, in the backstory fields below (step 3), and never leads a narrative. Write `<D>/chapters.json`:
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
   - Tests go in the chapter of the code they test. Lockfiles and config go where they first matter.
   - `build` fails unless every PR file is in a chapter and every partial is finished somewhere.
   - **The story map goes in `overview`,** not at the top of chapter 1's `narrative`. Each `narrative` starts at its own `### Chapter N: …` heading. (The overlay moves a story map it finds before that heading to the Overview, but write it in the right place.)
   - **Backstory fields** (all optional, filled in step 3): top-level `backstory` `{summary, sessions: [{id, label}], timeline: [{at, title, asked, text, files, session, turn, agent, moment}]}`, each chapter's `backstory` `{summary, steps: [{at, text, session, turn, agent}]}`, a file entry's `backstory` `{text}` and a `lines` entry's `backstory` (a short string).
   - **Line references.** For the key hunks a chapter discusses, add 2-4 `lines` ranges to that chapter's file entries, with real line numbers read from `pr.diff` (`R` is the new side, `L` the old side for removed lines) and a short label. In the narrative, write file mentions in backticks (a path, a unique suffix or a basename) and line mentions as `` `path:40` `` or `` `path:40-58` `` (`path:L12` for an old-side line). Only lines inside the diff's hunks are on the page, so point at changed or nearby context lines.

3. **Backstory, when the commits were made in Claude Code.** Find the sessions behind the commits and fill the backstory fields from them:
   ```bash
   node <skill>/bin/pr-story.mjs backstory --dir <D>          # a PR (needs its commits in a local checkout)
   <dsm> backstory --repo <checkout> --base <ref> -o <D>/backstory.json --brief > <D>/backstory-brief.json   # local commits
   ```
   - **How it matches.** It scans `~/.claude/projects` (main and subagent transcripts) for ones that mention a checkout of the repo or a commit SHA, reads each with session-story's extractor (its CLI, `extract --no-chain`, never modified), and keeps a session only if, in the time window, it edited a file of the diff, ran a `git commit` whose subject or SHA is in the range, or ran a write-ish script on a diff file. Checks (lint, tests, builds) count only beside that work, in the checkout it happened in. Added lines are matched to the final diff for line ranges. From the raw transcripts it adds what Eric said (prompts and Larmor voice), the task and messages the main session sent each agent, and the agents' hand-back reports.
   - **Read `backstory-brief.json`,** not `backstory.json`. Each moment is one turn of one agent (or the main session) with its asks, reports, edits, commits and checks. Pass `--exclude-agent <id>` for your own agent if you ran in that session.
   - **When `found` is false** (a PR written by someone else, or commits made outside Claude Code), skip this step and write no backstory fields. Say so in one line, nothing more.
   - **What to write.** Short, plain, past tense, hedged where the transcript is thin. Quote Eric briefly (one sentence, his words). Say the decisions and their reasons, the alternatives considered, and the review rounds and checks (for example "the `++` audit found all nine safe, nothing reverted"). Times in ET. Every step carries `session` and `turn` (and `agent` for an agent's work) so the panel can link to it.
     - `backstory.summary`: 2-4 sentences for the Overview: who made it, in which session, the asks that shaped it.
     - Chapter `backstory`: a 1-3 sentence summary of how this chapter's code got its shape, then 2-4 dated steps.
     - File `backstory.text`: one or two sentences on files with a real reason behind them (a disable comment, a suspected bug left alone, a change Eric asked for). Line `backstory`: a few words on a specific line. Leave mechanical files bare; the panel falls back to the moments that touched them.
     - `backstory.timeline`: the chronological "Backstory view", one entry per moment that matters (start from `backstory.json`'s draft `timeline` and rewrite `title`, `asked` and `text`; keep `moment` so its line ranges carry over).
   - Keep it supporting: no backstory in `narrative`, no chapter longer for it. A chapter's narrative should read the same with the backstory collapsed.

4. **Render.**
   ```bash
   node <skill>/bin/pr-story.mjs build --dir <D>
   node <skill>/bin/pr-story.mjs render --dir <D> --open
   ```
   `build` writes `story.json` and `file-map.json` (file → chapters, partial_in, finished_in). `render` validates with the pinned renderer, writes `<D>/pr-story.html` with `-o`, relabels the header as a PR story and opens it. Fill in each chapter's `narrative`, `comments` and `answer` as you tell it, then build and render again without `--open` (Eric reloads the page).

5. **Tell the story,** one chapter per reply. The first reply is the story map, then chapter 1.
   - **Answer questions in place** from the diff and the code, checking the old code or CI where it matters. Stay on the chapter until he says "next".
   - **Backstory in chat:** only when he asks why or how something got here. Answer from the chapter's backstory and the brief, citing session and turn.
   - **At each chapter break,** when he says he's ticked files (or asks "did I miss any?"), run `node <skill>/bin/pr-story.mjs viewed --dir <D> --through <N> --refresh`. Report the count viewed, any `missed` files (a `DISMISSED` file was viewed and has changed since), and which partials are still held. Don't nag about files viewed ahead.
   - **Offer comments** in fenced blocks, flush left, one per thread, naming the file and line to put it on. Never post them. When Diff Story Mode is in use, also add every comment drafted in conversation (chat, voice or a panel question) to the panel: write the body to a file and run `<dsm> comment --story <id> --chapter <N> --path <file> --line <L> --body-file <f>` (no `--path`/`--line` for a general comment). It appends to the chapter's `comments` in both the published copy and `<D>/chapters.json`, so a later render keeps it, and the panel's Draft comments show it within a few seconds. Do both: the fenced block in chat and the command. Before drafting comments for a PR that already has a story, run `<dsm> drafts --story <id>`. It lists each draft as posted, pending (in Eric's unsubmitted review), dismissed or still a draft. Don't re-suggest a dismissed or posted one. Dismissals are kept per PR by the bridge, so `render` and a regenerated story keep them.

6. **Finish.** After the last chapter: every file accounted for (for example, 74 of 74 placed and 70 viewed), any still unviewed, and "Your comments, in priority order" with file and line for each. If the PR is mergeable, say whether you'd lean approve, comment or request changes, and that it's his call.

## How the story sounds

The model is Eric's 10/13 walk through api #3040 and his 9/17 web-app #6767/#6668 stories.

- **Story map first.** One short paragraph on what the PR is for, then a numbered map: each chapter's bold title and the files it covers, with the total file count.
- **Chapter shape.** `### Chapter N: title`, then "The scenario: …" in a sentence. Then numbered steps that follow what happens, with nested bullets for branches and checks. Name each file in backticks the moment the flow reaches it and say what it does in plain words.
- **Then what you checked.** Against the old code ("I compared these against the old scripts"), against prod or CI logs, against the other repo. Say what holds up.
- **Questions worth asking.** "One question worth asking" or "What to raise in this chapter", numbered, each with the reason, then the paste-ready comment. Mark nits as optional: "Not worth a comment unless you're already writing one on that file."
- **Files to mark viewed,** grouped by directory, with partials called out ("`report.ts` comes back in chapter 4, so leave it unticked until then if you'd rather") and "Still held: …".
- **Close** with "Next is chapter N, <title>." and nothing else.
- **Chronological variant.** "Short version" first, then Before, each commit with its date, each review round by reviewer, a "where it stands against your asks" table, and "things to look at before approving".
- Plain, hedged where unsure, no zingers. Draft comments in Eric's voice: short, "I think", "Could you confirm", framed by what it does to the user or the API, no names. ≈150-300 words and ≈3-8 files a chapter. Favor more, shorter chapters over long ones: split a big step by screen, interaction or layer, and don't repeat a point from an earlier chapter.
- For a merged PR, comments become follow-up notes, and say so.

## Voice mode

If Larmor voice is on, speak the chapter's `headline` and one line on what to look at, then put the full chapter on screen. Answer spoken questions briefly aloud with detail on screen. Never read paths, code or comment blocks aloud.

## Diff Story Mode: the preferred host when it's installed

Diff Story Mode (`<dsm-repo>`, an unpacked Chrome extension plus a local bridge) shows this same panel on the PR's /changes or /files page by itself. It survives reloads and in-page navigation, remembers the step per PR, and picks up each re-render within ≈5s. When it's installed and its bridge is running, use it instead of injecting the overlay with `javascript_tool`.

1. **Check the bridge.** `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(jq -r .token ~/.diff-story/config.json)" "http://127.0.0.1:$(jq -r .port ~/.diff-story/config.json)/api/health"` prints 200 when it's up. If it isn't, ask Eric once whether to start it (`<dsm> serve`, as a background task) or use the overlay below.
2. **Publish.** `render` copies `chapters.json`, `file-map.json` and `backstory.json` to `~/.diff-story/<owner>-<repo>-<N>/` with a `meta.json` (`publish --dir <D>` does just that step, `--no-bridge` skips it). The bridge also reads the scratch folders directly. The chat reply for a step is one line, as in GitHub mode.
3. **Questions from the panel.** The panel's Ask box appends to `~/.diff-story/inbox.jsonl`. While telling the story, keep `<dsm> wait --consumer pr-story` running as a background task. When it exits it has printed a question (id, chapter, file, text). Answer it in chat as usual, also run `<dsm> answer --question <id> --file <answer.md>` so the answer shows under the question in the panel, then start the wait again. The wait also returns `build_request` lines: Eric clicked "Build story" on a PR that has none. Tell him in one line, and run this skill on that URL if he says so (or he already asked for it in this session). `render` publishes the story, and the bridge then marks the request done and the page opens the panel by itself. If it can't be built, `<dsm> done <id> --failed --note "…"`. `<dsm> builds` lists pending requests. A request with `mode: 'update'` means the story is out of date: follow "Updating a story" below. The new `head_oid` finishes the request.
4. **Where he is.** `~/.diff-story/state/<story id>/position.json` has the step and the file at the top of his screen, and the inbox has a `position` line each time it changes. Use it when he says "this one" or "here".
5. **Local commits.** For a story about commits that aren't pushed, `<dsm> local --repo <checkout> --base <ref> --head HEAD --chapters <D>/chapters.json --backstory <D>/backstory.json --no-open` serves the same chapters over the local diff at `http://127.0.0.1:<port>/local/<id>/` and opens it. Viewed toggles and "fix before push" notes there are kept by the bridge (`<dsm> notes --story <id>`), and comments in `chapters.json` show as "Fix before push". Place every file, as for a PR. Any that aren't placed land in a last "Not in a chapter yet" step.

6. **Backstory in the panel.** Each chapter shows its narrative first, then a collapsed "Backstory" section. File rows with a backstory (their own, or moments that touched them) get a small "why" link that expands under the row. The Overview has the summary and the sessions, and a small "Backstory view" link switches the whole panel to the timeline, one step per moment with the diff filtered to its files. The journey story is always the default. The view is remembered per story only after Eric switches it. Clicking a session chip copies `claude --resume <id>`.

The extension keeps the overlay's rules, with one addition: a click on a file or line link in its panel may click GitHub's expand controls to open the target. It never clicks Viewed, comment or review controls, submits nothing, and talks only to the bridge on 127.0.0.1. Hiding the panel (its × or the toolbar button) is remembered per PR.

### Updating a story: "Since you read it"

An update request (`mode: 'update'`) carries `base_sha` (the commit the story was told from), `since_sha` (where Eric's reading stopped: the story head he read his earliest chapter at, from the bridge's `state/pr-<owner>-<repo>-<N>/read.json`, or `base_sha` when he read none) and `reads` (each chapter he read, its commit and when). `<dsm> builds --json` shows the same. The default is an addendum, not a re-tell:

1. Gather again into the same `<D>`, so `pr.json` has the new head. Read `git log --oneline <since_sha>..<new head>` and `git diff <since_sha>..<new head>` in the local checkout (fetch the head into `refs/tmp/pr-<N>` if it's missing).
2. Write one new chapter for just those commits and put it **first** in `chapters`:
   ```json
   {"key": "since-<since7>-<head7>", "title": "Since you read it: N new commits",
    "since": {"from": "<since_sha, full>", "to": "<new head, full>", "commits": N},
    "headline": "…", "scenario": "…", "summary": "…", "narrative": "### Since you read it\n\n…",
    "files": ["every file git diff --name-only <since_sha>..<new head> lists"], "comments": []}
   ```
   - Its `files` are exactly the files those commits touched, so the panel's filter shows only them, and it marks them "Mark viewed" here.
   - The narrative says what the new commits do (one step per commit, or per coherent group), which review threads they answer, and what to check. Same voice and length as a chapter. Name files and lines as usual, with line numbers from the new head. Link GitHub's diff of just these commits, `[these N commits on GitHub](<pr url>/files/<since_sha>..<new head>)`, with full SHAs (`/changes/<a>..<b>` works too, but redirects to `/files/` when logged out). The panel adds the same link.
   - Draft comments about the new commits go on this chapter.
3. **Keep every earlier chapter as it is,** byte for byte: title (with its "Chapter N:"), `key`, narrative, files, lines and comments. Don't renumber them. The panel doesn't number "Since you read it" chapters, so the old chapters keep the numbers Eric read them with, and their "comes back in chapter N" lines stay right. Only two things change: a file the new commits deleted or renamed leaves its old chapter (it's in the new one), and a file they added goes only in the new one. Old line ranges may now be a few lines off, and the panel jumps to the nearest shown line, so leave them.
4. An earlier "Since you read it" chapter stays where it is, after the new one.
5. `build`, `render`, and say in one line which commits the new chapter covers.

**Re-tell from scratch** instead when the request has `retell: true` (Eric clicked "Re-tell from scratch"), when `git merge-base --is-ancestor <since_sha> <new head>` fails (a rebase or force-push), or when the new commits rework most of the PR. Plan it as a new story (steps 2 to 4). The bridge keeps the drafts' posted and dismissed marks per PR, so they carry over. Say in one line why it was re-told.

## GitHub mode: the story on the PR page (default in GitHub)

When Eric reviews in GitHub, the chapter and the PR live on one page. `overlay` prints a JS snippet that, run in his PR tab, docks the story in a resizable side panel and filters the diff. It follows GitHub's light or dark theme. Q&A happens by voice or in the terminal chat. He ticks Viewed himself. A reload removes the overlay.

- **Steps.** Step 0 is the Overview: the `overview` markdown (or `summary` and `plan`), every file with its chapters, and no filter. Then one step per chapter. Prev/next and the Steps list only re-filter, since every chapter's text is in the snippet.
- **A chapter step** shows the narrative, the draft comments with Copy buttons and "Files in this chapter", and hides every other chapter's files and file-tree rows with `display:none` ("show all files" undoes it).
- **Jumps.** Backticked file names in the narrative, the file list and the comment headers scroll the page to that file's diff. `path:40-58` mentions, `lines` entries and comment lines scroll to the line and highlight the range. A name matches a file on screen in that step, and an ambiguous one goes to the first match in chapter order. In Diff Story Mode, clicking a file or line link opens a collapsed file (Viewed files collapse) with its own expand toggle and clicks GitHub's hunk expanders until the line is on the page, without unmarking Viewed or dropping `?w=1`. Only that click expands anything. The injected snippet doesn't expand: if a line isn't in the shown hunks it jumps to the nearest shown line and says so, and if the file is collapsed it says to expand it in GitHub.
- **What to tick.** Each file says "Mark viewed", "Leave unviewed: comes back in chapter N (…)" or "Already finished in chapter N", from the same placement rules as `file-map.json`. The first mention in the narrative carries a small pill with the same status. "✓ viewed" shows when the page's own Viewed toggle is on, read from the DOM and never clicked.

The snippet makes no network calls, never clicks GitHub controls (Viewed, expand, comment, review, approve, resolve), submits nothing and opens no dialogs. Never add any of that to it. Diff Story Mode's panel may click GitHub's expand controls (a file's expand toggle, Load diff, hunk expanders), and only when Eric clicks a file or line link in it. It never clicks Viewed, comment, review, approve or resolve.

1. Load the claude-in-chrome tools in one ToolSearch call: `tabs_context_mcp`, `javascript_tool`, `get_page_text`, `navigate`, `browser_batch`.
2. Once: `tabs_context_mcp` to find his PR tab and keep that tab ID. If he already has the PR open, use that tab and don't navigate it. Otherwise navigate to `<pr url>/changes`. Leave the tab open at the end.
3. Write `overview`, each chapter's `narrative`, `comments` and `lines` into `chapters.json` before injecting, since the panel shows exactly what's there. The chat reply for a step is then one line ("Chapter 2 is up in the panel: …" plus its headline), not the chapter text.
4. Inject: `node <skill>/bin/pr-story.mjs overlay --dir <D> --out <D>/overlay.js` (starts at the Overview, or `--chapter N`), then pass that file's contents as `javascript_tool` text. It returns how many of the step's files it found on the page. Re-inject (it replaces itself) after editing the story. To re-run newer `overlay.js` code on the data already in the page, define `prStoryOverlay` again and call `prStoryOverlay(window.__prStoryOverlay.data)`.
5. Check with `get_page_text` when it matters: only the chapter's files should appear. If the count is short, GitHub may not have loaded those diffs yet (the panel says how many), and scrolling or a moment's wait fixes it.
6. Viewed state for the chapter-break check comes from the API (`viewed --refresh`), as in step 5 of the main flow.

**How it finds files.** On `/changes` each file is `[role=region][id="diff-<sha256 of path>"]` (its one-child wrapper is what gets hidden), a line is `[data-line-anchor="diff-<sha>R<n>"]` (`L<n>` for removed lines), the Viewed toggle is a header `button[aria-pressed]` reading "Viewed", and file-tree rows are `[role=treeitem]` whose `id` is the path. Classic `/files` uses `copilot-diff-entry[data-file-path]` or `.file[data-tagsearch-path]` and `file-tree` rows linking `#diff-<sha>`. If none of those match, it falls back to a header whose text is the path. A MutationObserver re-filters as GitHub lazy-loads diffs. GitHub's DOM changes without notice, so if the panel says 0 files found, read the page's DOM, fix the selectors in `bin/overlay.js` and re-inject.

`links --dir <D> --chapter <N>` still prints per-file `/changes#diff-<sha>` URLs, and `handoff` still writes `<D>/chapter-N.md` for the Chrome side panel, for when he asks for them.

Before driving Eric's Chrome for the first time in a session, say so in one line, since he sees it happen.

## Files

- `bin/gather.sh`: read-only `gh` fetch into the scratch folder.
- `bin/viewed.sh`: Eric's viewed state per file (GraphQL `viewerViewedState`).
- `bin/pr-story.mjs`: `brief`, `build`, `render`, `viewed`, `links`, `handoff`, `overlay`, `publish`, `backstory`.
- `bin/overlay.js`: the GitHub overlay that `overlay` wraps with the story data. It doesn't show backstory; Diff Story Mode does. Diff Story Mode's `src/js/shared/overlay.js` is a port of it (module export, shadow DOM, saved step, Ask box), so carry selector fixes across.
