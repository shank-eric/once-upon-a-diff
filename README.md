# Diff Story Mode

New here? [GETTING-STARTED.md](GETTING-STARTED.md) walks you through setup and your first story.

A code-review story (an overview, then chapters) in a side panel docked on top of a diff, with the diff filtered to each chapter's files. It works in two places:

- **GitHub PRs.** An unpacked Chrome extension docks the panel on a pull request's `/changes` or `/files` page whenever a story exists for that PR.
- **Local commits.** The bridge serves its own diff page for a local commit range, before anything is pushed, and the same panel runs on it.

The two work the same way and read the same `chapters.json` (pr-story's format). The panel comes back on the same step after a reload, after GitHub's in-page navigation, and when the story on disk changes.

The panel is a port of the pr-story skill's GitHub overlay (`skills/pr-story/bin/overlay.js`). It has the same Overview step, the same per-file "Mark viewed / Leave unviewed: comes back in chapter N / Already finished" status, and the same file and line jumps. It adds a saved step, an Ask box, and a shadow root so the page's CSS can't reach it.

## Installing

You need Node 20 or newer. The bridge has no runtime dependencies. `yarn install` only fetches eslint, playwright-core and highlight.js (vendored into `bridge/public/vendor/`) for development.

1. Print the bridge's port and token. This also creates `~/.diff-story/config.json` with a random token:
   ```bash
   node bridge/bin/diff-story.mjs setup
   ```
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this repo's `src/` folder.
3. The options page opens on install. If it doesn't, go to Details → Extension options. Paste the port and token, then click **Save** and **Test connection**.
4. Start the bridge and leave it running:
   ```bash
   node bridge/bin/diff-story.mjs serve     # or: yarn bridge
   ```
5. Install the `diff-story-listen` Claude Code skill by linking it into your skills folder. If `~/.claude/skills` is itself a link, `ln` puts it in the folder the link points at, which is what you want:
   ```bash
   ln -s "$PWD/skills/diff-story-listen" ~/.claude/skills/diff-story-listen
   ```
   Start a new Claude Code session to pick it up. See [Listening from Claude Code](#listening-from-claude-code).
6. Install the `pr-story` skill the same way. It builds the PR stories the listener is asked for, and finds this repo through the link:
   ```bash
   ln -s "$PWD/skills/pr-story" ~/.claude/skills/pr-story
   ```
   Its `render` step needs [session-story](https://github.com/nalaj/session-story), pinned at `b432256`, at `~/.claude/skills/session-story` (or `SESSION_STORY_DIR`).

An alias saves typing: `alias diff-story="node ~/Development/SideProjects/diff-story-mode/bridge/bin/diff-story.mjs"`. The rest of this README uses `diff-story`.

## Is it set up?

There are two quick ways to check.

**The light in the panel header.** It's the dot left of "Hide story". Hover it for a summary, or click it for details and fixes.

- **Green:** the bridge is reachable and accepts the token, the story was found, and a Claude session is listening for questions.
- **Amber:** everything works, but no Claude session is listening for this page's repo. The Ask box still queues questions and says they'll wait. Listeners are per repo: a session that runs `diff-story wait --repo owner/name` takes questions and build requests for that repo's stories and PRs, and nothing else. A wait with no `--repo` takes everything, and `--story <id>` still works for one story. Under the Ask box, and beside **Build story**, **Copy prompt for Claude** copies one line, `/diff-story-listen owner/name`, for the diff-story-listen skill. The page says which checkout to start Claude Code in when the bridge knows one, and **show details** (or the button's hover) gives the long form for a session without the skill. The bridge learns a repo's checkout from local stories and from where `wait --repo` was run (`~/.diff-story/checkouts.json`), and otherwise looks for `~/Development/<name>` with that origin.
- **Red:** the bridge is down, too old for the panel, or rejects the token.

The details also say whether autoBuild or autoAnswer is on.

"Listening" is a heartbeat. `diff-story wait` writes `~/.diff-story/listeners/<consumer>.json` every ≈5s, and a beat under 15s old from a live process counts. After `wait` hands a question over, the listener counts for up to 10 minutes as "answering", until the session starts the next wait.

**`diff-story doctor`.** It prints PASS, WARN or FAIL for each of these, with a fix for anything that isn't passing:

- the config and token
- the bridge process and port, and whether the bridge accepts the token
- when the extension last talked to the bridge (the bridge notes it)
- the story root and the stories it can serve
- live listeners and pending build requests
- the autoBuild and autoAnswer settings, and whether their commands are on `PATH`
- the tail of `~/.diff-story/bridge.log`

It exits 1 when something fails.

## Listening from Claude Code

`skills/diff-story-listen/SKILL.md` is a Claude Code skill that makes a session one repo's listener. Open Claude Code in the repo's checkout and type, or paste from **Copy prompt for Claude**:

```
/diff-story-listen EverFi/furnace
```

`/diff-story-listen --story <id>` listens for one story, for a local story with no GitHub origin. The session then:

1. Finds the CLI: `diff-story` on `PATH`, else `node <repo>/bridge/bin/diff-story.mjs`, with `<repo>` from the `DIFF_STORY_MODE` env var, `repo_dir` in `~/.diff-story/config.json` (both read only by the skill), or the folder the skill is linked from.
2. Runs `diff-story doctor`, and says how to start the bridge if it's down.
3. Runs `diff-story wait --repo EverFi/furnace --type question,build_request --consumer repo-everfi-furnace` as a background task, which keeps the light green for every story and PR in that repo. It starts the wait again after each event.
4. Answers each Ask-box question from the story's chapters and the code in the checkout, briefly, with `diff-story answer`.
5. Claims each Build story request with `diff-story builds --start <id>` (the badge says Building), builds and publishes the story with the pr-story skill, and finishes it with `diff-story done <id>`. An update gets a "Since you read it" chapter, unless it asks for a re-tell.
6. Stops when you say so.

It never posts to GitHub, marks files viewed or pushes. Comments it drafts go to the panel's Draft comments only. Run one listener per repo, each in its own session.

## Using it on a PR

1. Make a story with the pr-story skill. Its `render` step copies `chapters.json` and `file-map.json` to `~/.diff-story/<owner>-<repo>-<N>/`, and you can also run `pr-story.mjs publish --dir <D>`. The bridge also reads pr-story's scratch folders directly.
2. Open the PR's **Files changed** tab. The panel docks on the right at the Overview step.
3. Prev and Next (or the Steps list) filter the diff to a chapter. "Show all files" undoes the filter.
4. To hide the panel, use **Hide story** (it collapses to a strip) or **×** (it goes away and that's remembered for the PR). The toolbar button or **Alt+Shift+S** shows or hides it.
5. **Hide whitespace is remembered.** It's the same setting as the local page's (`prefs.json` through the bridge, with a copy in `chrome.storage` for when the bridge is down). When it's on, opening a PR's Files changed page without `?w=` reloads it once with `?w=1`, keeping the hash and the panel's step. Turning GitHub's own whitespace setting on or off there (`w=1`, `w=0`, or `w=1` dropping off the same page) saves the new choice. If GitHub drops the `w=1` it was sent, the page isn't reloaded again for 15 seconds, so it can't loop.
6. Type a question in the Ask box and press **Cmd+Enter**. The question goes to the bridge inbox, and the answer shows under it once a Claude session replies (see [Q&A relay](#qa-relay)).

**File and line links open what they point at.** Clicking a file name or a `path:40-58` line link in the panel scrolls to it and highlights it. If GitHub has the file collapsed (Viewed files and large ones collapse), the click expands it with the file's own toggle, or **Load diff**, and expanding never unmarks Viewed. For a line outside the hunks GitHub drew, it clicks GitHub's expand arrows above or below the hunk until the line is on the page (or **Expand all lines** when the line is far away), on `/changes` and classic `/files` alike. GitHub fetches those lines with the page's own settings, so `?w=1` stays and nothing reloads. This happens only when you click a link: changing steps, reloads and redraws never expand anything, and the panel never clicks Viewed, comment or review controls. A line that isn't in the file at all jumps to the nearest drawn line and says so.

When Claude rewrites `chapters.json`, the panel redraws within ≈5 seconds, or as soon as you come back to the tab. It keeps its step and its scroll position.

**Posted, pending and dismissed drafts.** Each draft comment shows what's become of it. There are four states:

- **Posted ✓**, with a link to the posted comment. These are hidden by default behind "Show posted (N)".
- **In your pending review**, for a comment in a review you haven't submitted yet. These stay visible, marked as not submitted.
- **Dismissed**, for a draft you don't want. Dismiss hides it behind "Show dismissed (N)", and Restore brings it back.
- **A draft**, with **Mark posted** and **Dismiss** buttons, and on a line comment **Add to my review** (on the local page, **Add to fix before push**).

**Add to my review** puts a line draft into your pending review on GitHub, starting one if you have none. It never submits the review. GitHub doesn't redraw an open Files changed page for that, so the draft switches to "In your pending review" with the file and line, a jump link, "GitHub shows it after a reload" and a **Reload page** button. The page only reloads when you click it, and the panel comes back on the same step. The bridge keeps this state in `drafts.json`, so it lasts through re-renders, reloads and bridge restarts. Once gh finds the comment after a reload, or it shows up on the page, it becomes the usual pending (or posted) row. If GitHub refuses, the error shows on the draft and its buttons stay. A draft that's already in your review can't be added twice.

**Add to fix before push** is the local page's counterpart. It makes a line draft a real fix-before-push note on that file and line, through the bridge's notes API, so it's in the page's checklist and in `diff-story notes`. The draft then says "In fix before push" (with "done ✓" once you tick the note) and a jump to the line. A draft that's already a note can't be added twice.

The chapter's comments heading counts each state, for example "(2 to post · 1 posted · 1 pending)".

The Overview lists every chapter's drafted comments in one place, grouped by chapter, each with its file:line, its state (draft, in your pending review, posted, dismissed or may be out of date) and the same buttons it has in its chapter. A chapter's name jumps to it. The list starts open with up to 4 drafts and folded with more. The local page does the same for its "Fix before push (drafted)" items.

How the bridge decides:

- **Posted and pending come from GitHub.** The bridge reads your own comments with read-only `gh api` GETs, with `GITHUB_TOKEN` unset so the keychain login is used, and caches them for 60s. It reads the PR's review comments, its reviews (a PENDING one is your unsubmitted review, read along with its comments) and its general comments.
- **Matching is fuzzy, because you often edit a draft before posting.** A draft matches a comment of yours on the same file within 3 lines, or a general draft a general comment, when the text is at least 0.75 similar.
- **Your own calls override it.** Mark posted, Unmark, Dismiss and Add to my review are kept by the bridge per PR, in `~/.diff-story/state/pr-<owner>-<repo>-<N>/drafts.json`. Re-renders and regenerated stories keep them, and a dismissed comment matched by path, line and text isn't suggested again.
- **Local mode has only the manual buttons.**
- `diff-story drafts --story <id>` lists every draft's state.

Add to my review is the only write to GitHub. Everything else here is read-only.

**Comments drafted in Q&A** go into the panel's Draft comments, whether they come from chat, voice or the Ask box. To add one, run `diff-story comment --story <id> --chapter N --path <file> --line L --body-file <f>`, or `POST /api/stories/:id/comments`. It appends to that chapter's `comments` in `chapters.json`, both in the copy the bridge serves and in its pr-story source folder, so the next render keeps it. Adding the same comment twice keeps one copy. Nothing is posted to GitHub.

**Viewed progress.** Each chapter's header says how many of its "Mark viewed" files are ticked, for example "3 of 4 marked viewed · still to mark: a.tsx". The file names are jump links, and the line changes to "✓ All 4 marked viewed" when you're done. Files that come back in a later chapter, or were finished in an earlier one, don't count against it. The Steps list shows each chapter's count, or ✓ when it's complete. The Overview shows the overall count.

The panel reads each file's state from the page's own Viewed toggle, and never clicks it:

- on GitHub, the header toggle's `aria-pressed` (or the checkbox on classic `/files`)
- on the local page, the bridge-kept toggle

It looks again after any click or change on the page, so Refined GitHub's batch mark-viewed helpers are picked up too. Moving on with files left gives a gentle note, not a block. The "Files in this chapter" list starts folded, with a one-line summary ("6 files · 4 to mark viewed · 2 come back later"). Whether it's open is remembered per story.

**Where "Mark viewed" goes.** A file is marked viewed in the last chapter that tells it. A chapter tells a file by listing it, or by pointing at its lines in its text: `path:45`, `path:40-58`, a bare `:45` after the file is named, or a link to the file's diff with a line anchor. A file a chapter points at without listing it joins that chapter's file list (and its filter) as a partial entry, "its lines are pointed at in the text", with those lines. A name with no line doesn't count, and neither does anything in a code block. Every earlier chapter says "Leave unviewed: comes back in chapter N", whether or not that listing is flagged partial. The viewed progress and the "viewed early" warning follow the same rule, and so does pr-story's `file-map.json` (`finished_in`).

In its finishing chapter a file's tag says **Mark viewed** until its Viewed toggle (GitHub's or the local page's) is on, then **Viewed ✓**, muted. It follows the toggle live, and so does the small status pill in the chapter's text. That pill sits on the file's last mention in the chapter, in reading order (often the closing "Files to mark viewed" line), so you tick it once the chapter is done with it. When the chapter mentions the file more than once, its first mention carries a quiet "more below" instead, and the mentions between carry nothing.

**On PR lists and a PR's Conversation tab.** A repo's `/pulls`, the global `/pulls` and PR search results get one tag after each PR's title, and a PR's Conversation tab gets the same tag next to its title. The tag is the control:

- **Story** opens the PR's Files changed tab, where the panel docks. Once you've read some of it, it says **Story · 2 of 5 read** and opens on the first chapter you haven't read (Files changed`#dsm-step-N`). Once you've read every chapter, it's a muted **Read**.
- **Read · 3 new commits · Update** (or "2 of 5 read · …") means you've read the story and the PR has moved on. Update asks for a "Since you read it" chapter, and the small **Re-tell** beside it asks for a new story.
- **Build story** sends the same build request as the PR page's button.
- **Story out of date · Update**, on a story you haven't read, asks for an update to the PR's latest commit: a "Since you read it" chapter for the new commits (see [Since you read it](#since-you-read-it)). The small **Re-tell** beside it asks for a whole new story instead.
- **Queued** means a story was asked for and no Claude session has taken it yet. **Building…** means a session has claimed it. Neither can be clicked. An update shows as **Update queued** or **Updating…**.

When no session is listening for a repo on the page, one notice at the bottom right says "No session listening for owner/name", with **Copy prompt for Claude** and, when the bridge knows one, the checkout to start Claude Code in. It's said once for the page, not on each row.

The page makes one batched lookup (`POST /api/stories/status-many`, cached 5s), and the tags come back after GitHub or Refined GitHub redraws the list or the PR header. While a tag says Queued or Building…, the page looks again every 15s. With no bridge running, the list stays as GitHub draws it.

**What you've read.** The panel records a chapter as read when you leave it after 30 seconds on it (counted only while the tab is showing, and switching tabs counts as leaving), or when you tick the last of its files viewed there. Each record is kept per PR in `~/.diff-story/state/pr-<owner>-<repo>-<N>/read.json` as `{<chapter key>: {head_sha, story_head, at, reason}}`, and goes to the inbox as a `read` line. `head_sha` is the PR's head at the time: the panel sends the one it got from the freshness check, and the bridge asks gh (read-only) when it doesn't have one. `story_head` is the commit the story was told from, which is the same unless the story was already out of date. A local story records its range's head commit. A chapter's key is its `key` in `chapters.json`, or else its title without "Chapter N:", so a chapter put in front of it doesn't change it. `GET /api/stories/:id/read` lists them.

**Is the story up to date?** A story records the PR head it was told from: pr-story's `pr.json` `headRefOid`, copied into `meta.json` as `head_oid`. The bridge reads the PR's current head and compares the two with read-only `gh api` calls, cached for 60s.

- When they match, the panel header says "Up to date with abc1234".
- When they don't, it says "Story is for abc1234; the PR has N newer commits", with the files changed since and the chapters that list them. Those files get "changed since story" in the files list, and those chapters a mark in the Steps list.
- **Update (new commits)** sends a build request with `mode: 'update'` and the old head (`base_sha`). **Re-tell from scratch** sends the same with `retell: true`, for a rebase or a big rework (the panel suggests it when the PR was rebased). While no session has taken it, clicking the other one switches it. It stays pending until the story's head moves.
- PR-list and Conversation tags say "Story out of date · Update" with a small "Re-tell", then "Update queued" or "Updating…".

### Since you read it

When a PR gets a few new commits after you've read its story, an update adds one chapter instead of telling the whole story again:

- The bridge works out where your reading stopped: the commit you read your earliest chapter at (from `read.json`, above), counting only reads after the newest "Since you read it" chapter you read, since that one caught you up. With nothing read, it's the commit the story was told from. The build request carries it as `since_sha`, with `since_source` (`read` or `story`), the `reads` and the story id. `diff-story builds` prints it under each update ("update: "Since you read it" from abc1234 (where his reading stopped; 3 chapters read)"), `builds --json` and `wait --json` include the fields, and the inbox line's text says what to write.
- The pr-story skill writes one chapter for `since_sha..` the PR's head, puts it first, and keeps the other chapters as they were. It has `since: {from, to, commits}` in `chapters.json` and lists the files those commits touched.
- The panel doesn't number "Since you read it" chapters. The Steps list shows them as **New**, and the chapters after them keep the numbers you read them with, so their "comes back in chapter N" lines still hold. A file a "Since you read it" chapter lists is marked viewed there (the newest one wins), since you've read the chapters after it. Its other chapters say "Already finished in “Since you read it”". pr-story's `file-map.json` follows the same rule.
- On a PR, a "Since you read it" chapter starts with which commits it covers and a link to GitHub's diff of just those commits, `/pull/N/files/<from>..<to>`. That form loads logged in or out, and `/changes/<from>..<to>` redirects to it when logged out (checked on a public PR on 2026-10-21). On that page the panel opens on the chapter, once per page load, and the chapter's filter shows only the files those commits touched. A link back to all of the PR's changes replaces it there.
- **Changed since you read.** A chapter you read whose files a newer commit changed gets "• changed since you read" in the Steps list, and those files get the same mark in its files list. A drafted comment there whose line a newer commit changed says "May be out of date". The bridge compares the commit you read each chapter at with the story's head, once per commit (gh's compare, read-only and cached 60s, or git for a local story), and `GET /api/stories/:id/read` returns them as `changed` and `stale_comments`. "Since you read it" chapters and chapters you haven't read aren't marked.
- A rebase past `since_sha`, or a request with `retell`, gets a new story from scratch. Drafts' posted and dismissed marks are kept per PR either way.

### Story ready, Building, Build story

Every PR Files changed page gets a small status control in the bottom-right corner, shown whenever the panel isn't:

- **Story ready · Read it** opens the panel. You see it when a story exists and the panel is hidden.
- **Story queued · asked 5:44 PM** means someone asked for a story and no session has taken it yet. It says when no session is listening for the repo, with **Copy prompt for Claude**. **Building story** means a session claimed it: `diff-story wait` claims each request it hands over, and `diff-story builds --start <id>` claims it or refreshes the claim. A claim with no refresh for 30 minutes goes back to Queued, and the next wait hands it out again. While a request is queued or building, the page asks the bridge every ≈10 seconds, and when the story turns up the panel opens by itself. That's the only polling a page without a story does.
- **No story yet · Build story** asks for one. The extension sends `{repo, number, url, requested_at}` to the bridge, which appends a `build_request` line to the inbox and keeps a pending marker in `~/.diff-story/builds.json`. Every tab on that PR then shows it as queued.

A Claude session fulfils the request. `diff-story wait` hands it build requests from `builds.json`, oldest first, whenever they were asked, so a listener started after the request still gets it. Each request goes to one listener at a time. `diff-story builds` lists the pending ones as queued or building. The session writes the story with the pr-story skill, whose `render` publishes it. The request then counts as done as soon as the bridge sees the story, or the session can say so with `diff-story done <id>` (`--failed --note "…"` if it can't be done). The × on the control hides it until the page reloads. The control is the extension's own button in its own shadow root, and it never clicks anything of GitHub's.

**autoAnswer (off).** Like autoBuild, this is a bridge setting that's off unless `config.json` turns it on. When it's on, each new question runs a command, and whatever the command prints on stdout (exit 0) becomes the answer in the panel:

```json
"autoAnswer": { "enabled": true, "command": ["claude", "-p", "Answer this code-review question in a few sentences, using the story and diff in {context}: {question}"], "timeout_s": 600 }
```

Like autoBuild, the command is an argv array and is never run through a shell. `{question}`, `{context}`, `{story}` and `{id}` in its arguments are replaced. `{context}` is a JSON file with the story's overview, the asked-about chapter's narrative, files and drafted comments, and that chapter's diff when the bridge has one. Logs go to `~/.diff-story/answers/`. It's off for the same reason as autoBuild: it runs Claude without anyone at the keyboard. Whether to turn it on is Eric's call. With autoAnswer on and no listener, the light still counts questions as handled.

**autoBuild (off).** The bridge can run a command for each new request itself. It's off unless `~/.diff-story/config.json` turns it on:

```json
"autoBuild": { "enabled": true, "command": ["claude", "-p", "/pr-story {url}"], "cwd": "~/Development" }
```

The command is an argv array and is never run through a shell. `{url}`, `{repo}` and `{number}` in its arguments are replaced. The values are also in `DIFF_STORY_URL`, `DIFF_STORY_REPO`, `DIFF_STORY_NUMBER` and `DIFF_STORY_BUILD`. Output goes to `~/.diff-story/builds/<id>.log`, and a non-zero exit marks the request failed. Restart the bridge after changing it. It's left off because it runs a Claude session without anyone at the keyboard. Whether that's wanted, and with what permissions, is Eric's call.

## Local mode: commits before you push

```bash
diff-story local --repo ~/Development/everfi-frontend-worktrees/no-useless-assignment --base 3a669da7625 --head HEAD --chapters chapters.json
```

This builds `git diff <base> <head>` into `~/.diff-story/local-<repo>-<branch>/`. If no bridge is running, it starts one, then opens `http://127.0.0.1:<port>/local/<id>/`. The page draws the diff with the same DOM shapes as GitHub's `/changes` page, so the same panel code runs on it unchanged.

- **Viewed** toggles are kept by the bridge. A file whose diff changes after you marked it shows as "changed since viewed" and is unviewed again.
- **Comments become "fix before push" notes.** Click a line number to add a note. Notes are listed under "Fix before push" at the top, can be ticked done, and go to the inbox. `diff-story notes --story <id>` prints them as a checklist. Comments drafted in `chapters.json` show in the panel as "Fix before push (drafted)".
- **The page follows the branch.** Amend or add a commit and the page redraws with the new diff within ≈5 seconds.
- **Unified / Split**, in the page header, switches between one column and GitHub's side-by-side view, with old lines on the left and new on the right, lined up. Line numbers on either side take notes, and line jumps, Viewed and the panel work the same in both. It's saved in `prefs.json` too, so it holds for every local story.
- **Syntax highlighting** colors the diff in both views, picked by file extension: TypeScript and TSX, JavaScript, JSON, Ruby and ERB, YAML, CSS and SCSS, Markdown, shell, and HTML/XML. Each hunk's old and new sides are highlighted as whole pieces of code, so a template string or block comment that runs over several lines is colored right. A hunk that starts partway into a comment can still come out wrong. Files over 3,000 diff lines, minified lines and anything past 20,000 lines on a page stay plain, so big diffs stay quick. highlight.js is vendored in `bridge/public/vendor/` (`yarn vendor` remakes it from the pinned dev dependency), so the bridge still has no runtime dependencies and the page loads nothing from a CDN.
- **Hide whitespace**, in the page header, draws the diff with `git diff -w`, like GitHub's setting of the same name. Unlike GitHub's, it's remembered: the bridge keeps it in `~/.diff-story/prefs.json`, so it holds for every local story and across reloads and bridge restarts. A file whose only changes are whitespace stays listed, marked "whitespace only". Viewed marks and "changed since viewed" are always checked against the full diff, so turning it on or off never flips them. A whitespace-only edit after you mark a file viewed still counts as a change. A note or a story line on a line the `-w` diff doesn't draw sits at the top of its file (notes say so), or the panel jumps to the nearest drawn line.
- **A chapter shows its own lines.** When chapters that share a file give `lines` ranges, each chapter folds the lines another chapter tells behind a row that says which chapter (**Show** opens it, and a link to one of its lines opens it too, along with the file if it's folded). Lines no range covers show in the first chapter that lists the file. A chapter that lists the file without ranges, the Overview and **Show all files** draw all of it. GitHub's page can't be redrawn this way, so there the panel filters by file only.
- Without `--chapters`, you get one chapter per top-level folder as a starting point. Any file a story doesn't place lands in a last "Not in a chapter yet" step, so nothing is hidden from every step.

## Backstory: how it got here

The story leads with the result: how a user meets the code. When the commits were made in Claude Code sessions, the panel can also show how they got that way, kept short and collapsed:

- Each chapter shows its narrative first, then a collapsed **Backstory** section with a short summary and dated steps.
- File rows get a small **why** link that expands that file's "How it got here", including notes on specific lines.
- The Overview has the backstory summary and the sessions it came from.
- A small **Backstory view** link switches the whole panel to the chronological telling: one step per moment of work (what was asked, what changed, the checks), with the diff filtered to that step's files. **Back to the story** returns. The journey story is the default, and the view is remembered per story only after you switch it.
- A session chip (`session d5c52a31 · turn 7 · agent`) copies `claude --resume <id>`.

To find the sessions behind a commit range:

```bash
diff-story backstory --repo <checkout> --base <ref> [--head HEAD] -o backstory.json --brief > backstory-brief.json
diff-story local --repo <checkout> --base <ref> --chapters chapters.json --backstory backstory.json
```

It scans `~/.claude/projects` (main and subagent transcripts) for ones that mention a checkout of the repo (any worktree) or a commit SHA in the range, then reads each candidate with [session-story](https://github.com/nalaj/session-story)'s extractor through its CLI (`story.mjs extract --no-chain`, `~/.claude/skills/session-story` or `SESSION_STORY_DIR`). A session counts only if, in the commits' time window, it edited a file of the diff, ran a `git commit` whose subject or printed SHA is in the range, or ran a write-ish script naming a diff file. Lint, test and build runs count only beside that work and only in the checkout where it happened. Each edit's and commit's added lines are found in the final diff, which gives line ranges. A session whose turns were started by messages from another Claude Code session counts too: those messages are meta records the extractor skips, so it reads a scratch copy where they're prompts. From the raw transcripts it also takes what was said (prompts, Larmor voice, those messages), the task and messages the main session sent each agent, and the agents' hand-back reports. With no match (a PR someone else wrote, say) it writes `found: false` and the story has no backstory.

`backstory.json` holds the evidence and a draft `timeline`. The story writer (the pr-story skill) puts the real text in `chapters.json`: a top-level `backstory` (`summary`, `sessions`, `timeline`), each chapter's `backstory` (`summary`, `steps`), a file entry's `backstory.text` and a line's `backstory`. When `chapters.json` has no timeline, the bridge uses the draft.

## Story folders

Stories live in the repo they're about, in a hidden `.diff-story/` folder in its local checkout. Git ignores that folder through the checkout's `.git/info/exclude`, which is local and never committed. So there's no `.gitignore` change, `git status` stays clean, and `git add .` can't pick it up. A worktree shares its repo's exclude file.

```
<checkout or worktree>/.diff-story/
  local-<repo>-<branch>/            chapters.json, meta.json, local.diff      (from diff-story local, in the worktree it diffs)
  <owner>-<repo>-<N>/               chapters.json, file-map.json, meta.json   (a PR story, in the repo's main checkout)
                                    backstory.json in either, when there is one

~/.diff-story/                      (DIFF_STORY_HOME moves it)
  config.json                       {port, token}, mode 600
  prefs.json                        page settings for every story: {hideWhitespace, diffView}
  stories.json                      the index: story id -> folder
  checkouts.json                    repo -> the checkout the bridge has seen
  inbox.jsonl                       questions, answers, positions, notes
  builds.json                       build requests, queued or building
  cursors/<consumer>.json           how far each reader has read the inbox
  state/<story id>/                 ui.json, position.json, viewed.json, notes.json
  state/pr-<owner>-<repo>-<N>/      drafts.json, read.json (per PR, so a regenerated story keeps them)
  <story id>/                       a story whose repo has no known checkout
```

The bridge learns a repo's checkout from local stories, from where `diff-story wait --repo` was run, and from `~/Development/<name>` (or `~/Development/Foundry|SDK/<name>`) when its origin is that repo. pr-story's `render` still publishes to `~/.diff-story/<owner>-<repo>-<N>/`. The bridge moves a story from there into its checkout once it knows the checkout, and a later render follows it the same way. Stories made before this moved the same way the first time the bridge saw them. One whose checkout isn't known stays readable in `~/.diff-story`.

The bridge also lists pr-story scratch folders (`/private/tmp/claude-<uid>/*/*/scratchpad/pr-story/*/`). `--root DIR` (repeatable) replaces the home folder as the place to look, and `--no-scratch` skips the scratch folders. When two folders hold the same PR, the most recently changed one wins.

## The bridge

`diff-story serve` binds to `127.0.0.1` only. Every `/api` call needs `Authorization: Bearer <token>`.

The bridge also checks each request:

- It refuses any request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- It refuses any `Origin` that isn't the extension or its own pages.
- Writes must be `application/json`.
- It sends no CORS headers, so other web pages can't read its responses.
- Its pages are served with a strict CSP.

| Call | What it does |
|---|---|
| `GET /api/health` | `{ok, version}` |
| `GET`/`POST /api/prefs` | page settings kept for every story: `{hideWhitespace, diffView}` (`unified` or `split`) |
| `GET /api/stories` | every story it can serve |
| `GET /api/stories/find?repo=O/R&number=N` | the story for a PR, if any |
| `GET /api/stories/:id` | the panel's data, plus the diff, viewed files and notes for a local story |
| `GET /api/stories/:id/version` | changes when the story or (for local) the commits change |
| `GET`/`POST /api/stories/:id/ui` | the panel's step, width, collapsed and hidden state (the local page uses this, and the extension keeps its own in `chrome.storage`) |
| `POST /api/stories/:id/position` | `{step, chapter, file}`, written to `position.json`, and to the inbox when it changes |
| `GET`/`POST /api/stories/:id/read` | the chapters you've read, each with the commit it was read at, and where an update would start (`since`); or record one: `{chapter, step, reason, seconds, head_sha}` |
| `GET`/`POST /api/stories/:id/questions` | ask a question, or list them with their answers |
| `POST /api/answers` | `{question, text}` |
| `GET /api/builds/status?repo=O/R&number=N` | `ready`, `building` or `none`, with the request if there is one (it marks a pending request done when the story has turned up) |
| `GET`/`POST /api/builds` | list pending build requests, or ask for one: `{repo, number, url, requested_at}` |
| `POST /api/stories/:id/viewed` | local stories: `{path, viewed}` |
| `POST /api/stories/:id/notes[/:note]` | local stories: add `{path, side, line, body}`, or update `{done}`, `{body}` or `{delete: true}` |

The other commands are `list`, `token --rotate`, `publish --dir`, `inbox`, `wait`, `answer`, `notes`, `builds` and `done`. Run `diff-story` with no arguments to see them all.

## Q&A relay

Everything the panel sends ends up as one JSON line in `~/.diff-story/inbox.jsonl`. That includes questions, position changes and notes, each with an `id`, a time and the story id. Readers keep their own cursor, so several can read the same file without stepping on each other.

**What works today, with no change to Claude Code settings.** A Claude Code session telling the story runs this as a background task:

```bash
diff-story wait --consumer pr-story
```

It blocks until a new question arrives, then prints the question and exits. A consumer's first wait starts from now, not from old questions. The exit wakes the session. Claude answers in chat and runs `diff-story answer --question <id> --file answer.md`, so the answer also shows in the panel under the question. Then it starts the wait again. The pr-story skill's SKILL.md describes this loop.

**Proposed next steps.** Nothing in Claude Code's settings, hooks or MCP config has been changed. These are for you to decide:

1. **A `UserPromptSubmit` hook.** It would run `diff-story inbox --unread --consumer hook --type question`, and anything it prints would be added to the prompt's context. Questions typed in the panel would then reach the session with your next message, even if no wait is running. It's cheap, but it only fires when you send a prompt.
2. **A small MCP server (`diff-story mcp`, not written yet).** It would read the same inbox and cursors, and offer tools: `next_question` (blocking, with a timeout), `answer`, `current_position` and `fix_before_push_notes`. If Claude Code's MCP servers can push messages into a live session, it could also deliver each question the moment it's asked. That needs checking against the current Claude Code docs before building.

Both read `inbox.jsonl` the way `wait` does. The format is described at the top of `bridge/lib/inbox.mjs`.

## Refined GitHub

Diff Story Mode doesn't need Refined GitHub and doesn't use anything it adds to the page. The test run below has Refined GitHub off. These notes come from reading Refined GitHub's source at commit `e65eacf` (main, 2026-10-20). **None of them were tested with Refined GitHub actually installed.**

**What helps**

- **Shift-click Viewed** (`batch-mark-files-as-viewed`) marks a range of files. It skips files that aren't visible, so on a chapter step it marks only that chapter's files. Partial files are marked too, so watch the "comes back in chapter N" ones.
- **dim-viewed-files** dims viewed files in the file tree, which matches the panel's "✓ viewed".
- **easy-toggle-files** collapses a file when you click its header, which is handy for a long chapter. The chapter filter re-applies as GitHub redraws the file.

**What could get in the way, and how each is handled**

- **Alt-click Viewed marks every file.** It looks for files that lack a `hidden` attribute, so it would also mark the files the chapter hides. To stop that, hidden files also get `hidden` on their block and on the `diff-…` region, `.js-file` and `[class*=diffTargetable]` inside it. The panel only ever removes a `hidden` it added itself.
- **`j`/`k` and "jump to first unviewed file" can land on hidden files.** Both set `#diff-…` to the next file in page order, whether it's hidden or not. When that lands on a file outside the chapter, the panel moves on in the same direction to the next chapter file. If there's none, it says which chapter the file is in. `x` (toggle Viewed on the current file) then acts on a file you can see.
- **Single-key shortcuts while you read the panel.** The panel can take focus, so clicking anywhere in it moves focus off the page. Key events inside it don't reach the page's listeners, so `j`, `k`, `x`, `y` and GitHub's own hotkeys don't fire while you're in the panel. The extension binds no page keys. Its only key is the Chrome command Alt+Shift+S, and Refined GitHub has no Alt+Shift shortcuts.
- **show-whitespace and linkify-code** wrap text in spans as lines scroll into view. The panel's DOM watcher ignores changes inside diff lines, so they don't trigger re-filtering. The panel lives in a shadow root, so these features can't rewrite the panel's own `code` and `pre` blocks either.
- **no-unnecessary-split-diff-view** hides one column of a one-sided split diff. Line jumps scroll to the row, not the cell, so a hidden cell doesn't matter.
- **restore-file** removes a file's block from the page. The panel then lists that file as "not loaded on the page".
- **The toast** (bottom right, z-index 101) can briefly cover the bottom of the panel (z-index 99). We left the panel below GitHub's own dialogs on purpose.
- **Its d w shortcut, and switching PR tabs.** The `d w` shortcut reloads the page with `?w=1`, and Refined GitHub can switch PR tabs without a full page load. The extension handles both the same way as GitHub's own navigation.

**Nothing found in the source**

- Nothing changes the `diff-…` ids, `data-line-anchor`, `role=region` or the tree ids the panel uses.
- Nothing wraps file blocks in extra elements.
- No feature changes the layout width on PR files pages or adds a fixed element on the right edge.
- Sticky file headers are classic-view only.

**Untested**

- Everything above with Refined GitHub actually running.
- The React `/changes` view while logged in. The test browser is logged out, so `/changes` redirected to `/files`.

## Development

```bash
yarn test              # bridge unit tests (node --test)
yarn js:lint
yarn test:extension    # loads src/ into a throwaway Playwright Chromium, never your own Chrome
yarn test:expand       # the same Chromium: panel links expand collapsed files and hunks on /files and /changes
yarn icons             # redraws src/icons
```

`test:extension` needs Playwright's Chromium:

```bash
PLAYWRIGHT_BROWSERS_PATH=/some/dir node node_modules/playwright-core/cli.js install chromium
```

Run it with the same `PLAYWRIGHT_BROWSERS_PATH`. It starts a bridge on a random port with a temporary home, and builds a two-chapter story for a public PR (`--pr owner/repo#N`, default `refined-github/refined-github#10280`). It then checks:

- the options page
- the panel on `/files` and `/changes`: docking, filtering, coming back after a reload, the `hidden` attribute and hash skipping
- a question and its answer
- hiding the panel and toggling it back
- that the GitHub page itself makes no calls to the bridge
- the local page: diff, filter, Viewed, a note, and coming back after a reload
- the options page's Test connection before Save, and the Backstory section and view on a PR

`test:expand` uses `refined-github/refined-github#10298` and checks that line links above, between and past its hunks, on both sides, and file and line links into a collapsed file open and highlight their target, with no expanding on a step change, `?w=1` kept and no Viewed toggle touched. Logged out, GitHub sends `/changes` to `/files`, so the React `/changes` DOM is checked by hand.

## Layout

- `src/`: the extension, which is the folder to load unpacked.
  - `js/content/index.js` finds the story and mounts the panel.
  - `js/background.js` is the only code that makes network calls, and only to `127.0.0.1`.
  - `js/shared/overlay.js` is the panel, shared with the local page.
- `bridge/`: the CLI (`bin/diff-story.mjs`), the server and story code (`lib/`), and the local page (`public/`).
- `skills/diff-story-listen/`: the Claude Code skill behind **Copy prompt for Claude**.
- `test/`: unit tests, `extension/load-test.mjs` and `extension/expand-test.mjs`.

## Credits

- The panel started as the pr-story skill's GitHub overlay.
- The pr-story skill renders its chat-mode pages with [session-story](https://github.com/nalaj/session-story) (MIT, © 2026 Nenad Alajbegovic), pinned at `b432256`. Diff Story Mode's local page is its own simple diff view and copies no session-story code.

## License

MIT
