# Once Upon a Diff

New here? [GETTING-STARTED.md](GETTING-STARTED.md) walks you through setup and your first story.

A code-review story (an overview, then chapters) in a side panel docked on top of a diff, with the diff filtered to each chapter's files. It works in two places:

- **GitHub PRs.** An unpacked Chrome extension docks the panel on a pull request's `/changes` or `/files` page whenever a story exists for that PR.
- **Local commits.** The bridge serves its own diff page for a local commit range, before anything is pushed, and the same panel runs on it.

The two work the same way and read the same `chapters.json` (once-upon's format). The panel comes back on the same step after a reload, after GitHub's in-page navigation, and when the story on disk changes.

The once-upon skill (`skills/once-upon/`) writes the stories, and this extension is the only way they show on GitHub. Its build checks that every changed file is in a chapter and every changed hunk is pointed at by one. The panel has an Overview step, per-file placement (each file is marked viewed in the last chapter that tells it), file and line jumps, a saved step, an Ask box, and a shadow root so the page's CSS can't reach it.

## Installing

You need Node 24 or newer, the current LTS (`.nvmrc` says 24). The bridge has no runtime dependencies. `yarn install` only fetches eslint, playwright-core and highlight.js (vendored into `src/bridge/public/vendor/`) for development. The repo uses Yarn 4, kept in `.yarn/releases` and named in `package.json`'s `packageManager`. Any `yarn` hands off to it, and `corepack enable` gets you a `yarn` if you have none.

1. Print the bridge's port and token. This also creates `~/.once-upon/config.json` with a random token:
   ```bash
   node src/bridge/bin/once-upon.mjs setup
   ```
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this repo's `src/extension/` folder.
3. The options page opens on install. If it doesn't, go to Details → Extension options. Paste the port and token, then click **Save** and **Test connection**.
4. Start the bridge and leave it running, or skip this and let `/once-upon-listen` start it for you:
   ```bash
   node src/bridge/bin/once-upon.mjs serve     # or: yarn bridge
   ```
5. Install the `once-upon-listen` Claude Code skill by linking it into your skills folder. If `~/.claude/skills` is itself a link, `ln` puts it in the folder the link points at, which is what you want:
   ```bash
   ln -s "$PWD/skills/once-upon-listen" ~/.claude/skills/once-upon-listen
   ```
   Start a new Claude Code session to pick it up. See [Listening from Claude Code](#listening-from-claude-code).
6. Install the `once-upon` skill the same way. It builds the PR stories the listener is asked for, and finds this repo through the link:
   ```bash
   ln -s "$PWD/skills/once-upon" ~/.claude/skills/once-upon
   ```

An alias saves typing: `alias once-upon="node /path/to/once-upon-a-diff/src/bridge/bin/once-upon.mjs"`. The rest of this README uses `once-upon`.

## Is it set up?

There are two quick ways to check.

**The light in the panel header.** It's the dot left of "Hide story". Hover it for a summary, or click it for details and fixes.

- **Green:** the bridge is reachable and accepts the token, the story was found, and a Claude session is listening for questions.
- **Amber:** everything works, but no Claude session is listening for this page's repo. The Ask box still queues questions and says they'll wait. Listeners are per repo: a session that runs `once-upon wait --repo owner/name` takes questions and build requests for that repo's stories and PRs, and nothing else. A wait with no `--repo` takes everything, and `--story <id>` takes one story's questions ahead of the repo's listener (see [One story, one session](#one-story-one-session)). Under the Ask box, and beside **Build story**, **Copy prompt for Claude** copies one line, `/once-upon-listen owner/name`, for the once-upon-listen skill. The page says which checkout to start Claude Code in when the bridge knows one, and **show details** (or the button's hover) gives the long form for a session without the skill. The bridge learns a repo's checkout from local stories and from where `wait --repo` was run (`~/.once-upon/checkouts.json`), and otherwise looks for `~/Development/<name>` with that origin.
- **Red:** the bridge is down, too old for the panel, or rejects the token.

"Listening" is a heartbeat. `once-upon wait` writes `~/.once-upon/listeners/<consumer>.json` every ≈5s, and a beat under 15s old from a live process counts. After `wait` hands a question over, the listener counts for up to 10 minutes as "answering", until the session starts the next wait.

**`once-upon doctor`.** It prints PASS, WARN or FAIL for each of these, with a fix for anything that isn't passing:

- the config and token
- the bridge process and port, and whether the bridge accepts the token
- when the extension last talked to the bridge (the bridge notes it)
- live listeners

It exits 1 when something fails.

## Listening from Claude Code

`skills/once-upon-listen/SKILL.md` is a Claude Code skill that makes a session one repo's listener. Open Claude Code in the repo's checkout and type, or paste from **Copy prompt for Claude**:

```
/once-upon-listen octo-org/web-app
```

`/once-upon-listen --story <id>` listens for one story: see [One story, one session](#one-story-one-session). The repo form's session then:

1. Finds the CLI: `once-upon` on `PATH`, else `node <repo>/src/bridge/bin/once-upon.mjs`, with `<repo>` from the `ONCE_UPON_REPO` env var, `repo_dir` in `~/.once-upon/config.json` (both read only by the skill), or the folder the skill is linked from.
2. Runs `once-upon doctor`. If nothing is listening on the bridge's port, it starts the bridge detached, so it keeps running after the session ends, and waits for it to answer. If something else has the port, it says so and stops.
3. Runs `once-upon wait --repo octo-org/web-app --type question,build_request,fix_request --consumer repo-octo-org-web-app` as a background task, which keeps the light green for every story and PR in that repo. It starts the wait again after each event.
4. Answers each Ask-box question from the story's chapters and the code in the checkout, briefly, with `once-upon answer`.
5. Builds each Build story request it's handed (the wait claims it, so the badge says Building) and publishes the story with the once-upon skill, which finishes the request. An update gets a "Since you read it" chapter, unless it asks for a re-tell.
6. Fixes each fix request it's handed (see [Fix before push](#fix-before-push-send-notes-to-a-session)): it marks the files it's changing, makes one change, commits it as your house rules say and reports the commit.
7. Stops when you say so.

It never posts to GitHub, marks files viewed or pushes. Comments it drafts go to the panel's Draft comments only. A fix request is the only time it changes the checkout, and then only on the branch it's on. Run one listener per repo, each in its own session.

### One story, one session

The session that built a story knows it best, so it can keep answering that story's questions while a repo listener takes everything else. In that session, run:

```
/once-upon-listen --story octo-org-web-app-42
```

`--story` takes the story id (`once-upon list`, or the line `build` prints after publishing), `owner/repo#N`, a PR URL, or a bare PR number in the session's checkout. Underneath it's `once-upon wait --story <id> --type question,build_request,fix_request --consumer story-<id>`. The once-upon skill offers this at the end of a build, and starts it when you've asked it to keep listening.

**The routing rule.** A question goes to a live listener for its story when there is one. A repo-wide or catch-all wait leaves that story's questions alone while the story listener is live, and takes them once it isn't (its beat goes stale, or its process is gone), including any it left waiting. A question handed to one session is never handed to another, and a dismissed one isn't handed over at all. A story listener takes its story's questions, its [Rebuild](#rebuild-story-rebuild-from-here) requests and its [fix requests](#fix-before-push-send-notes-to-a-session), by the same rule (a story wait started with `--type question` only, as older prompts did, gets no rebuilds or fix requests, and the repo's listener takes them). Fix requests go only to waits that take them (`fix_request` in `--type`). Build and update requests still go to the repo's listener. `~/.once-upon/handed.json` records which session each question went to.

The panel says who's answering, on the line under the Ask box: "Answered by api-10, the session listening for this story", or the repo listener's name with **Copy prompt for this story**, which copies `/once-upon-listen --story <id>` to paste into the session that built it. Each answer is labelled "Answered by" and the consumer. The name is the wait's `--consumer`, so pass your own (say `--consumer api-10`) to tell sessions apart.

## Using it on a PR

1. Make a story with the once-upon skill. Its `build` step publishes it with `once-upon publish --dir <D>`, which you can also run yourself: `chapters.json`, `file-map.json` and a `meta.json` naming the PR and the commit it was told from go into the repo's checkout (below), or `~/.once-upon/<owner>-<repo>-<N>/` when the bridge knows no checkout.
2. Open the PR's **Files changed** tab. The panel docks on the right at the Overview step.
3. Prev and Next (or the Steps list) filter the diff to a chapter. "Show all files" undoes the filter.
4. To hide the panel, use **Hide story** (it collapses to a strip) or **×** (it goes away and that's remembered for the PR). The toolbar button or **Alt+Shift+S** shows or hides it.
5. **Hide whitespace is remembered.** It's the same setting as the local page's (`prefs.json` through the bridge, with a copy in `chrome.storage` for when the bridge is down). When it's on, opening a PR's Files changed page without `?w=` reloads it once with `?w=1`, keeping the hash and the panel's step. Turning GitHub's own whitespace setting on or off there (`w=1`, `w=0`, or `w=1` dropping off the same page) saves the new choice. If GitHub drops the `w=1` it was sent, the page isn't reloaded again for 15 seconds, so it can't loop.
6. Type a question in the Ask box and press **Cmd+Enter**. The question goes to the bridge inbox, and the answer shows under it once a Claude session replies (see [Q&A relay](#qa-relay)), labelled with the session that answered.
7. **Tidy the conversation.** Each exchange has a ▾ to collapse it to its question line (▸ opens it again) and a **Dismiss** to hide it. **Clear conversation**, over the questions, dismisses every question in the story, on every step. After a Dismiss or a Clear, **Undo** shows for 15 seconds, and **Show dismissed (N)** lists them with **Restore** after that. The bridge keeps these marks per story in `state/<id>/questions.json`, so they hold after a reload, in other tabs and on the next poll, and a dismissed question that no session has picked up yet won't be handed to one.

**File and line links open what they point at.** Clicking a file name or a `path:40-58` line link in the panel scrolls to it and highlights it. If GitHub has the file collapsed (Viewed files and large ones collapse), the click expands it with the file's own toggle, or **Load diff**, and expanding never unmarks Viewed. For a line outside the hunks GitHub drew, it clicks GitHub's expand arrows above or below the hunk until the line is on the page (or **Expand all lines** when the line is far away), on `/changes` and classic `/files` alike. GitHub fetches those lines with the page's own settings, so `?w=1` stays and nothing reloads. This happens only when you click a link: changing steps, reloads and redraws never expand anything, and the panel never clicks comment or review controls, or Viewed except through a file's own **Mark viewed** button. A line that isn't in the file at all jumps to the nearest drawn line and says so.

When Claude rewrites `chapters.json`, the panel redraws within ≈5 seconds, or as soon as you come back to the tab. It keeps its step and its scroll position.

**Posted, pending and dismissed drafts.** Each draft comment shows what's become of it. There are four states:

- **Posted ✓**, with a link to the posted comment. These are hidden by default behind "Show posted (N)".
- **In your pending review**, for a comment in a review you haven't submitted yet. These stay visible, marked as not submitted.
- **Dismissed**, for a draft you don't want. Dismiss hides it behind "Show dismissed (N)", and Restore brings it back.
- **A draft**, with a **Dismiss** button, and on a line comment **Add to fix before push** and (on GitHub) **Add to my review**.

**Add to my review** puts a line draft into your pending review on GitHub, starting one if you have none. It never submits the review. GitHub doesn't redraw an open Files changed page for that, so the draft switches to "In your pending review" with the file and line, a jump link, "GitHub shows it after a reload" and a **Reload page** button. The page only reloads when you click it, and the panel comes back on the same step. The bridge keeps this state in `drafts.json`, so it lasts through re-renders, reloads and bridge restarts. Once gh finds the comment after a reload, or it shows up on the page, it becomes the usual pending (or posted) row. If GitHub refuses, the error shows on the draft and its buttons stay. A draft that's already in your review can't be added twice.

**Add to fix before push** makes a line draft a fix-before-push note on that file and line instead, for the Claude session working the branch to fix (below), on a PR story and on the local page. The draft then says "In fix before push", then "sent to <session>" or "fixed in <sha>", and a jump to the line. A draft that's already a note can't be added twice.

The chapter's comments heading counts each state, for example "(2 to post · 1 posted · 1 pending)".

The Overview lists every chapter's drafted comments in one place, grouped by chapter, each with its file:line, its state (draft, in your pending review, posted, dismissed or may be out of date) and the same buttons it has in its chapter. A chapter's name jumps to it. The list starts open with up to 4 drafts and folded with more. The local page does the same for its "Fix before push (drafted)" items.

**Copy as gh script (N)** sits at the top of that list on a PR, once gh has said what's posted. It copies a shell script that puts the N line drafts still to post into one pending review with `gh api --method POST repos/<owner>/<repo>/pulls/<N>/reviews`, with each comment's path, line and side. Dismissed, posted and already-pending drafts are left out, and so are general comments, which have no line (the script's header says how many). The request has no `event`, so GitHub keeps the review pending until you submit it. The comments go to gh as JSON on stdin through a quoted heredoc, so nothing in a comment reaches the shell, and it runs in a subshell that honors `gh_unset_github_token`. The panel only copies the script and never runs it. GitHub allows one pending review per PR, so if you already have one (say, from Add to my review), submit or delete it first, or keep using Add to my review.

How the bridge decides:

- **Posted and pending come from GitHub.** The bridge reads your own comments with read-only `gh api` GETs, with `GITHUB_TOKEN` unset so the keychain login is used, and caches them for 60s. It reads the PR's review comments, its reviews (a PENDING one is your unsubmitted review, read along with its comments) and its general comments.
- **Matching is fuzzy, because you often edit a draft before posting.** A draft matches a comment of yours on the same file within 3 lines, or a general draft a general comment, when the text is at least 0.75 similar.
- **Your own calls are kept.** Dismiss and Add to my review are kept by the bridge per PR, in `~/.once-upon/state/pr-<owner>-<repo>-<N>/drafts.json`. Rebuilt and regenerated stories keep them, and a dismissed comment matched by path, line and text isn't suggested again.
- **The local page has no GitHub to match**, so its drafts stay drafts until you dismiss them or add them to fix before push.
- `once-upon drafts --story <id>` lists every draft's state.

Add to my review is the only write to GitHub. Everything else here is read-only, and the gh script is yours to run.

### Fix before push: send notes to a session

Fix-before-push notes collect as drafts in the panel's **Fix before push** box (every note on the Overview, a chapter's own notes on its step). They come from **Add to fix before push** on a drafted comment, and on the local page from a line number too.

- **Until it's sent, a note can be edited or removed.** Edit and Remove are on each draft note.
- **Send N notes to <session>** hands every draft note to the Claude session as one request (`fix_request`). It goes to the session listening for that story when one is live, else the repo's listener, by the [routing rule](#one-story-one-session), among waits that take fix requests. The button names that session. With none listening, the request waits for the next one. On a PR story, that's the session working the PR's branch.
- **Sent notes are locked** and say "Sent to <session>". When the session reports back, they say "Fixed in <sha>" (and are ticked done). A note the change didn't cover comes back as a draft, with why. **Take back** returns a request's notes to the drafts while nobody has reported on it.
- **Auto-send**, a checkbox in the box (off by default, kept per story), sends each note on its own as it's added.

The session makes one coherent change for the request's notes, commits it (or amends) as your house rules say, never pushes, and reports with `once-upon fixed --request <id> --sha <sha> [--notes <ids>]`, or `--failed --note "<why>"`. The bridge keeps the queue in `~/.once-upon/fixes.json` and the notes in `state/<id>/notes.json`. `once-upon notes --story <id>` prints them with where each has got.

### Being changed

While a session changes code, it says which files (and lines, when it knows) with `once-upon working --story <id> --files <path[:start-end]>,...`. The panel shows "Being changed by <session>" over the steps, marks those files and the chapters that tell them, and dims their blocks on the page. `once-upon working --story <id> --done <sha>` (or `once-upon fixed`) clears it, and the usual "changed since you read it" and new-commits marks take over. A mark expires on its own when its session goes quiet: 30 minutes without another `working` call (running it again with no `--files` keeps it fresh), or as soon as its listener stops beating. It works on PR and local stories, and the marks are kept in `state/<id>/working.json`.

**Comments drafted in Q&A** go into the panel's Draft comments, whether they come from chat, voice or the Ask box. To add one, run `once-upon comment --story <id> --chapter N --path <file> --line L --body-file <f>`. It appends to that chapter's `comments` in `chapters.json`, both in the copy the bridge serves and in its once-upon source folder, so the next render keeps it. Adding the same comment twice keeps one copy. Nothing is posted to GitHub.

**Viewed progress.** Each chapter's header says how many of its "Mark viewed" files are ticked, for example "3 of 4 marked viewed · still to mark: a.tsx". The file names are jump links, and the line changes to "✓ All 4 marked viewed" when you're done. Files that come back in a later chapter, or were finished in an earlier one, don't count against it. The Steps list shows each chapter's count, or ✓ when it's complete. The Overview shows the overall count.

The panel reads each file's state from the page's own Viewed toggle:

- on GitHub, the header toggle's `aria-pressed` (or the checkbox on classic `/files`)
- on the local page, the bridge-kept toggle

It never clicks that toggle on its own: not on a step change, a reload or a redraw, and never for more than the one file you clicked (see **Mark viewed** below). It looks again after any click or change on the page, so Refined GitHub's batch mark-viewed helpers are picked up too. Moving on with files left gives a gentle note, not a block. The "Files in this chapter" list starts folded, with a one-line summary ("6 files · 4 to mark viewed · 2 come back later"). Whether it's open is remembered per story.

**Hunks no chapter points at.** once-upon's `build` won't publish while a changed hunk of a file bigger than 40 changed lines has nothing in any chapter pointing at a line inside it: a `lines` range, a `path:40-58` in the text or a drafted comment. A smaller file, a deleted file or a lockfile is covered by being listed, and so is a file whose entry says `"whole": true`. A story built with `--allow-uncovered` shows the rest as a quiet note on the Overview, as line links. A local story's Overview does the same from its own diff.

**Where "Mark viewed" goes.** A file is marked viewed in the last chapter that tells it. A chapter tells a file by listing it, or by pointing at its lines in its text: `path:45`, `path:40-58`, a bare `:45` after the file is named, or a link to the file's diff with a line anchor. A file a chapter points at without listing it joins that chapter's file list (and its filter) as a partial entry, "its lines are pointed at in the text", with those lines. A name with no line doesn't count, and neither does anything in a code block. Every earlier chapter leaves the file untagged, whether or not that listing is flagged partial: no pill in the text and no status in the file list, only the listing's partial note ("here: …") if it has one. The viewed progress and the "viewed early" warning follow the same rule, and so does once-upon's `file-map.json` (`finished_in`).

**Mark viewed.** In its finishing chapter a file gets a **Mark viewed** button, in the file list and as a small button on the file's last mention in the chapter's text, in reading order (often the closing "Files to mark viewed" line), so you reach it once the chapter is done with the file. Earlier mentions carry nothing. Clicking it ticks that one file's own Viewed checkbox on the page, exactly as if you'd clicked it yourself: GitHub's header toggle on `/changes`, the checkbox on classic `/files`, or the bridge-kept toggle on the local page. GitHub then collapses the file as usual, and a file or line link still expands it again. The button follows the toggle live and turns into **Viewed ✓**, muted. Clicking **Viewed ✓** unticks it the same way. That click is the only time the panel touches Viewed. If the file isn't loaded on the page yet, the click scrolls to it and asks you to click again. Logged out there's no checkbox, so it says so.

**On PR lists and a PR's Conversation tab.** A repo's `/pulls`, the global `/pulls` and PR search results get one tag after each PR's title, and a PR's Conversation tab gets the same tag next to its title. The tag is the control:

- **Story** opens the PR's Files changed tab, where the panel docks. Once you've read some of it, it says **Story · 2 of 5 read** and opens on the first chapter you haven't read (Files changed`#ou-step-N`). Once you've read every chapter, it's a muted **Read**.
- **Read · 3 new commits · Update** (or "2 of 5 read · …") means you've read the story and the PR has moved on. Update asks for a "Since you read it" chapter, and the small **Re-tell** beside it asks for a new story.
- **Build story** asks for a story, the same request as on Files changed.
- **Story out of date · Update**, on a story you haven't read, asks for an update to the PR's latest commit: a "Since you read it" chapter for the new commits (see [Since you read it](#since-you-read-it)). The small **Re-tell** beside it asks for a whole new story instead.
- **Queued** means a story was asked for and no Claude session has taken it yet. **Building…** means a session has claimed it. Neither can be clicked. An update shows as **Update queued** or **Updating…**.

When no session is listening for a repo on the page, one notice at the bottom right says "No session listening for owner/name", with **Copy prompt for Claude** and, when the bridge knows one, the checkout to start Claude Code in. It's said once for the page, not on each row.

The page makes one batched lookup (`POST /api/stories/status-many`, cached 5s), and the tags come back after GitHub or Refined GitHub redraws the list or the PR header. While a tag says Queued or Building…, the page looks again every 10s. With no bridge running, the list stays as GitHub draws it.

**What you've read.** The panel records a chapter as read when you leave it after 30 seconds on it (counted only while the tab is showing, and switching tabs counts as leaving), or when you tick the last of its files viewed there. Each record is kept per PR in `~/.once-upon/state/pr-<owner>-<repo>-<N>/read.json` as `{<chapter key>: {head_sha, story_head, at, reason}}`, and goes to the inbox as a `read` line. `head_sha` is the PR's head at the time: the panel sends the one it got from the freshness check, and the bridge asks gh (read-only) when it doesn't have one. `story_head` is the commit the story was told from, which is the same unless the story was already out of date. A local story records its range's head commit. A chapter's key is its `key` in `chapters.json`, or else its title without "Chapter N:", so a chapter put in front of it doesn't change it. `GET /api/stories/:id/read` lists them.

**Is the story up to date?** A story records the PR head it was told from: once-upon's `pr.json` `headRefOid`, copied into `meta.json` as `head_oid`. The bridge reads the PR's current head and compares the two with read-only `gh api` calls, cached for 60s.

- When they match, the panel header says "Up to date with abc1234".
- When they don't, it says "Story is for abc1234; the PR has N newer commits", with the files changed since and the chapters that list them. Those files get "changed since story" in the files list, and those chapters a mark in the Steps list.
- **Update (new commits)** sends a build request with `mode: 'update'` and the old head (`base_sha`). **Re-tell from scratch** sends the same with `retell: true`, for a rebase or a big rework (the panel suggests it when the PR was rebased). While no session has taken it, clicking the other one switches it. It stays pending until the story's head moves.
- PR-list and Conversation tags say "Story out of date · Update" with a small "Re-tell", then "Update queued" or "Updating…".

### Since you read it

When a PR gets a few new commits after you've read its story, an update adds one chapter instead of telling the whole story again:

- The bridge works out where your reading stopped: the commit you read your earliest chapter at (from `read.json`, above), counting only reads after the newest "Since you read it" chapter you read, since that one caught you up. With nothing read, it's the commit the story was told from. The build request carries it as `since_sha`, with `since_source` (`read` or `story`), the `reads` and the story id. `once-upon builds` prints it under each update ("update: "Since you read it" from abc1234 (where his reading stopped; 3 chapters read)"), `builds --json` and `wait --json` include the fields, and the request `wait` hands over says what to write.
- The once-upon skill writes one chapter for `since_sha..` the PR's head, puts it first, and keeps the other chapters as they were. It has `since: {from, to, commits}` in `chapters.json` and lists the files those commits touched.
- The panel doesn't number "Since you read it" chapters. The Steps list shows them as **New**, and the chapters after them keep the numbers you read them with, so the chapter numbers in their text still hold. A file a "Since you read it" chapter lists is marked viewed there (the newest one wins), since you've read the chapters after it. Its other chapters say "Already finished in “Since you read it”". once-upon's `file-map.json` follows the same rule. The "viewed early" warning stays quiet on a "Since you read it" step, and for a file you read in its last chapter that hasn't changed since, even when another file in that chapter did.
- On a PR, a "Since you read it" chapter starts with which commits it covers and a link to GitHub's diff of just those commits, `/pull/N/changes/<from>..<to>`. It loads as is logged in (checked on 2026-10-22), and GitHub redirects it to `/files/<from>..<to>` logged out. On that page the panel opens on the chapter, once per page load, and the chapter's filter shows only the files those commits touched. A link back to all of the PR's changes replaces it there.
- **Changed since you read.** A chapter you read whose files a newer commit changed gets "• changed since you read" in the Steps list, and those files get the same mark in its files list. A drafted comment there whose line a newer commit changed says "May be out of date". The bridge compares the commit you read each chapter at with the story's head, once per commit (gh's compare, read-only and cached 60s, or git for a local story), and `GET /api/stories/:id/read` returns them as `changed` and `stale_comments`. "Since you read it" chapters and chapters you haven't read aren't marked.
- A rebase past `since_sha`, or a request with `retell`, gets a new story from scratch. Drafts' posted and dismissed marks are kept per PR either way.

### Rebuild story, Rebuild from here

When a story reads wrong, ask for it again from the panel, on a PR or a local story. **Rebuild story…** sits at the end of the Overview and **Rebuild from here…** at the end of each chapter. Either opens a "What should change?" box (optional), which goes to the Claude session as guidance, and **Queue rebuild** sends `POST /api/stories/:id/rebuild` with `mode: 'rebuild'`, or `mode: 'rebuild_from'` and `from_step` (from chapter 1 is a whole rebuild). The line under the toolbar then says Rebuild queued, Rebuilding…, and Rebuilt (with what was kept) or failed, and the PR tags say "Rebuild queued" or "Rebuilding…".

- It's a build request like Build story's, kept in `builds.json` (by PR, or `story:<id>` for a local story), and handed to the story's own listener while one that takes build requests is live, else to the repo's. It finishes only when the story is published again, by `once-upon publish` or `once-upon local --chapters`.
- The story keeps its id and URL. **Rebuild from here** keeps chapters 1 to N-1 exactly as published, and re-tells N and the rest. Publishing refuses chapters that change a kept chapter, leave a file of the diff in no chapter, or leave a hunk untold (across the whole story, `--allow-uncovered` aside).
- Nothing you drafted or asked is dropped. A draft on a re-told chapter that the new chapters don't have is put back, in the chapter that now tells its line or file: kept as is when its line is still in the diff ("kept from before the rebuild"), flagged when it isn't (its Add to my review is held back). A question asked on a re-told chapter moves to the chapter with the same key or the one that now tells its file, else the Overview (`moved` in `questions.json`). A read of a chapter that was re-told over a different set of files is set aside, so that chapter counts as unread. One re-told over the same files keeps it.

### Story ready, Building, Build story

A PR's Files changed tab gets the same story tag as PR lists and the Conversation tab (see **On PR lists and a PR's Conversation tab** above), next to the PR title, whenever the panel isn't showing:

- **Story** opens the panel again. You see it when a story exists and the panel is hidden.
- **Queued** means someone asked for a story and no session has taken it yet. When no session is listening for the repo, a notice at the bottom right says so, with **Copy prompt for Claude**. **Building…** means a session claimed it: `once-upon wait` claims each request it hands over, and `once-upon builds --start <id>` refreshes the claim on a long build. A claim with no refresh for 30 minutes goes back to Queued, and the next wait hands it out again. While a request is queued or building, the page asks the bridge every ≈10 seconds, and when the story turns up the panel opens by itself. That's the only polling a page without a story does.
- **Build story** asks for one. The extension sends `{repo, number, url, requested_at}` to the bridge, which keeps the request in `~/.once-upon/builds.json`. Every tab on that PR then shows it as queued.

A Claude session fulfils the request. `once-upon wait` hands it build requests from `builds.json`, oldest first, whenever they were asked, so a listener started after the request still gets it. Each request goes to one listener at a time. `once-upon builds` lists the pending ones as queued or building. The session writes the story with the once-upon skill, whose `build` publishes it. Publishing finishes the request, and so does the bridge seeing the story turn up. If it can't be built, the session says so with `once-upon done <id> --failed --note "…"`. The × on the control hides it until the page reloads. The control is the extension's own button in its own shadow root, and it never clicks anything of GitHub's.

## Local mode: commits before you push

```bash
once-upon local --repo ~/Development/web-app-worktrees/tidy-up --base 3a669da7625 --head HEAD --chapters chapters.json
```

This builds `git diff <base> <head>` into `~/.once-upon/local-<repo>-<branch>/`. If no bridge is running, it starts one, then opens `http://127.0.0.1:<port>/local/<id>/`. The page draws the diff with the same DOM shapes as GitHub's `/changes` page, so the same panel code runs on it unchanged.

- **Viewed** toggles are kept by the bridge. A file whose diff changes after you marked it shows as "changed since viewed" and is unviewed again.
- **Comments become "fix before push" notes.** Click a line number to add a note. Notes are listed under "Fix before push" at the top, can be ticked done, and go to the inbox. The panel's Fix before push box sends them to a Claude session ([above](#fix-before-push-send-notes-to-a-session)). `once-upon notes --story <id>` prints them as a checklist. Comments drafted in `chapters.json` show in the panel as "Fix before push (drafted)".
- **The page follows the branch.** Amend or add a commit and the page redraws with the new diff within ≈5 seconds.
- **Unified / Split**, in the page header, switches between one column and GitHub's side-by-side view, with old lines on the left and new on the right, lined up. Line numbers on either side take notes, and line jumps, Viewed and the panel work the same in both. It's saved in `prefs.json` too, so it holds for every local story.
- **Syntax highlighting** colors the diff in both views, picked by file extension: TypeScript and TSX, JavaScript, JSON, Ruby and ERB, YAML, CSS and SCSS, Markdown, shell, and HTML/XML. Each hunk's old and new sides are highlighted as whole pieces of code, so a template string or block comment that runs over several lines is colored right. A hunk that starts partway into a comment can still come out wrong. Files over 3,000 diff lines, minified lines and anything past 20,000 lines on a page stay plain, so big diffs stay quick. highlight.js is vendored in `src/bridge/public/vendor/` (`yarn vendor` remakes it from the pinned dev dependency), so the bridge still has no runtime dependencies and the page loads nothing from a CDN.
- **Hide whitespace**, in the page header, draws the diff with `git diff -w`, like GitHub's setting of the same name. Unlike GitHub's, it's remembered: the bridge keeps it in `~/.once-upon/prefs.json`, so it holds for every local story and across reloads and bridge restarts. A file whose only changes are whitespace stays listed, marked "whitespace only". Viewed marks and "changed since viewed" are always checked against the full diff, so turning it on or off never flips them. A whitespace-only edit after you mark a file viewed still counts as a change. A note or a story line on a line the `-w` diff doesn't draw sits at the top of its file (notes say so), or the panel jumps to the nearest drawn line.
- **A chapter shows its own lines.** When chapters that share a file give `lines` ranges, each chapter folds the lines another chapter tells behind a row that says which chapter (**Show** opens it, and a link to one of its lines opens it too, along with the file if it's folded). Lines no range covers show in the first chapter that lists the file. A chapter that lists the file without ranges, the Overview and **Show all files** draw all of it. GitHub's page can't be redrawn this way, so there the panel filters by file only.
- Without `--chapters`, you get one chapter per top-level folder as a starting point. Any file a story doesn't place lands in a last "Not in a chapter yet" step, so nothing is hidden from every step.

## Story folders

Stories live in the repo they're about, in a hidden `.once-upon/` folder in its local checkout. Git ignores that folder through the checkout's `.git/info/exclude`, which is local and never committed. So there's no `.gitignore` change, `git status` stays clean, and `git add .` can't pick it up. A worktree shares its repo's exclude file.

```
<checkout or worktree>/.once-upon/
  local-<repo>-<branch>/            chapters.json, meta.json, local.diff      (from once-upon local, in the worktree it diffs)
  <owner>-<repo>-<N>/               chapters.json, file-map.json, meta.json   (a PR story, in the repo's main checkout)

~/.once-upon/                        (ONCE_UPON_HOME moves it)
  config.json                       {port, token}, mode 600
  prefs.json                        page settings for every story: {hideWhitespace, diffView}
  stories.json                      the index: story id -> folder
  checkouts.json                    repo -> the checkout the bridge has seen
  inbox.jsonl                       questions, answers, notes
  builds.json                       build requests, queued or building
  fixes.json                        fix requests: the notes sent to a session, and how each ended
  cursors/<consumer>.json           how far each reader has read the inbox
  state/<story id>/                 ui.json, position.json, viewed.json, notes.json, fix-settings.json, working.json
  state/pr-<owner>-<repo>-<N>/      drafts.json, read.json (per PR, so a regenerated story keeps them)
  <story id>/                       a story whose repo has no known checkout
```

The bridge learns a repo's checkout from local stories, from where `once-upon wait --repo` was run, and from `<dir>/<name>` for each folder in `checkout_dirs` (default `~/Development`, see [Personal settings](#personal-settings)) when its origin is that repo. `once-upon publish` and `once-upon local` are the only ways a story gets there, and each records its folder in `stories.json`. A story whose checkout isn't known goes in `~/.once-upon`, and the bridge reads both. When two folders hold the same PR, the most recently changed one wins.

## The bridge

`once-upon serve` binds to `127.0.0.1` only. Every `/api` call needs `Authorization: Bearer <token>`.

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
| `POST /api/stories/status-many` | `{prs: [{repo, number}]}`: each PR's story or build request (and settles a request whose story turned up), what's been read, newer commits, and who's listening per repo |
| `GET /api/status?story=ID` | the status light: the bridge, the story, and whether a Claude session is listening |
| `GET /api/stories/:id` | the panel's data, plus the diff, viewed files and notes for a local story |
| `GET /api/stories/:id/version` | changes when the story or (for local) the commits change |
| `GET /api/stories/:id/pulse` | `{version, questions_rev, drafts_rev, fixes_rev, working_rev, listening, answering}`, one poll for what the panel watches. A field changes when that thing does. `drafts_rev` covers the drafts and your marks, not what's on GitHub |
| `GET`/`POST /api/stories/:id/ui` | the panel's step, width, collapsed and hidden state (the local page uses this, and the extension keeps its own in `chrome.storage`) |
| `POST /api/stories/:id/position` | `{step, chapter, file}`, written to `state/<id>/position.json` |
| `GET`/`POST /api/stories/:id/read` | the chapters you've read, each with the commit it was read at, and where an update would start (`since`); or record one: `{chapter, step, reason, seconds, head_sha}` |
| `GET`/`POST /api/stories/:id/questions` | ask a question, or list them with their answers (`once-upon answer` adds one), each marked `dismissed`, `collapsed` and `handed_to`, and each answer with `by` |
| `POST /api/stories/:id/questions/marks` | `{action, ids}`: `dismiss`, `restore`, `collapse` or `expand` those questions, or `{action: 'clear'}` to dismiss every one (the answer says which, as `cleared`) |
| `POST /api/builds` | ask for a story: `{repo, number, url, requested_at}` (`once-upon builds` lists them) |
| `POST /api/stories/:id/viewed` | local stories: `{path, viewed}` |
| `POST /api/stories/:id/notes[/:note]` | fix-before-push notes: add `{path, side, line, body}` (or `{chapter, index}`, a drafted comment), or update `{done}`, `{body}` or `{delete: true}`; a sent note only takes `{done}` |
| `GET`/`POST /api/stories/:id/fixes` | the notes with their state, `auto_send`, who a send goes to (`to`) and the recent requests; or `{action: 'send', ids?}`, `{action: 'auto', on}`, `{action: 'take_back', request}` |
| `GET /api/stories/:id/working` | the "being changed" marks that still stand, and the last one cleared |

The other commands are `list`, `token --rotate`, `publish --dir`, `inbox`, `wait`, `answer`, `notes`, `working`, `fixed`, `builds` and `done`. Run `once-upon` with no arguments to see them all.

### Personal settings

`~/.once-upon/config.json` holds the port and token, and can also hold a few optional settings. All of them default to something neutral, so a fresh install needs none:

| Key | What it does | Default |
|---|---|---|
| `display_name` | Your name in the lines the bridge writes for Claude ("where Sam's reading stopped") | "the reviewer's" |
| `time_zone`, `time_zone_label` | An IANA zone for the times the CLI prints, and a label for it (`"America/New_York"`, `"ET"`) | the system's zone and its short name |
| `checkout_dirs` | Folders to look in for a repo's checkout, as `<dir>/<name>` (the bridge) or up to four levels down (once-upon's `gather.sh`) | `["~/Development"]`, or `ONCE_UPON_DEV_DIR` |
| `open_command` | The argv that opens a URL or file (`once-upon local`) | `open` on macOS, `xdg-open` on Linux, `explorer` on Windows |
| `gh_unset_github_token` | `true` drops `GITHUB_TOKEN` before every `gh` call, for when that variable holds a token that shouldn't be used (gh then uses its own login) | `false` |
| `house_rules` | A Markdown file of your own rules that the once-upon and once-upon-listen skills read and follow | `~/.once-upon/house-rules.md` |

**House rules** are how you make the skills yours without changing the repo. The skills here are generic: they never post, submit or push, and they draft comments for you to post. Anything about your own setup goes in the house rules file instead: where your checkouts live, how to look up people's names from their GitHub logins, the voice for drafted comments, a past story to model new ones on, things never to run. The skills read it first and follow it alongside their own rules, but it can't loosen the read-only rules.

## Q&A relay

Questions and notes from the panel each end up as one JSON line in `~/.once-upon/inbox.jsonl`, with an `id`, a time and the story id. Readers keep their own cursor, so several can read the same file without stepping on each other.

**What works today, with no change to Claude Code settings.** A Claude Code session telling the story runs this as a background task:

```bash
once-upon wait --story <id> --type question,build_request
```

It blocks until a new question on that story arrives, then prints the question and exits. A story's own wait comes before the repo's listener (see [One story, one session](#one-story-one-session)). A consumer's first wait starts from now, not from old questions. The exit wakes the session. Claude answers in chat and runs `once-upon answer --question <id> --file answer.md`, so the answer also shows in the panel under the question. Then it starts the wait again. The once-upon skill's SKILL.md describes this loop.

**Proposed next steps.** Nothing in Claude Code's settings, hooks or MCP config has been changed. These are for you to decide:

1. **A `UserPromptSubmit` hook.** It would run `once-upon inbox --unread --consumer hook --type question`, and anything it prints would be added to the prompt's context. Questions typed in the panel would then reach the session with your next message, even if no wait is running. It's cheap, but it only fires when you send a prompt.
2. **A small MCP server (`once-upon mcp`, not written yet).** It would read the same inbox and cursors, and offer tools: `next_question` (blocking, with a timeout), `answer`, `current_position` and `fix_before_push_notes`. If Claude Code's MCP servers can push messages into a live session, it could also deliver each question the moment it's asked. That needs checking against the current Claude Code docs before building.

Both read `inbox.jsonl` the way `wait` does. The format is described at the top of `src/bridge/inbox/inbox.mjs`.

## Refined GitHub

Once Upon a Diff doesn't need Refined GitHub and doesn't use anything it adds to the page. The test run below has Refined GitHub off. These notes come from reading Refined GitHub's source at commit `e65eacf` (main, 2026-10-20). **None of them were tested with Refined GitHub actually installed.**

**What helps**

- **Shift-click Viewed** (`batch-mark-files-as-viewed`) marks a range of files. It skips files that aren't visible, so on a chapter step it marks only that chapter's files. Partial files are marked too, so watch the ones a later chapter finishes (they have no Mark viewed button here, and the "viewed early" warning flags them).
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
yarn lint              # ESLint (cached); yarn lint:fix fixes what it can
yarn format:check      # Prettier's check (100 columns); yarn format rewrites
yarn lint:sh           # shellcheck over the once-upon skill's shell scripts
yarn types             # TypeScript's checkJs (JSDoc types, no build step): tsconfig.json for Node, tsconfig.browser.json for the extension and local page
yarn test:extension    # loads src/extension/ into a throwaway Playwright Chromium, never your own Chrome
yarn test:expand       # the same Chromium: panel links expand collapsed files and hunks on /files and /changes
yarn icons             # redraws src/extension/icons
```

A pre-commit hook (husky and lint-staged, installed by `yarn install`) runs ESLint and Prettier's check on the staged JavaScript.

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
- the options page's Test connection before Save

`test:expand` uses `refined-github/refined-github#10298` and checks that line links above, between and past its hunks, on both sides, and file and line links into a collapsed file open and highlight their target, with no expanding on a step change, `?w=1` kept and no Viewed toggle touched. Logged out, GitHub sends `/changes` to `/files`, so the React `/changes` DOM is checked by hand.

## Code layout

- `src/extension/`: the extension, which is the folder to load unpacked. Its `shared` is a link to `src/shared/`.
  - `background.js` is the only code that makes network calls, and only to `127.0.0.1`. `settings.js` keeps the bridge's port and token.
  - `content/index.js` routes by page kind: Files changed, Conversation, PR list, or other.
    - `bridge.js` sends bridge calls through the service worker. `storage.js` keeps the panel's state per PR and the Hide whitespace copy.
    - `pages/files-changed.js` docks the panel and puts the story tag by the title when the panel is hidden. `pages/hide-whitespace.js` keeps `?w=1` in step with the setting.
    - `pages/conversation.js` and `pages/pull-list.js` put the story tag by a PR's title.
    - `ui/` holds the pieces they share: `story-tag.js` (what a tag says), `tag-host.js`, `listen-notice.js`, `pr-tags.js` (the tag controller every PR page shares), `copy.js` and `toast.js`. Each one with its own shadow root links its CSS from a `.css` file beside it.
- `src/shared/`: the code the extension and the bridge both use. The bridge serves it to the local page and imports its helpers.
  - `overlay.js` is the panel's entry, shared with the local page. It builds one context and wires the modules in `panel/`:
    - `story-model.js`: chapters, numbers and where each file is finished. `panel-state.js`: the saved step and layout.
    - `shell.js`: the frame and toolbar, with `panel.css` in its shadow root and `page.css` (docking, hiding, flashing) in the page's head. `body.js`: the step on screen. `navigation.js`: Prev, Next and the step list.
    - `host-page.js`: finding files, lines and toggles on `/changes`, `/files` and the local page. `filter.js`, `expand.js` and `scroll.js`: hiding, opening and jumping.
    - `file-refs.js` and `markdown.js`: the story's text and its jump links. `file-list.js`: the file rows.
    - `review-script.js`: the Overview's Copy as gh script.
    - `viewed.js`, `reading.js`, `drafts.js`, `freshness.js`, `rebuild.js`, `marks.js`, `status-light.js` and `questions.js`: Viewed progress, read tracking, drafted comments, story freshness, Rebuild, the "changed since" marks, the status light and the Ask box.
    - `fixes.js` and `working.js`: Fix before push (Send, Auto-send, each note's state) and the "being changed" marks.
  - `util/`: helpers for the panel, the content scripts, the local page and the bridge (escaping and the html`` tag that builds markup, SHAs, PR keys, line references, times, the clipboard, GitHub paths, key isolation, the default port).
- `src/bridge/`: the bridge and its CLI.
  - `bin/once-upon.mjs` runs `cli/index.mjs`, a table of commands in `cli/commands/` (bridge, stories, inbox, drafts, builds, checks, fixes) that also builds the help. `cli/doctor.mjs` is `once-upon doctor`.
  - `server/index.mjs` is the HTTP server: its guards, then a route table. The routes are in `server/routes/` by area; `pages.mjs` and `assets.mjs` serve the HTML pages, the scripts and the stylesheets.
  - `stories/`: finding story folders (`store.mjs`, `placement.mjs`), reading them (`meta.mjs`, `chapters.mjs`, `story-data.mjs`, `text-refs.mjs`, `hunk-coverage.mjs`), local stories (`local-story.mjs`, `local-diff.mjs`), read tracking (`reads.mjs`), drafted comments (`comments.mjs`), the rules a Rebuild is published by (`rebuild.mjs`) and "being changed" marks (`working.mjs`).
  - `github/`: what asks `gh` (read-only, except Add to my review): freshness, drafts and the pending review.
  - `inbox/` (the inbox, the conversation's marks and routing, build requests, and fix-before-push notes and fix requests), `listeners/` (who's listening), `config/` (settings, prefs, repos and checkouts) and `util/` (gh, git, diffs, JSON files).
  - `public/`: the local page. `local.js` draws it and handles its clicks; `local/` holds the diff view, notes, folds and the panel mount, next to `split.js`, `narrow.js` and `syntax.js`.
- `skills/once-upon-listen/`: the Claude Code skill behind **Copy prompt for Claude**.
- `skills/once-upon/`: the Claude Code skill that writes PR stories. Both skills read your house rules (see [Personal settings](#personal-settings)).
- `test/`: unit tests, `extension/load-test.mjs` and `extension/expand-test.mjs`.

## Credits

- The panel started as the once-upon skill's GitHub overlay.

## License

MIT
