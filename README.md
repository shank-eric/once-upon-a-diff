# Once Upon a Diff

New here? [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) walks you through setup and your first story.

A code-review story (an overview, then chapters) in a side panel docked on top of a diff, with the diff filtered to each chapter's files. It works in two places:

- **GitHub PRs.** An unpacked Chrome extension docks the panel on a pull request's `/changes` or `/files` page whenever a story exists for that PR.
- **Local commits.** The bridge serves its own diff page for a local commit range, before anything is pushed, and the same panel runs on it.

The two work the same way and read the same `chapters.json` (once-upon's format). The panel comes back on the same step after a reload, after GitHub's in-page navigation, and when the story on disk changes.

The once-upon skill (`skills/once-upon/`) writes the stories, and this extension is the only way they show on GitHub. Its build checks that every changed file is in a chapter and every changed hunk is pointed at by one. The panel has an Overview step, per-file placement (each file is marked viewed in the last chapter that tells it), file and line jumps, a saved step, an Ask box, and a shadow root so the page's CSS can't reach it.

## Installing

You need Node 24 or newer, the current LTS (`.nvmrc` says 24, so `fnm use` or `nvm use` in the repo picks it). On an older Node the CLI, the skill helper and the package scripts stop with one line saying so. The repo is a Yarn workspaces monorepo in TypeScript: `yarn` installs the build and test tools and links the ten packages (`domain`, `contracts`, `bridge-client`, `ui-kit`, `github-page`, `panel`, `web`, `bridge`, `extension` and the dev-only `test-kit`, under `packages/`). The bridge has no build, and one runtime dependency, Valibot, which checks what a page sends: Node 24 runs its TypeScript directly. The extension is built with WXT. The repo uses Yarn 4, kept in `.yarn/releases` and named in `package.json`'s `packageManager`. Any `yarn` hands off to it, and `corepack enable` gets you a `yarn` if you have none.

1. Install, build the extension, and print the bridge's port and token. `setup` also creates `~/.once-upon/config.json` with a random token:
   ```bash
   yarn
   yarn build
   scripts/install-cli.sh    # puts `once-upon` on your PATH (npm link on packages/server/bridge) and links the skills
   once-upon setup
   ```
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `packages/client/extension/.output/chrome-mv3`, the folder `yarn build` makes. Its ID is always `faaibhigocihefldbmdgchcnnclalkmo` (the manifest carries a fixed key), so its saved settings survive a rebuild, a reload or a new checkout.
3. The options page opens on install. If it doesn't, go to Details → Extension options. Paste the port and token, then click **Save** and **Test connection**.
4. Start the bridge and leave it running, or skip this and let `/once-upon-listen` start it for you:
   ```bash
   once-upon serve    # or: yarn bridge
   ```
5. Install the Claude Code skills (`once-upon-listen`, `once-upon` and `once-upon-editor`) by linking them into your skills folder. `scripts/install-cli.sh` already did this; to do it alone, or to repeat it, run:
   ```bash
   scripts/link-skills.sh    # links each skills/<name> into ~/.claude/skills (or $CLAUDE_SKILLS_DIR)
   ```
   A link that is already right is left as it is, and one that points elsewhere is left alone with a notice (`--relink` replaces it). The skills are links into the checkout, so a `git pull` updates them. Start a new Claude Code session to pick them up. The build queue's lean agent types (`agents/`) are linked the same way, one file at a time into `~/.claude/agents` (or `$CLAUDE_AGENTS_DIR`), by `scripts/link-agents.sh` (`install-cli.sh --no-agents` skips it). See [Listening from Claude Code](#listening-from-claude-code) and [Running a build queue](#running-a-build-queue).

`scripts/install-cli.sh` runs `npm link` on `packages/server/bridge`, whose `package.json` `bin` is `once-upon`, so the command works from any folder and survives moving packages inside the repo (re-run it if you move the checkout, switch Node versions or upgrade Node, since under fnm or nvm the link lives in one version's bin). It runs under the first `node` on your `PATH`, so keep a Node 24 as your default (`fnm default 24`). Without the link, `node packages/server/bridge/bin/once-upon.mjs` is the same command.

## Is it set up?

There are two quick ways to check.

**The light in the panel header.** It's the dot left of "Hide story". Hover it for a summary, or click it for details and fixes.

- **Green:** the bridge is reachable and accepts the token, the story was found, and a Claude session is listening for questions.
- **Amber:** everything works, but no Claude session is listening for this page's repo. The Ask box still queues questions and says they'll wait. Listeners are per repo: a session that runs `once-upon wait --repo owner/name` takes questions and build requests for that repo's stories and PRs, and nothing else. A wait with no `--repo` takes everything, and `--story <id>` takes one story's questions ahead of the repo's listener (see [One story, one session](#one-story-one-session)). **Start listening**, under the Ask box and in the notice on PR lists and a PR's Conversation tab, types one line, `/once-upon-listen owner/name`, for the once-upon-listen skill, into an idle Claude Code session in the repo, the way the agent board's button does (it needs iTerm and the board's session tracking). The local story page has it too. One session, or one clearly fresher than the rest, is typed into at once. Several close together are listed to choose from. With none, the page says so: start Claude Code in the repo's checkout and click again. The voice session, a session that already listens, and one that is working or waiting on you are never typed into. The page says which checkout to start Claude Code in when the bridge knows one, and **show details** (or the button's hover) gives the line and the long form to type by hand in a session without the skill. The bridge learns a repo's checkout from local stories and from where `wait --repo` was run (`~/.once-upon/checkouts.json`), and otherwise looks for `~/Development/<name>` with that origin.
- **Red:** the bridge is down, too old for the panel, or rejects the token.

"Listening" is a heartbeat. `once-upon wait` writes `~/.once-upon/listeners/<consumer>.json` every ≈5s, and a beat under 15s old from a live process counts. After `wait` hands a question over, the listener counts for up to 10 minutes as "answering", until the session starts the next wait.

**`once-upon doctor`.** It prints PASS, WARN or FAIL for each of these, with a fix for anything that isn't passing:

- the config and token
- the bridge process and port, and whether the bridge accepts the token
- when the extension last talked to the bridge (the bridge notes it)
- live listeners

It exits 1 when something fails.

## Listening from Claude Code

`skills/once-upon-listen/SKILL.md` is a Claude Code skill that makes a session one repo's listener. Open Claude Code in the repo's checkout and type the line, or click **Start listening** to have it typed for you:

```
/once-upon-listen octo-org/web-app
```

`/once-upon-listen --story <id>` listens for one story: see [One story, one session](#one-story-one-session). The repo form's session then:

1. Finds a Node 24 (the shell's `node`, else fnm's or nvm's) and the CLI: `once-upon` on `PATH`, else `<node> <repo>/packages/server/bridge/bin/once-upon.mjs`, with `<repo>` from the `ONCE_UPON_REPO` env var, `repo_dir` in `~/.once-upon/config.json` (both read only by the skill), or the folder the skill is linked from.
2. Runs `once-upon doctor`. If nothing is listening on the bridge's port, it starts the bridge detached, so it keeps running after the session ends, and waits for it to answer. If something else has the port, it says so and stops.
3. Runs `once-upon wait --repo octo-org/web-app --type question,build_request,fix_request,approved --consumer repo-octo-org-web-app` as a background task, which keeps the light green for every story and PR in that repo. It starts the wait again after each event.
4. Answers each Ask-box question from the story's chapters and the code in the checkout, briefly, with `once-upon answer`.
5. Builds each Build story request it's handed (the wait claims it, so the badge says Building) and publishes the story with the once-upon skill, which finishes the request. An update gets a "Since you read it" chapter, unless it asks for a re-tell.
6. Fixes each fix request it's handed (see [Fix before push](#fix-before-push-send-notes-to-a-session)): it marks the files it's changing, makes one change, commits it as your house rules say and reports the commit.
7. Stops when you say so.

It never posts to GitHub, marks files viewed or pushes, and never runs the PR's code unless you say so in chat. Comments it drafts go to the panel's Draft comments only. A fix request is the only time it changes the checkout, and then only on the branch it's on. Run one listener per repo, each in its own session.

### Keep listener sessions on a short leash

A listener reads PR titles, bodies, diffs and review comments that anyone who can open a PR or comment on one can write, and it runs for hours with your shell, git and `gh` login. The skills treat all of that as data and tell the session never to run the PR's code, push or write to GitHub, but those are instructions to a model, not a sandbox. So:

- **Never run a listener (or a `/once-upon` build) in bypass-permissions mode** (`--dangerously-skip-permissions`, or `defaultMode: "bypassPermissions"`). Let Claude Code ask before commands the deny list doesn't cover.
- **Give listener sessions a `gh` token without write scope, if you can.** It's the only thing that closes `gh api`, which a deny list can't: a prefix rule like `gh api -X:*` doesn't catch `gh api repos/o/r/issues/1/comments -f body=hi`, which POSTs because it has fields, or `-X POST` put after the path, and it can't tell a GraphQL query from a mutation (`gh api graphql`). A read-only fine-grained token in `GH_TOKEN`, in the shell you start the session from, is enough for everything the skills do.
- **Deny the writes you can name.** In the checkout's `.claude/settings.local.json` (or your `~/.claude/settings.json`), something like:

  ```json
  {
    "permissions": {
      "deny": [
        "Bash(git push:*)",
        "Bash(gh pr review:*)",
        "Bash(gh pr comment:*)",
        "Bash(gh pr merge:*)",
        "Bash(gh pr close:*)",
        "Bash(gh pr edit:*)",
        "Bash(gh issue comment:*)",
        "Bash(gh api -X:*)",
        "Bash(gh api --method:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "WebFetch"
      ]
    }
  }
  ```

  The skills don't need any of these: they check the bridge with `once-upon doctor`, not `curl`. The `gh api` rules catch only the commands that start that way (above), so they back up the read-only token rather than replace it.
- **Fix requests change code.** A fix note that came from a Claude-drafted comment is shown to you in chat, and the session waits for your OK before acting on it. Auto-send never sends one. On a PR's branch the session doesn't run tests or scripts unless you say so in chat, and commits with `git -c core.hooksPath=/dev/null commit`, since that branch's hooks are the PR's code. `--no-verify` isn't enough: it skips `pre-commit` and `commit-msg`, but `prepare-commit-msg`, `post-commit` (and `post-rewrite` on an amend) still run, and with husky the hooks path is the PR's own `.husky/`.

### One story, one session

The session that built a story knows it best, so it can keep answering that story's questions while a repo listener takes everything else. In that session, run:

```
/once-upon-listen --story octo-org-web-app-42
```

`--story` takes the story id (`once-upon list`, or the line `build` prints after publishing), `owner/repo#N`, a PR URL, or a bare PR number in the session's checkout. Underneath it's `once-upon wait --story <id> --type question,build_request,fix_request,approved --consumer story-<id>`. The once-upon skill starts it on its own after it builds a story, and when you ask a session to open a story or for its link, unless another session already listens for that story or the build came from a repo listener.

**A story listener ends on its own, and so does a repo's.** A `--repo` wait stops on the same rule once no page has shown any of the repo's stories for 10 minutes (`listen_idle_minutes`), and when the board's Stop listening asks; both are logged to `~/.once-upon/listeners.log`.

**A story listener ends on its own.** A `--story` wait stops once no page has shown its story for 10 minutes (`story_listener_idle_minutes` in `config.json`): the panel's pulse and the local page's poll tell the bridge a page shows it, and the bridge keeps the time in `state/<id>/seen.json`. A tab in the background still counts: while it is hidden, the panel and the local page send a small "still open" call (`POST /api/stories/:id/seen`) about once a minute, which only notes the story as seen, so only a closed tab (or a browser that stops its timers) lets the idle window run out. The wait prints "Stopped listening for <story>" and the session says so and doesn't start it again. It never stops while the session holds the story's fix request or rebuild, and `--no-auto-stop` turns it off. Repo-wide waits keep listening.

**Approve.** On a local story's page, **Approve** records that the story is ready to ship at its current commit (`approved.json` in the story's state folder, with the sha) and marks it reviewed. It takes the full page key, so a story opened with a read-only link says to open it from the board or `once-upon page`. A new commit clears the approval and puts the story back in Ready, and it also clears after 7 days. On the board, an approved local story with no PR sits in Ready to ship, after Ready for your review, with an "Approved, ready to ship" chip. A listening session hears an `approved` event (`once-upon wait` prints it): it checks the branch is still at that commit and that the PR title and body are on the page, then tells you. It never pushes or opens the PR. `once-upon approve <id> [--undo]` does the same from a session. A story listener takes its story's approvals, and a repo listener takes them when no story listener is live.

**The routing rule.** A question goes to a live listener for its story when there is one. A repo-wide or catch-all wait leaves that story's questions alone while the story listener is live, and takes them once it isn't (its beat goes stale, or its process is gone), including any it left waiting. A question handed to one session is never handed to another, and a dismissed one isn't handed over at all. A story listener takes its story's questions, its [Rebuild](#rebuild-story-rebuild-from-here) requests and its [fix requests](#fix-before-push-send-notes-to-a-session), by the same rule (a story wait started with `--type question` only, as older prompts did, gets no rebuilds or fix requests, and the repo's listener takes them). Fix requests go only to waits that take them (`fix_request` in `--type`). Build and update requests still go to the repo's listener. `~/.once-upon/handed.json` records which session each question went to.

The panel says who's answering, on the line under the Ask box: "Answered by api-10, the session listening for this story", or the repo listener's name with **Start listening for this story**, which types `/once-upon-listen --story <id>` into an idle session in the repo (the same choosing as above), which then answers this story's questions ahead of the repo's listener. Each answer is labelled "Answered by" and the consumer. The name is the wait's `--consumer`, so pass your own (say `--consumer api-10`) to tell sessions apart.

**A story built by a subagent.** A subagent can't keep a wait running: it ends when it hands back, so its story's questions would fall to the repo's listener, which doesn't have the author's context. A subagent that built the story passes `--agent <its name>` to `once-upon publish` or `once-upon local` (or runs `once-upon bind --story <id> --agent <name>`), which writes `state/<id>/agent.json` with the agent's name and the session that owns it (`$CLAUDE_CODE_SESSION_ID`, which a subagent shares with its parent). Only that session can `SendMessage` the agent, so the story's questions, fix-before-push requests, rebuild requests and approvals are relayed through it (a fix request and an approval go only to the branch's author, a registered author, for a local story; the agent amends its own worktree): a `once-upon wait` run from the owner session (a `--story` wait or a repo wait) prints such a question with the message to send instead of asking for an answer. The agent, resumed with its context, runs `once-upon asking` and `once-upon answer --consumer <agent>` itself, so the panel shows "Waiting for <consumer> to pass it to <agent>" until the agent's first `asking` note (the relay message asks for one first thing), then "Sent to <agent>, which built this story, through <consumer>" with its notes, and the answer under "Answered by <agent>". A relayed question with no word from the agent counts as gone quiet after 15 minutes instead of 5. If the question is asked again or dismissed meanwhile, `asking` says so and a late `answer` from the agent is refused. A wait's beat names its session, so the panel's line under the Ask box names the agent as who answers, whether the owner session's wait covers the story or the whole repo. A question asked by voice is filed with `once-upon ask --story <id> --text "…" --voice` (it shows in the panel marked "By voice"), and the agent also sends the main session a two-sentence answer to speak. `--no-relay` makes a wait answer here instead. A binding is ignored once it is a day old (each relay starts the day again) or its session has ended (the registry's process must still be the one that wrote it), `bind` and `--agent` warn when the session isn't running, and a story told again with `publish` or `local` without `--agent` drops the old binding, and a wait run from any other session doesn't relay, so a stale binding never holds a question back: it goes to the repo's listener as for any story. Each question costs the owner session one `SendMessage` and the agent a resume with its whole context.

## Using it on a PR

1. Make a story with the once-upon skill. Its `build` step publishes it with `once-upon publish --dir <D>`, which you can also run yourself: `chapters.json`, `file-map.json` and a `meta.json` naming the PR and the commit it was told from go into the repo's checkout (below), or `~/.once-upon/<owner>-<repo>-<N>/` when the bridge knows no checkout.
2. Open the PR's **Files changed** tab. The panel docks on the right at the Overview step.
3. Prev and Next (or the Steps list) filter the diff to a chapter. "Show all files" undoes the filter.
4. To hide the panel, use **Hide story** (it collapses to a strip) or **×** (it goes away and that's remembered for the PR). The toolbar button or **Alt+Shift+S** shows or hides it.
5. **Hide whitespace is remembered.** It's the same setting as the local page's (`prefs.json` through the bridge, with a copy in `chrome.storage` for when the bridge is down). When it's on, opening a PR's Files changed page without `?w=` reloads it once with `?w=1`, keeping the hash and the panel's step. Turning GitHub's own whitespace setting on or off there (`w=1`, `w=0`, or `w=1` dropping off the same page) saves the new choice. If GitHub drops the `w=1` it was sent, the page isn't reloaded again for 15 seconds, so it can't loop.
6. Type a question in the Ask box and press **Cmd+Enter**. The question goes to the bridge inbox, and the answer shows under it once a Claude session replies (see [Q&A relay](#qa-relay)), labelled with the session that answered.
7. **Tidy the conversation.** Each exchange has a ▾ to collapse it to its question line (▸ opens it again) and a **Dismiss** to hide it. **Clear conversation**, over the questions, dismisses every question in the story, on every step. After a Dismiss or a Clear, **Undo** shows for 15 seconds, and **Show dismissed (N)** lists them with **Restore** after that. The bridge keeps these marks per story in `state/<id>/questions.json`, so they hold after a reload, in other tabs and on the next poll, and a dismissed question that no session has picked up yet won't be handed to one.

**File and line links open what they point at.** Clicking a file or line link in the panel scrolls to it and highlights it. A link in a story's text is a chapter's `ref` (`[text](ref:id)`): nothing is linked by its words, so a backticked `path:40-58` is plain code. If GitHub has the file collapsed (Viewed files and large ones collapse), the click expands it with the file's own toggle, or **Load diff**, and expanding never unmarks Viewed. For a line outside the hunks GitHub drew, it clicks GitHub's expand arrows above or below the hunk until the line is on the page (or **Expand all lines** when the line is far away), on `/changes` and classic `/files` alike. GitHub fetches those lines with the page's own settings, so `?w=1` stays and nothing reloads. This happens only when you click a link: changing steps, reloads and redraws never expand anything, and the panel never clicks comment or review controls, or Viewed except through a file's own **Mark viewed** button. A line that isn't in the file at all jumps to the nearest drawn line and says so.

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

On GitHub, Fix before push is only for your own PRs: the bridge says in the story's fix view (`can_add`) whether the PR's author is the `gh` user (the author comes from `pr.json`, kept as `pr_author` in `meta.json` when the story is published). On someone else's PR the box and **Add to fix before push** are hidden, and notes already there stay readable. Local stories always have it.

- **Until it's sent, a note can be edited or removed.** Edit and Remove are on each draft note.
- **Send N notes to <session>** hands every draft note to the Claude session as one request (`fix_request`). It goes to the session listening for that story when one is live, else the repo's listener, by the [routing rule](#one-story-one-session), among waits that take fix requests. The button names that session. With none listening, the request waits for the next one. On a PR story, that's the session working the PR's branch.
- **Sent notes are locked** and say "Sent to <session>". When the session reports back, they say "Fixed in <sha>" (and are ticked done). A note the change didn't cover comes back as a draft, with why. **Take back** returns a request's notes to the drafts while nobody has reported on it.
- **Auto-send**, a checkbox in the box (off by default, kept per story), sends each note on its own as it's added. A note that came from a drafted comment waits for Send, since Claude wrote it from the PR, and the listening session asks you in chat before acting on it.

The session makes one coherent change for the request's notes, commits it (or amends) as your house rules say, never pushes, and reports with `once-upon fixed --request <id> --sha <sha> [--notes <ids>]`, or `--failed --note "<why>"`. The bridge keeps the queue in `~/.once-upon/fixes.json` and the notes in `state/<id>/notes.json`. `once-upon notes --story <id>` prints them with where each has got.

### Being changed

While a session changes code, it says which files (and lines, when it knows) with `once-upon working --story <id> --files <path[:start-end]>,...`. The panel shows "Being changed by <session>" over the steps, marks those files and the chapters that tell them, and dims their blocks on the page. `once-upon working --story <id> --done <sha>` (or `once-upon fixed`) clears it, and the usual "changed since you read it" and new-commits marks take over. A mark expires on its own when its session goes quiet: 30 minutes without another `working` call (running it again with no `--files` keeps it fresh), or as soon as its listener stops beating. It works on PR and local stories, and the marks are kept in `state/<id>/working.json`.

**Comments drafted in Q&A** go into the panel's Draft comments, whether they come from chat, voice or the Ask box. To add one, run `once-upon comment --story <id> --chapter N --path <file> --line L --body-file <f>`. It appends to that chapter's `comments` in `chapters.json`, both in the copy the bridge serves and in its once-upon source folder, so the next render keeps it. Adding the same comment twice keeps one copy. Nothing is posted to GitHub.

**Viewed progress.** Each chapter's header says how many of its "Mark viewed" files are ticked, for example "3 of 4 marked viewed · still to mark: a.tsx". The file names are jump links, and the line changes to "✓ All 4 marked viewed" when you're done. Files that come back in a later chapter, or were finished in an earlier one, don't count against it. The Steps list shows each chapter's count, or ✓ when it's complete. The Overview shows the overall count.

The panel reads each file's state from the page's own Viewed toggle:

- on GitHub, the header toggle's `aria-pressed` (or the checkbox on classic `/files`)
- on the local page, the bridge-kept toggle

It never clicks that toggle on its own: not on a step change, a reload or a redraw, and never for more than the one file you clicked (see **Mark viewed** below). It looks again after any click or change on the page, so Refined GitHub's batch mark-viewed helpers are picked up too. Moving on with files left gives a gentle note, not a block. The "Files in this chapter" list starts folded, with a one-line summary ("6 files · 4 to mark viewed · 2 come back later"). Whether it's open is remembered per story.

**Hunks no chapter points at.** once-upon's `build` won't publish while a changed hunk of a file bigger than 40 changed lines has nothing in any chapter pointing at a line inside it: a ref with lines, or a drafted comment at the file's full path. Text covers nothing. A smaller file, a deleted file or a lockfile is covered by being listed, and so is a file whose entry says `"whole": true`. A story built with `--allow-uncovered` shows the rest as a quiet note on the Overview, as line links. A local story's Overview does the same from its own diff.

**Where "Mark viewed" goes.** A file is marked viewed in the last chapter that tells it. A chapter tells a file by listing it. Its `refs` (`{id, path, side, start, end}`, each on a file the chapter lists) are where its text links to, and they move nothing: a story's text never adds a file to a chapter or changes where one finishes. (A story told before refs is read the old way, in memory: the bridge turns its `lines` ranges and its backticked `path:45` mentions into refs, and a file its text pointed at joins as a partial entry, so nothing moves.) Every earlier chapter leaves the file untagged, whether or not that listing is flagged partial: no pill in the text and no status in the file list, only the listing's partial note ("here: …") if it has one. The viewed progress and the "viewed early" warning follow the same rule, and so does once-upon's `file-map.json` (`finished_in`).

**Mark viewed.** In its finishing chapter a file gets a **Mark viewed** button, in the file list and as a small button on the file's last mention in the chapter's text, in reading order (often the closing "Files to mark viewed" line), so you reach it once the chapter is done with the file. Earlier mentions carry nothing. Clicking it ticks that one file's own Viewed checkbox on the page, exactly as if you'd clicked it yourself: GitHub's header toggle on `/changes`, the checkbox on classic `/files`, or the bridge-kept toggle on the local page. GitHub then collapses the file as usual, and a file or line link still expands it again. The button follows the toggle live and turns into **Viewed ✓**, muted. Clicking **Viewed ✓** unticks it the same way. That click is the only time the panel touches Viewed. If the file isn't loaded on the page yet, the click scrolls to it and asks you to click again. Logged out there's no checkbox, so it says so.

**On PR lists and a PR's Conversation tab.** A repo's `/pulls`, the global `/pulls` and PR search results get one tag after each PR's title, and a PR's Conversation tab gets the same tag next to its title. The tag is the control:

- **Story** opens the PR's Files changed tab, where the panel docks. Once you've read some of it, it says **Story · 2 of 5 read** and opens on the first chapter you haven't read (Files changed`#ou-step-N`). Once you've read every chapter, it's a muted **Read**.
- **Read · 3 new commits · Update** (or "2 of 5 read · …") means you've read the story and the PR has moved on. Update asks for a "Since you read it" chapter, and the small **Re-tell** beside it asks for a new story.
- **Build story** asks for a story, the same request as on Files changed.
- **Story out of date · Update**, on a story you haven't read, asks for an update to the PR's latest commit: a "Since you read it" chapter for the new commits (see [Since you read it](#since-you-read-it)). The small **Re-tell** beside it asks for a whole new story instead.
- **Queued** means a story was asked for and no Claude session has taken it yet. **Building…** means a session has claimed it. Neither can be clicked. An update shows as **Update queued** or **Updating…**.

When no session is listening for a repo on the page, one notice at the bottom right says "No session listening for owner/name", with **Start listening** and, when the bridge knows one, the checkout to start Claude Code in. It's said once for the page, not on each row.

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

### The parts strip: "you are here"

A repo can name its parts once, by hand, and the panel then draws a strip of them under Steps on the Overview and on every chapter, with the parts that step touches lit (a mark, a heavy border and weight, and words for a screen reader, never colour alone). In a chapter the groups with nothing lit fold into one "Not touched" line. The Overview shows every group, with how many of the story's files each lit part holds. Nothing is written into a story: the bridge reads the parts file each time it loads a story, so names are stable, cost no tokens, and an older story gains the strip as soon as its repo has a file.

- **Where the file lives.** `.once-upon-parts.json` at the root of a checkout is for repos you own and can commit to. `~/.once-upon/parts/<owner>-<name>.json` (the repo lowercased, `/` as `-`, for example `acme-widgets.json`) is for every other repo, such as your employer's or an upstream project's, so nothing is committed to a tree that isn't yours. The second wins when both exist. A local story reads the file in the worktree it diffs, a PR story reads the repo's main checkout (its working tree, not the PR's head).
- **No file, no strip.** There is no guess from folder names. A file that doesn't check out is ignored without an error.
- **Format** (`version: 1`). `groups` is the draw order of the rows. Each part has an `id` (`a-z`, digits and `-`, up to 40, unique, `other` is taken), a `name` (up to 24 characters), a `group`, `paths` and an optional `note` (shown as the cell's tooltip). A path is a folder prefix ending in `/` or one exact file; the longest match wins, so a part can carve a folder out of another. A file no part owns is in an implicit **Other** part, drawn only when a story has one. Up to 40 parts and 50 paths each.

  ```json
  {
    "version": 1,
    "groups": ["Server", "Repo"],
    "parts": [
      { "id": "api", "name": "API", "group": "Server", "paths": ["src/api/"], "note": "The routes" },
      { "id": "billing", "name": "Billing", "group": "Server", "paths": ["src/api/billing/"] },
      { "id": "docs", "name": "Docs", "group": "Repo", "paths": ["docs/", "README.md"] }
    ]
  }
  ```
- This repo's own file is `.once-upon-parts.json`; `packages/server/bridge/test/parts-file-covers-repo.test.ts` fails when a tracked file lands in no part, so the names keep up with the tree. The rules are `domain/src/parts.ts`, the lookup is `stories/src/parts.ts`, and the strip is `ui-kit/src/components/parts-strip.ts`.

### Rebuild story, Rebuild from here

When a story reads wrong, ask for it again from the panel, on a PR or a local story. **Rebuild story…** sits at the end of the Overview and **Rebuild from here…** at the end of each chapter. Either opens a "What should change?" box (optional), which goes to the Claude session as guidance, and **Queue rebuild** sends `POST /api/stories/:id/rebuild` with `mode: 'rebuild'`, or `mode: 'rebuild_from'` and `from_step` (from chapter 1 is a whole rebuild). The line under the toolbar then says Rebuild queued, Rebuilding…, and Rebuilt (with what was kept) or failed, and the PR tags say "Rebuild queued" or "Rebuilding…".

- It's a build request like Build story's, kept in `builds.json` (by PR, or `story:<id>` for a local story), and handed to the story's own listener while one that takes build requests is live, else to the repo's. It finishes only when the story is published again, by `once-upon publish` or `once-upon local --chapters`.
- The story keeps its id and URL. **Rebuild from here** keeps chapters 1 to N-1 exactly as published, and re-tells N and the rest. Publishing refuses chapters that change a kept chapter, leave a file of the diff in no chapter, or leave a hunk untold (across the whole story, `--allow-uncovered` aside).
- Nothing you drafted or asked is dropped. A draft on a re-told chapter that the new chapters don't have is put back, in the chapter that now tells its line or file: kept as is when its line is still in the diff ("kept from before the rebuild"), flagged when it isn't (its Add to my review is held back). A question asked on a re-told chapter moves to the chapter with the same key or the one that now tells its file, else the Overview (`moved` in `questions.json`). A read of a chapter that was re-told over a different set of files is set aside, so that chapter counts as unread. One re-told over the same files keeps it.

### Story ready, Building, Build story

A PR's Files changed tab gets the same story tag as PR lists and the Conversation tab (see **On PR lists and a PR's Conversation tab** above), next to the PR title, whenever the panel isn't showing:

- **Story** opens the panel again. You see it when a story exists and the panel is hidden.
- **Queued** means someone asked for a story and no session has taken it yet. When no session is listening for the repo, a notice at the bottom right says so, with **Start listening**. **Building…** means a session claimed it: `once-upon wait` claims each request it hands over, and `once-upon builds --start <id>` refreshes the claim on a long build. A claim with no refresh for 30 minutes goes back to Queued, and the next wait hands it out again. While a request is queued or building, the page asks the bridge every ≈10 seconds, and when the story turns up the panel opens by itself. That's the only polling a page without a story does.
- **Build story** asks for one. The extension sends `{repo, number, url, requested_at}` to the bridge, which keeps the request in `~/.once-upon/builds.json`. Every tab on that PR then shows it as queued.

A Claude session fulfils the request. `once-upon wait` hands it build requests from `builds.json`, oldest first, whenever they were asked, so a listener started after the request still gets it. Each request goes to one listener at a time. `once-upon builds` lists the pending ones as queued or building. An agent that builds a story itself, with no click, files its own request with `once-upon builds --begin <owner/repo#N> --consumer <name>` (the skill does this first), so the page shows Building from the start. The session writes the story with the once-upon skill, whose `build` publishes it. Publishing finishes the request, and so does the bridge seeing the story turn up. If it can't be built, the session says so with `once-upon done <id> --failed --note "…"`. The × on the control hides it until the page reloads. The control is the extension's own button in its own shadow root, and it never clicks anything of GitHub's.

## Local mode: commits before you push

```bash
once-upon local --repo ~/Development/web-app-worktrees/tidy-up --base 3a669da7625 --head HEAD --chapters chapters.json
```

This builds `git diff <base> <head>` into `~/.once-upon/local-<repo>-<branch>/`. If no bridge is running, it starts one. It knows its own bridge by `~/.once-upon/bridge.json` (the bridge's pid, port and a fingerprint of its token, written when it starts listening), without calling it: a port held by anything else is an error that says so, and a bridge that started before `once-upon token --rotate` gets a warning to restart it, since its page keys no longer match. Then it opens `http://127.0.0.1:<port>/local/<id>/#key=<page key>`. The key in the link works for that one story only, and is the full one that can push for Create pull request (see [The bridge](#the-bridge)), and `once-upon page --story <id>` prints the link again. The page draws the diff with the same DOM shapes as GitHub's `/changes` page, so the same panel code runs on it unchanged.

- **Viewed** toggles are kept by the bridge. A file whose diff changes after you marked it shows as "changed since viewed" and is unviewed again.
- **Comments become "fix before push" notes.** Click a line number to add a note. Notes are listed under "Fix before push" at the top, can be ticked done, and go to the inbox. The panel's Fix before push box sends them to a Claude session ([above](#fix-before-push-send-notes-to-a-session)). `once-upon notes --story <id>` prints them as a checklist. Comments drafted in `chapters.json` show in the panel as "Fix before push (drafted)".
- **The page follows the branch.** Amend or add a commit and the page redraws with the new diff within ≈5 seconds.
- **Unified / Split**, in the page header, switches between one column and GitHub's side-by-side view, with old lines on the left and new on the right, lined up. Line numbers on either side take notes, and line jumps, Viewed and the panel work the same in both. It's saved in `prefs.json` too, so it holds for every local story.
- **Syntax highlighting** colors the diff in both views, picked by file extension: TypeScript and TSX, JavaScript, JSON, Ruby and ERB, YAML, CSS and SCSS, Markdown, shell, and HTML/XML. Each hunk's old and new sides are highlighted as whole pieces of code, so a template string or block comment that runs over several lines is colored right. A hunk that starts partway into a comment can still come out wrong. Files over 3,000 diff lines, minified lines and anything past 20,000 lines on a page stay plain, so big diffs stay quick. highlight.js is vendored in `packages/client/web/public/vendor/` (`yarn workspace @once-upon-a-diff/web vendor` remakes it from the pinned dev dependency), so the page loads nothing from a CDN.
- **Hide whitespace**, in the page header, draws the diff with `git diff -w`, like GitHub's setting of the same name. Unlike GitHub's, it's remembered: the bridge keeps it in `~/.once-upon/prefs.json`, so it holds for every local story and across reloads and bridge restarts. A file whose only changes are whitespace stays listed, marked "whitespace only". Viewed marks and "changed since viewed" are always checked against the full diff, so turning it on or off never flips them. A whitespace-only edit after you mark a file viewed still counts as a change. A note or a story line on a line the `-w` diff doesn't draw sits at the top of its file (notes say so), or the panel jumps to the nearest drawn line.
- **A chapter shows its own lines.** When chapters that share a file give `refs` with lines, each chapter folds the lines another chapter tells behind a row that says which chapter (**Show** opens it, and a link to one of its lines opens it too, along with the file if it's folded). Lines no range covers show in the first chapter that lists the file. A chapter that lists the file without ranges, the Overview and **Show all files** draw all of it. GitHub's page can't be redrawn this way, so there the panel filters by file only.
- Without `--chapters`, you get one chapter per top-level folder as a starting point. Any file a story doesn't place lands in a last "Not in a chapter yet" step, so nothing is hidden from every step.
- **Push**, in the page header, is what a local story gets instead of Create pull request when its commits go straight to the repo's default branch (a repo that keeps notes or config on `master`, say). Which button a story gets is settled by branch: a story on the default branch, or with no recorded branch (built a commit at a time) whose head is on the default branch, gets Push, and any other branch gets Create pull request. The `ship` setting in `config.json` (see [Personal settings](#personal-settings)) overrides that per repo. Push is off until you **Approve** the story, and it sends the approved commit only: commits made after Approve stay local. The same confirm box as Create pull request shows the commits a push would send. The bridge fetches origin's default branch first and refuses when GitHub has commits your checkout doesn't, when the approved commit isn't on your local default branch, or when GitHub protects the branch or requires pull requests (`gh api repos/<repo>/branches/<branch>`, whose `protected` flag says whether it is, plus the branch's active rulesets, read with `gh_unset_github_token` honored). A protected branch is refused with the reason and the box offers Create pull request, and protection `gh` can't read stops a push too. The push is one `git push origin <approved sha>:refs/heads/<default>` with your own git login, a fast-forward and never forced. Right after it, the story's `delivered` check runs and clears its card from Ready to ship. Only the full page key can push: the read-only key is refused for both `GET` and `POST .../push`. An approved story's card in the board's **Ready to ship** column gets a **Push** button too, which opens the story page with the box already showing.
- **Push for a branch with an open PR**: when a story's branch already has an open PR and your local branch is ahead of GitHub's copy (a fix made after review), the header shows **N commits ahead** next to **Open PR #N**, with a **Push** button. The count comes from `git ls-remote` and `git rev-list --count`, with no fetch. The button opens the same confirm box, listing the commits, and its push is `git push origin <branch>`, a fast-forward with your own git login and never forced. It is refused, with "Pull first", when GitHub's copy has commits your checkout doesn't. Only the full page key can push (`POST .../pr` with `action: "push-ahead"`). The board's card for that PR shows **N ahead** and a **Push** button that opens the story page with the box showing, when a local story of the branch is known. A PR with no local story is left alone.
- **Create pull request**, in the page header (on a branch), opens a confirm box. It shows where the branch stands on GitHub (`git ls-remote`), the commits a push would send, the base branch, and the PR's title and body, all editable. The once-upon skill drafts the title and body every time it publishes a local story or rebuilds one (from the repo's PR template when it has one) and hands them over with `once-upon pr-draft --story <id> --title T --body-file F [--base BRANCH]`, so the button is ready. Without them, GitHub fills them from the commits. The box's button runs `git push -u origin <branch>` with your own git login when the branch needs it, then opens GitHub's compare page with the title and body filled in, and you make the PR there. It never force-pushes: if GitHub's copy of the branch has commits yours doesn't, the box says so and won't push, and a push is refused if the branch moved after the box opened. A body too long for the link is left out of it, with a **Copy body** button. Once the branch has an open PR (a read-only `gh pr list`), the header shows **Open PR #N** instead. This push, sent only from your click in the box, is the one way a page key reaches GitHub, and only the full key can do it: a page opened with a read-only link has the story's read-only key (see [The bridge](#the-bridge)), where the button says to open the story from the board or `once-upon page` to push. Nothing runs `gh pr create`.

## Stories waiting for review

Stories wait for review on the agent board (see [Agent board](#agent-board-the-work-to-merge)); there is no separate review page.

- **PR stories.** Built PR stories (`story.mjs build`, in any checkout the bridge knows) are on the board for 30 days after they were built. The card opens the PR's changes page, where the panel is.
- **Auto-marking PR stories.** A PR story is marked reviewed by itself when you have submitted a review on the PR after the story was built (approved, changes requested, or commented with a body: a reply in a thread is stored as a COMMENTED review with no body, so it doesn't count) or every file is marked Viewed on GitHub, checked in the background through a read-only `gh api graphql` at most every 3 minutes per PR. There is one check per PR, kept for that window and applied to every listed story of the PR, and the board counts it once. A story you have unmarked by hand is not auto-marked again. The same check drops a PR story whose PR has merged from the agent board's counts (a PR closed without merging drops once its head branch is deleted, which for a fork PR is the fork's branch, and stays while the branch is there). It runs when the board polls.
- **Local stories.** The stories `once-upon local` builds for a branch before any PR are on the board for 30 days after they were built. **Open story** opens the story's local page, and **Mark reviewed** ticks it off (kept in `~/.once-upon/state/<story id>/reviewed.json`).
- **Read-only links.** The read-only story key reads, asks, marks files viewed, takes Fix before push notes and asks for a rebuild, but is refused on Approve and the pull-request routes, so it can't push the branch. Nothing in the bridge hands out a link with it at the moment.

## First run: the board

You don't need a terminal to open it.

1. Install and connect the extension as in [Installing](#installing): load it unpacked, paste the bridge's port and token on its options page, and **Save**. Start the bridge (`once-upon serve`).
2. On the options page, click **Open board** (also Alt+Shift+B). The extension already holds the token, so it asks the bridge for a fresh page link and opens it in a tab.
3. That link carries the page's key in its `#fragment`. Where the bridge is reachable by a name (see [A clean address](#a-clean-address-for-the-board)) the page trades the key for a cookie in that browser and drops it from the address bar; on `http://127.0.0.1:<port>` it keeps the key for the tab. Either way the page works from then on.

The board page needs a key from the bridge, which the extension's Open board button supplies; start the bridge with `once-upon serve` first (nothing else prints a board link with a key). A board page that is opened without a key or cookie says "Not connected yet" and points here; it fills in by itself once the browser is connected.

The extension asks for the proxy's address (`https://once-upon.test`) only when config.json's `public_host` names one that resolves to this machine, so a setup with no proxy gets `127.0.0.1` and nothing to configure.

## Agent board: the work to merge

The extension's Open board button opens `/board/#key=…`. A card is a unit of work, a branch or a PR, with the Claude Code sessions and background agents working on it inside. A session that isn't on a branch of its own (the default branch, or no repo) is a card on its own. The columns follow the work to merge, and a card is in the first one that fits:

| Column | The card is here when |
|---|---|
| **Backlog** | someone kept it for later: an item in the backlog, not yet started (see below) |
| **Waiting** | a session on it is waiting on you (its tab status is waiting), or an agent on it is waiting on a question (`agent state --state waiting`; an agent parked on your story review, `--state review`, is not a question: see Ready) |
| **Research** | a finished research agent (`once-upon agent start --kind research`) with no card of its own to sit in and no result to point at: nothing is asked of you, and what it found is in its notes. Shown only when a card is in it, listed after Waiting and not counted as on you; it clears like any finished agent card |
| **Agent checks** | an agent on it is at an automated gate, with a chip saying which: `plan check` (an agent at `--state plan`, an author parked on the editor's check of its plan, on a claimed card too; an editor that needs your call sets `--state waiting` with the question, which is Waiting), `agent review · <reviewer>` (a running critic, `--kind critic`) or `fixing N findings` (`--state fixing`, on a work card or an agent's own card: a claimed backlog card at fixing stays in Working). The launching session, not you, is the next actor. Shown only when a card is in it, and listed after Working |
| **Working** | a session or agent on it is busy, or a claimed backlog card whose author is fixing a critic's findings (`--state fixing`: in progress until it lands) |
| **Done** | its PR merged; it drops off an hour later |
| **Ready for your review** | its PR story, or a local story of its branch, is built and you haven't reviewed it, or an agent on it is at `--state review` (**Back to you** instead when it was rebuilt after you last opened it) |
| **Ready to ship** | a local story you approved at its current commit, with no PR yet (still on this Mac); this column shows only when a card is in it, and the card drops off after 7 days or a new commit |
| **Back to you** | GitHub is waiting on your review by name (a request to a team you are in doesn't count), or someone asked something of you since your last activity on the PR (a review, a comment or a push of yours, or marking its story reviewed by hand). On a PR you opened, that is anyone's new review thread, a standing changes-requested review, or a reply to you. On someone else's PR it is only a person's reply (not a bot's or the AI review's) in an open thread you started or commented in. New threads you aren't in, and other reviewers' changes requested, are for the author and leave it in **PR open** |
| **PR open** | pushed, with a PR, and nothing waits on you |
| **Idle**, **Error** | no PR and nothing is happening, or an agent failed; these two columns show only when a card is in them |

**Backlog.** The leftmost column holds things kept for later, one card per item in its repo's lane (items with no repo are in General), with the title, note, who added it and when. **+ Add** in the column head opens a small panel (title, a repo menu, a note) that closes after an add or on Escape; **Repo** in the page header narrows every column to one repo's lane (remembered in the browser). Items live in `~/.once-upon/backlog.jsonl`, one JSON event a line, written by `once-upon backlog` in-process (no HTTP) and by the column's Add row and a card's Drop button, which use the board page's key and nothing else. `once-upon backlog add "TITLE" [--note TEXT] [--repo owner/name] [--branch NAME]` takes the repo from the checkout it runs in (`--repo ""` for none), `list [--all] [--json]`, `show ID`, `drop ID`. `once-upon backlog start ID [--branch NAME]` records that work began (the branch defaults to the checkout's, unless that is a default branch). A started item leaves the column and rides on the work card, or the session's card, for that repo and branch, with a "from backlog" line, so its story and column carry on from there. If no card exists for the branch yet it stays in Backlog for a day, marked started. Each card shows the `once-upon backlog start` line to paste into a session. `once-upon backlog claim ID --agent NAME [--branch NAME]` says an agent owns the card (the agent runs it first thing, and so does whoever launched it; `--branch` also starts the card): the board links a card and an agent only through a claim, never by the task text, the agent's name or its worktree folder. A claimed card is one card, in Working with its agent on it and no card for the agent. The latest claim wins, one agent may claim several cards, and a claim whose agent has not registered yet shows as pending for two hours. A claim is for one run of the agent (the first that had not ended when the claim was made): it ends when that run finishes or the card is done or dropped, so a rerun under the same name claims again. **Editors.** A session that runs a repo's build queue registers with `once-upon editor start [NAME] --slots N` (slots are required; it writes no ledger line, as it is no agent), and `once-upon editor slots [--json]` says how many its authors hold, with the same count the board shows. While its session is live the board shows a strip above the columns for it: its lane, `N of S slots` (an author that is running, at its plan check or fixing findings holds a slot; one at a question or a story review does not) and its authors, the authors launched under its session id or whose card its session claimed (`backlog claim` records the claimer's full session, and `--worktree PATH`, checked against `git worktree list` when given) (registered `--kind author`, or `builder` as an older alias; critics and helpers are not authors), each with where it stands. Each author's row says `by Editor · <repo>`, and an author's own card says `from Editor · <repo>`. A fix round or a rebase is a fresh agent registered with `agent start <name> --role fixer --card ID` (an author again, so it holds a slot) once the author's run is finished; resuming the author by message extends its whole context, so the editor does not. A restart of the author's own name still works and is the card's next run. **Assign** on an open card tells the voice session to start it: the bridge types `Start backlog card <id>: <title>` (the title cleaned and capped, the note never typed, then the line that tells the session to claim the card) into the voice session's iTerm tab, or, when voice is not on, into the most recent live interactive session that is at its prompt. The voice session may be mid-turn (Claude Code queues the line); either one is refused while it waits on you. The button is always on, there is no confirm, and the answer or the reason it was refused shows beside the button. The card then says "assigned to <session>, not started yet" for two hours, and the button reads **Send again**; the `start` takes over from there. Cards keep the order you give them within their repo lane: drag a card, or press Alt+Up or Alt+Down on a focused one, or `once-upon backlog move ID --before ID|--top|--bottom` (new items go to the bottom; `list` shows the order). Each repo heading in a column has a small toggle that hides that repo's cards and shows their count; it is remembered in the browser, per column and heading.

**Finished local stories.** A local story (a branch's story before any PR) waits in Ready for your review, never in Back to you, and a rebuild since you opened it is a line on its card. It leaves Ready when you mark it reviewed (the card's Mark reviewed, or `once-upon reviewed ID [--undo]`), or on its own when its branch has a pull request, open or merged (`pr`), when its head commit is already in origin's default branch as last fetched (`delivered`), or when nothing has opened, read, marked or rebuilt it for 3 days (`idle`, worked out when listed, never written). A mark or unmark by hand always wins, and a rebuild brings a hand-marked story back but not one a check marked. A local story of commits on a default branch, or of a commit range with no branch, has no branch to share, so it is a card of its own while it waits for review.

**Blank strip.** A session with no prompt yet (new, or just `/clear`ed) is not a card. The bottom of the Idle lane has one strip with the count and a chip per place (a repo or folder name, `×N` when several are there); a chip brings that iTerm tab forward, and a `×N` chip opens a menu of them. A session is blank when it is at rest and its transcript (`<projects dir>/<cwd as dashes>/<session id>.jsonl`) is missing or holds no assistant reply and no real prompt (commands like `/clear` don't count); it is read once and kept by file size. A session that is working or waiting, or one on a branch with a PR (it stays in that card), is not blank. If a transcript has been deleted, its session shows as blank.

Sessions share a card only when they are on the same live branch, one with a PR still open or a story. A session on any other branch (its PR merged or closed, or none) or on the default branch is a card of its own, titled by the session's iTerm tab or name, and goes to the bottom of the board when its tab says done or idle and nothing waits on it: to **Done** while it went quiet less than an hour ago (by Claude Code's registry, so its context is still in the prompt cache and picking it up is cheap), else to **Idle**, where picking it up re-reads its whole context. A column lists its cards by lane, with the lane's label right above its cards. A lane is the repo's name (the repo its checkout's `origin` points at, else the folder's name); an agent's registered `--lane` overrides it. **PR open**'s heading has **Hide N on their author** when someone else's PR there has nothing on you and no session of yours on it (the ball is in the author's court); the choice is remembered in the browser. A PR card shows the PR number, branch, how long it has been in the column, approvals against the required number, review state, checks, mergeable, and open threads. The page polls every 3 seconds and follows the system's light or dark theme. **Open in iTerm** (or a click on the card) raises the session's existing tab and never opens a window: it finds the tab from the session's tty, then runs `it2 window focus`, `it2 session focus` and `open -a iTerm` (`it2 app activate` doesn't take the front from your browser on current macOS, which is why `open` raises iTerm). The button reads "Switching…" meanwhile. **Listeners.** A story's own listener shows as "listening: <session>" on that story's card (a link to the session). A full-width Listeners lane at the bottom lists each repo with a live listener (which session, how long it has listened, when it last handled a request) and each repo that had one in the last 7 days (kept in `~/.once-upon/listener-history.json`), with **Stop listening** (the repo's wait ends within about 2 seconds and prints "Stopped listening", which the once-upon-listen skill treats as final) or **Start listening**. Start listening is one button per repo: with one idle session in the repo's checkout (or one clearly the most recently active, by at least 5 minutes) it asks to confirm and types into that session; with several close together it opens a small menu under the button, freshest first, each with its tab title, status and age. The board uses that popover (keyboard: arrows, Enter, Escape) instead of native dropdowns. The session that runs a listener is found from the wait's parent processes.

**Typing into a session.** A card with a session and a PR or branch but no story has **Build story**, and a repo row has **Start listening**. Each asks for confirmation, then the bridge types the skill's own line into the session's iTerm tab and presses Enter (`it2 session run`): `/once-upon <PR url>` (or, for unpushed commits, a sentence naming the branch) and `/once-upon-listen <owner/repo>`. The bridge builds the line itself, finds the tab from the session's tty, and refuses unless the session is at its prompt: working ("session busy") or waiting on you means no. Start listening offers idle sessions in that repo's checkout, on the board, the panel, the PR pages and the local story page alike (the local page asks `GET /api/stories/<id>/listen` and types with `POST` to it, since its key is the story's, not the board's), and never the voice session or one that already listens. A backlog card's **Assign** types its message into the voice session the same way (`POST /api/board/backlog/assign`, board key, the item id and nothing else: the bridge picks the session).

At phone width (under 800 px) the board is one column ordered by what needs you (Waiting, Back to you, Ready for your review, Ready to ship, then Working, Research, PR open, Done), with compact cards and 44 px tap targets; on a touch screen Open in iTerm is hidden.

- **Sessions** come from Claude Code's live registry, `~/.claude/sessions/<pid>.json` (`$CLAUDE_CONFIG_DIR/sessions` when that is set). A file counts only while its pid runs (`ps` also confirms the process started when the file says, so a reused pid doesn't revive it). A session's branch is its checkout's current one; it joins the card for the PR whose story (or GitHub) names that branch.
- **Status** comes from a status source. The registry alone says busy or idle. With iTerm2's `it2` CLI, the tab's own status (working, waiting, done, error, idle, with a detail line) is used instead, matched to a session by tty, and the tab's name becomes the session's title unless it's a generic one such as "Claude Code". The waiting column is whatever sets the tab's status to waiting, such as a `Stop` hook. The StatusSource shape lives in `src/adapters/status-source.ts`; another terminal is one more object like the one in `src/adapters/iterm.ts`, picked in `core/src/features/sessions/sources.ts`. With no useful tab name, the title Claude Code keeps in the session's transcript (its latest `ai-title` line) is used before the registry's name.
- **Context and usage (board status line)** come from Claude Code's status line, which is the only place that has them. A status line script writes them (or pipe its JSON input to `extras/statusline-snippet.sh`, which does the same) on every render to `~/.once-upon/statusline/<session id>.json` as `{session_id, at, context, rate_limits}` (`at` in seconds, `context` the percent used). Each session then shows `ctx N%`, the voice strip included, and a strip under the header shows the 5-hour and weekly limits with when they reset, from the freshest file under 6 hours old. Values from 70% show yellow and from 90% red. A gone session's file is removed after a day. In a bash status line, after reading stdin into `$input`:

  ```bash
  ou="${ONCE_UPON_HOME:-$HOME/.once-upon}"; sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
  if [ -d "$ou" ] && [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]]; then
    mkdir -p "$ou/statusline"
    printf '%s' "$input" | jq -c --argjson at "$(date +%s)" \
      '{session_id, at: $at, context: .context_window.used_percentage, rate_limits}' \
      > "$ou/statusline/$sid.json.tmp" && mv "$ou/statusline/$sid.json.tmp" "$ou/statusline/$sid.json"
  fi
  ```
- **PRs** come from the built PR stories (their branch and number), your own open PRs and the ones waiting on your review by name (one search every few minutes), and from GitHub through `gh`, one read-only GraphQL query per PR, plus one small one per session branch that has no story. That one keeps only PRs from the session's own repo (not a fork's branch of the same name) and prefers an open PR; a merged PR counts only when its head commit is the local branch's tip or behind it, so a branch name reused after a merge doesn't pick up the old PR. The board and the inbox share one check per PR. The bridge asks in the background, at most once per PR every 3 minutes, and the page reads what it has, so a poll never waits for GitHub; a PR's details fill in a few seconds after the board first sees it. `gh` runs with `GITHUB_TOKEN` dropped when `gh_unset_github_token` is true, and a branch's required approvals show only when GitHub exposes the branch protection rule to you.
- **Background agents** come from the agent registry, `~/.once-upon/agents.jsonl`, which only the CLI writes: the session that launches an agent runs `once-upon agent start <name> --kind author|critic|helper|research [--repo owner/name] [--branch B] [--pr N] [--card ID] [--lane NAME] --task "…"`, and the agent (or its launcher) reports with `once-upon agent state <name> --state waiting|review|plan|fixing --outcome "…"`, `once-upon agent beat <name> N/M <step> "<note>"` and `once-upon agent finish <name> --state done|failed|stopped --outcome "…" [--commit SHA] [--pr N] [--branch B] [--card ID] [--findings N]`. Every field is a field: the board reads no text to decide where an agent goes. `waiting` marks an agent that needs a decision: the card it is on moves to Waiting, with its question, until a later event clears it. `review` marks an agent parked on your story review: it shows as "ready for review" on its card (that card goes to Ready while it has no PR), never in Waiting, and marking its story reviewed clears it. A waiting or review agent whose last event is more than a day old is dropped from the board. `plan` (an author stopped at its plan, waiting on the launching session) and a running critic (`--kind critic`) put the card in Agent checks; `fixing` (a critic's findings being fixed) does too on a work card or an agent's own card, but a claimed backlog card at fixing stays in Working. An agent's latest beat shows on its card. Where an agent goes comes only from what it registered: its repo and branch, its PR, or its backlog card (`--card`), and when they name one card it is nested inside it; an agent that claimed a backlog card is shown on that card; any other agent is a card of its own on its own lane (its `--lane`, else its repo's lane, else its launching session's), with a "from <parent session>" link, while it runs, waits or sits at a gate. Once it is done, stopped or failed it stays for `board_finished_wait_minutes` (30) after its last event: in Done when it made something (a critic, or a finish with a commit, PR, branch or card), in Research when a research agent finished with no result (a helper that finished with none is Done), and in Waiting when it failed, was stopped, or is an author that finished with nothing (an author in Waiting stays for `board_done_hours`, an hour), showing its outcome, its notes path and when the card leaves; a later event gives it a fresh timer. **Finish** on that card (or on one waiting on a question) clears it at once, and closes a still-waiting agent with a `finish` event; the card comes back only if the agent does something more. Inside its card it stays an hour after it finishes (never less than `board_finished_wait_minutes`). With `board_ledger_file` and `board_progress_file` set, every event also appends a line to those files (`- [running] sid:<sid8> [lane:<name>] <name> (model, effort) — task — started 1:50 PM ET, 10/26`, `- [done] sid:<sid8> <name> — 1:33 PM ET, 10/26 — outcome — notes path`, and `- 1:34 PM <name> 3/6 code: note` for a beat): a log for people and scripts, written by the CLI. The board does not read them, so a line typed by hand puts nothing on it.

| Key in `config.json` | What it does | Default |
|---|---|---|
| `board_status_source` | `"iterm"` or `"registry"` | `iterm` when `it2` is found, else `registry` |
| `board_it2_path` | The `it2` CLI, when it isn't in an iTerm2 app folder | none |
| `board_sessions_dir` | The session registry | `$CLAUDE_CONFIG_DIR/sessions` or `~/.claude/sessions` |
| `board_projects_dir` | Claude Code's transcripts, to tell blank sessions | `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` |
| `board_ledger_file`, `board_progress_file` | Files the CLI appends a log line to for each agent event and beat (the board does not read them) | none: no log lines |
| `listen_idle_minutes` | How long a `wait --repo` keeps listening with no page showing one of the repo's stories (a page in a background tab still counts, through its once-a-minute "still open" call; it logs to `listeners.log` and prints "Stopped listening" when it stops; `--no-auto-stop` turns it off) | `10` |
| `board_larmor_dir` | The Larmor checkout (`~/Development/SideProjects/larmor`). The board runs its `.venv-app/bin/python app/voice_ctl.py` there for everything of Larmor's and reads none of Larmor's files: when `voice_ctl status` says voice is on, that session is pinned in a strip above the columns (labelled Voice session, with its repo, its status from voice_ctl (listening, speaking, working, paused or away), how many of its agents are running or waiting, and its last 20 lines: what it said aloud and what you said, from `voice_ctl log`) instead of sitting in a column; its agents keep their own cards. It also runs the strip's Pause, Resume, Start and Stop voice and the phone buttons. No answer from voice_ctl means no strip and no buttons | none: off |
| `board_done_hours` | How long a finished agent stays inside its card | `1` |
| `board_finished_wait_minutes` | How long a finished agent (done, failed or stopped) that is not inside a card sits on the board (Done if it made something, Research if it only looked, else Waiting), counted from its last event | `30` |
| `board_worktrees` | `false` leaves git worktrees off the board. Each one shows on the card it belongs to, or in a Worktrees lane, with its age, clean or dirty, merged or superseded, unpushed commits, PR and size. **Clean up** (one click, after a confirm) removes a clean worktree whose work is in the main line with `git worktree remove`, never `--force`, and deletes its branch with `git branch -d` only when merged | `true` |
| `board_keep_branches` | Repos (a name or `owner/name`) whose branches Clean up never deletes. `everfi-frontend` is always on the list | `[]` |

The board's page key, like a story's, is made from the bridge's token and reaches only the board's routes. It can get a local story's full page link (**Open story**). The board's key is the one that types into your Claude sessions, and only the bridge's token is handed it.

### A clean address for the board

A reverse proxy can give the board a name and a trusted certificate. With puma-dev, a file `~/.puma-dev/once-upon` containing the bridge's port (`4823`) makes `https://once-upon.test` (and `https://once-upon.fidev.net`, for `-d test:fidev.net`) reach the bridge. The bridge answers those names (`allowed_hosts`), and `public_host` picks the one the extension opens the board on.

The first visit comes from the extension's button or the printed link, `https://once-upon.test/board/#key=…`. The page posts the key to `POST /auth/session`, which checks that it is the board's page key and answers with a `__Host-` cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`, for that host alone. The page then removes the key from the address bar, so the URL is `https://once-upon.test/board/`, and later visits authenticate by cookie. The cookie is the board's page key, and the board's routes take it. A write authenticated by cookie must also carry an allowed `Origin`. The bridge's token and a story's key can't be turned into a cookie, and the API still takes a key in a header as before. The page shell at `/board/` carries nothing, so it loads without a cookie and says so when the API refuses it. The extension's links stay on `127.0.0.1`.

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

`once-upon serve` binds to `127.0.0.1` only. Every `/api` call needs `Authorization: Bearer <token>`, with one exception: a local page uses its story's page key instead.

**The local page never holds the token.** The page the bridge serves at `/local/<id>/` carries only the story id, so fetching it gives nothing away. Its key comes in the link's `#key=` fragment, which the browser never sends to the bridge: an HMAC of the story id under the token, printed by `once-upon local` and `once-upon page --story <id>`. The bridge takes a page key only on that local story's own `/api/stories/<id>/...` routes. It can't read or change another story, reach a bridge-wide route (builds, the story list, prefs, status) or add to a GitHub review.

A story has two keys, both HMACs under the token with their own labels, so neither can be turned into the other. The full key is what `once-upon local`, `once-upon page` and the board's **Open story** print: it can also push the story's branch (Create pull request's `git push`) and read where it stands. The read-only key is the same story's reading routes, Ask, Viewed and Fix before push notes, and a look at where the branch's PR stands (`GET .../pr`, so the page's Open PR link shows), with a 403 on what writes (`POST .../pr`: push, PR text, and `.../push`, both ways). A page opened with it says so, and its Create pull request button points to the board or `once-upon page` instead of failing on click. Listeners and the extension use the token as before, and rotating the token changes every page key.

The bridge also checks each request:

- It refuses any request whose `Host` isn't `127.0.0.1:<port>`, `localhost:<port>` or one of the exact names in `allowed_hosts` (below), which blocks DNS rebinding.
- It refuses any `Origin` that isn't this extension (its fixed unpacked ID, or one listed in `extension_ids`) or its own pages, so another installed extension can't call it.
- Writes must be `application/json`.
- It sends no CORS headers, so other web pages can't read its responses.
- Its pages are served with a strict CSP.
- An over-size body (past 256 KB) gets a 413.
- What it and the CLI write under `~/.once-upon` and a checkout's `.once-upon/` is the user's alone (files 0600, folders 0700), including folders that were there already.

| Call | What it does |
|---|---|
| `GET /api/health` | `{ok, version}` |
| `GET`/`POST /api/prefs` | page settings kept for every story: `{hideWhitespace, diffView}` (`unified` or `split`) |
| `GET /api/stories` | every story it can serve |
| `POST /api/stories/status-many` | `{prs: [{repo, number}]}`: each PR's story or build request (and settles a request whose story turned up), what's been read, `unread_answers`, newer commits, and who's listening per repo |
| `GET /api/status?story=ID` | the status light: the bridge, the story, and whether a Claude session is listening |
| `GET /api/stories/:id` | the panel's data, plus the diff, viewed files and notes for a local story |
| `GET /api/stories/:id/version` | changes when the story or (for local) the commits change |
| `POST /api/stories/:id/seen` | a hidden tab's "still open" signal, about once a minute: notes the story as seen for the listeners' idle window and does nothing else |
| `GET /api/stories/:id/pulse` | `{version, questions_rev, drafts_rev, fixes_rev, working_rev, listening, answering}`, one poll for what the panel watches. A field changes when that thing does. `drafts_rev` covers the drafts and your marks, not what's on GitHub |
| `GET`/`POST /api/stories/:id/ui` | the panel's step, width, collapsed and hidden state (the local page uses this, and the extension keeps its own in `chrome.storage`) |
| `POST /api/stories/:id/position` | `{step, chapter, file}`, written to `state/<id>/position.json` |
| `GET`/`POST /api/stories/:id/read` | the chapters you've read, each with the commit it was read at, and where an update would start (`since`); or record one: `{chapter, step, reason, seconds, head_sha}` |
| `GET`/`POST /api/stories/:id/questions` | ask a question, or list them with their answers (`once-upon answer` adds one), each marked `dismissed`, `collapsed`, `handed_to` and `unread` (an answer you haven't read), a question with no answer also with a `status` (`queued`, `working` with the session's latest note and `via`, the relay that sent it on to the story's agent, or `stalled`), and each answer with `by` |
| `POST /api/stories/:id/questions/marks` | `{action, ids}`: `dismiss`, `restore`, `collapse`, `expand`, `read` or `unread` those questions, `{action: 'read_all'}` to mark every unread answer read, or `{action: 'clear'}` to dismiss every one (the answer says which, as `cleared`) |
| `POST /api/builds` | ask for a story: `{repo, number, url, requested_at}` (`once-upon builds` lists them) |
| `POST /api/stories/:id/viewed` | local stories: `{path, viewed}` |
| `POST /api/stories/:id/notes[/:note]` | fix-before-push notes: add `{path, side, line, body}` (or `{chapter, index}`, a drafted comment), or update `{done}`, `{body}` or `{delete: true}`; a sent note only takes `{done}` |
| `GET`/`POST /api/stories/:id/fixes` | the notes with their state, `auto_send`, who a send goes to (`to`) and the recent requests; or `{action: 'send', ids?}`, `{action: 'auto', on}`, `{action: 'take_back', request}` |
| `GET /api/stories/:id/working` | the "being changed" marks that still stand, and the last one cleared |

The other commands are `list`, `page --story`, `token --rotate`, `publish --dir`, `inbox`, `wait`, `answer`, `notes`, `working`, `fixed`, `builds` and `done`. Run `once-upon` with no arguments to see them all.

### Long text on the command line

Free text that may be long goes in a file or on stdin, never in one long argument. `--note`, `--outcome`, `--task`, `--title` and `--text` each take `--<flag>-file PATH` (the file's text, minus one trailing newline) or `--<flag> -` (read stdin); short values stay inline. So `once-upon backlog edit ID --note-file plan.md`, `once-upon backlog add "TITLE" --note -  < plan.md` and `once-upon agent finish NAME --outcome-file out.md` all work, and `--body-file` (`-` is stdin) already did for `comment` and `pr-draft`. Give a flag one form, not both, and only one flag per run may read stdin; stdin that is empty is refused (nothing changes), while an empty file clears the value on purpose; CRLF reads as LF. `backlog add` takes its title as words, `--title`, `--title-file` or `--title -`. A backlog note may be up to 5,000 characters; an agent's task and outcome stay capped at 1,000 and say so by name.

The reason: some machines run endpoint security that SIGKILLs a `node` process (exit 137, no message) when a single argument passes about 1,000 bytes, before `once-upon` runs a line (seen with SentinelOne against the fnm-installed node: the same `node script.js "<1,000+ characters>"` dies, a copy of the binary at another path does not). Nothing in the CLI can catch that, so an agent or script that writes long text uses the `-file` form or stdin, with an argv of a few words.

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
| `allowed_hosts` | Host names the bridge answers besides `127.0.0.1` and `localhost`, for a reverse proxy that forwards the name you typed. Exact names only, compared in lower case; the list replaces the default | `["once-upon.test", "once-upon.fidev.net"]` |
| `public_host` | The allowed name the extension's Open board button opens the board on (over https), when it resolves to this machine. `"none"` prints the `127.0.0.1` address; `--local` does too, once | the first allowed host |
| `ship` | How a local story ships, per repo: `{"shank-eric/Configuration": "push", "EverFi/*": "pr"}`. The keys are globs on `owner/repo` (`*` matches within one part, case does not matter), and the first match in file order wins. `push` gives the story the **Push** button, `pr` gives it **Create pull request**. A repo with no match ships by branch (see **Push** below) | `{}` |
| `extension_ids` | More extension IDs the bridge answers, such as a Chrome Web Store install or an older unpacked copy. Any other extension is refused | only `faaibhigocihefldbmdgchcnnclalkmo`, the unpacked build's fixed ID |

**House rules** are how you make the skills yours without changing the repo. The skills here are generic: they never post, submit or push, and they draft comments for you to post. Anything about your own setup goes in the house rules file instead: where your checkouts live, how to look up people's names from their GitHub logins, the voice for drafted comments, a past story to model new ones on, things never to run. The skills read it first and follow it alongside their own rules, but it can't loosen the read-only rules.

## Q&A relay

Questions and notes from the panel each end up as one JSON line in `~/.once-upon/inbox.jsonl`, with an `id`, a time and the story id. Readers keep their own cursor, so several can read the same file without stepping on each other.

**What works today, with no change to Claude Code settings.** A Claude Code session telling the story runs this as a background task:

```bash
once-upon wait --story <id> --type question,build_request
```

It blocks until a new question on that story arrives, then prints the question and exits. A story's own wait comes before the repo's listener (see [One story, one session](#one-story-one-session)). A consumer's first wait starts from now, not from old questions. The exit wakes the session. Claude answers in chat and runs `once-upon answer --question <id> --file answer.md`, so the answer also shows in the panel under the question, flagged New until you have had it in view (the dock header, the board card and the PR list's tag say how many are unread). While it works, `once-upon asking --question <id> --note "reading auth.ts"` shows what it is doing under the question, with who has it and for how long, until the answer clears it. Then it starts the wait again. The once-upon skill's SKILL.md describes this loop.

**Proposed next steps.** Nothing in Claude Code's settings, hooks or MCP config has been changed. These are for you to decide:

1. **A `UserPromptSubmit` hook.** It would run `once-upon inbox --unread --consumer hook --type question`, and anything it prints would be added to the prompt's context. Questions typed in the panel would then reach the session with your next message, even if no wait is running. It's cheap, but it only fires when you send a prompt.
2. **A small MCP server (`once-upon mcp`, not written yet).** It would read the same inbox and cursors, and offer tools: `next_question` (blocking, with a timeout), `answer`, `current_position` and `fix_before_push_notes`. If Claude Code's MCP servers can push messages into a live session, it could also deliver each question the moment it's asked. That needs checking against the current Claude Code docs before building.

Both read `inbox.jsonl` the way `wait` does. The format is described at the top of `packages/server-libs/state/src/queues/requests/inbox.ts`.

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

## Running a build queue

`/once-upon-editor <slots>` (the third skill, linked by `scripts/link-skills.sh`) turns a Claude Code session in a repo into its build queue's editor: it takes cards from `once-upon backlog`, launches authors, critics and storytellers as background agents up to the slot count, plan-checks, deploys and refills, and edits nothing itself. The board shows the editor and its authors.

- **Profiles.** The editor needs to know a repo's deploy command, claim command and card order. It reads `~/.once-upon/editor/<repo folder name>.md` (`$ONCE_UPON_HOME/editor/`), then `skills/once-upon-editor/repos/<repo folder name>.md`; with neither it copies `repos/_template.md` to the first and asks you to fill it in. `repos/once-upon-a-diff.md` ships for this repo. Your own profiles stay in `~/.once-upon/editor/`, never in the repo. An optional `~/.once-upon/editor/_user.md` (`repos/_user-template.md`) names a relay session and the folder for critic reports (default `~/.once-upon/reviews`).
- **Beats.** `once-upon beat <name> <N>/<M> <step> "<note>"` is the agent's progress beat (a bare N means N/6, the last beat is M/M, the step is one word). It appends `- 3:40 PM <name> 3/6 code: <note>` (Eastern time, as `once-upon agent beat` writes it) to the file `board_progress_file` names in `config.json` (no setting, no file) and registers the beat on the agent's open run (`once-upon agent start` first). An agent that was never registered still gets its line, with a warning on stderr. It prints nothing and never reads the folder it runs from. `once-upon` needs Node 24: from a shell that may be on another Node (a repo with its own `.node-version`), run `fnm exec --using=24 once-upon beat ...`, and a failing beat means Node 24 was not found.
- **The heavy lock.** `once-upon heavy <name> <command...>` runs a heavy command (full test suite, browser run, whole-repo typecheck or lint, deploy gates) only when no other one holds the lock, so parallel agents in any repo take turns; its exit code is the command's, and a SIGINT, SIGTERM or SIGHUP goes on to the command. The lock is the directory `${XDG_CACHE_HOME:-~/.cache}/heavy-run.lock` (set `ONCE_UPON_HEAVY_LOCK` to move it) holding `pid` and `who`, a stale one is taken over, and it waits `ONCE_UPON_HEAVY_POLL` seconds (default 5) between tries. Everything after the name is the command's own command line. Run through `fnm exec --using=24` so that the command keeps the Node of the caller's shell: `ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy <name> <command...>` (when `ONCE_UPON_PATH` is set and not empty, it is the PATH the command gets).
- **Fresh agents.** After a plan check the editor finishes the planner and starts a fresh author from the plan file; fix rounds and rebases go to a fresh fixer with the critic's file:line list. Briefs hand over file and line lists, and agents read line ranges, so no agent carries a long context into the next round. Each role launches as its own lean agent type from `agents/` (`once-upon-author`, `-critic`, `-storyteller`, `-helper`, `-clerk`), which starts at about 16k tokens where a general-purpose agent starts at about 56k. `scripts/link-agents.sh` links them into `~/.claude/agents` next to your own definitions (a new agents folder needs a Claude Code restart; if `~/.claude/agents` is itself a link, the files land in its target); without them the editor falls back to general-purpose agents.
- **Extras** (optional, in `extras/`): `subagent-statusline.py` shows each subagent's newest beat in Claude Code's subagent panel (set it as `subagentStatusLine`; it reads `board_progress_file` and `board_ledger_file`), `hooks/require-beats.sh` is a `PreToolUse` hook for the Agent tool that stops a brief with no `once-upon beat` line, and `statusline-snippet.sh` writes the board's context and usage file from your status line's JSON. An iTerm tab-status hook for the board's `iterm` source is coming as its own change.

## Development

[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) has the day-to-day workflow. The commands, from the repo root:

```bash
yarn dev               # the extension, rebuilt into packages/client/extension/.output/chrome-mv3 on each change and reloaded
yarn build             # the extension, built once
yarn zip               # the Chrome Web Store zip (no fixed key), in packages/client/extension/.output/store/
yarn bridge            # the bridge (Node 24 runs its TypeScript directly; there's no build)
yarn test              # every package's unit tests (node --test)
yarn typecheck         # tsc over every package (strict), the local page and the skill helper
yarn lint              # ESLint (cached); yarn lint:fix fixes what it can
yarn format:check      # Prettier's check (100 columns); yarn format rewrites
yarn lint:sh           # shellcheck over the once-upon skill's shell scripts
yarn test:extension    # builds the extension, then loads it into a throwaway Playwright Chromium, never your own Chrome
yarn test:expand       # the same Chromium: panel links expand collapsed files and hunks on /files and /changes
```

A pre-commit hook (husky and lint-staged, installed by `yarn install`) runs ESLint and Prettier's check on the staged files. CI (`.github/workflows/ci.yml`) runs install, lint, typecheck, the format check, the tests and the extension build on every push and pull request. `AGENTS.md` has the standing rules for an agent working here, and `scripts/deploy-local.sh` puts a commit live on your own machine: `--yes <branch-or-sha>` fast-forwards main and respawns the bridge, `--batch <base> <sha>...` cherry-picks and runs the gates first, and `--rollback <sha>` goes back. It never pushes.

`test:extension` needs Playwright's Chromium:

```bash
PLAYWRIGHT_BROWSERS_PATH=/some/dir node node_modules/playwright-core/cli.js install chromium
```

Run it with the same `PLAYWRIGHT_BROWSERS_PATH`. It starts a bridge on a random port with a temporary home, and builds a two-chapter story for a public PR (`--pr owner/repo#N`, default `shank-eric/inbox-in-gmail#91`). It then checks:

- the options page, and that the extension loads with its fixed ID
- the panel on `/files` and `/changes`: docking, filtering, coming back after a reload, the `hidden` attribute and hash skipping
- a question and its answer
- hiding the panel and toggling it back
- that the GitHub page itself makes no calls to the bridge
- the local page: diff, filter, Viewed, a note, and coming back after a reload
- the options page's Test connection before Save
- pixel checks: 14 screenshots (the panel on the PR page, the local page, its Q&A and a bridge error, the board, a toast and a story tag, each in light and dark) against the PNGs in `packages/server/bridge/test/browser/pixels/<platform>/`. `UPDATE_SNAPSHOTS=1 yarn test:extension` rewrites them; a miss writes the actual and diff images to `packages/server/bridge/test-results/pixel-diff/`

`test:expand` uses `refined-github/refined-github#10298` and checks that line links above, between and past its hunks, on both sides, and file and line links into a collapsed file open and highlight their target, with no expanding on a step change, `?w=1` kept and no Viewed toggle touched. Logged out, GitHub sends `/changes` to `/files`, so the React `/changes` DOM is checked by hand.

## Code layout

Nineteen Yarn workspaces under `packages/`, in five folders (`server`, `server-libs`, `client`, `client-libs` and `domain`, each holding packages as `packages/<group>/<name>`: ADR-28), all TypeScript (strict), and the skills at the root. Each package has its own dependencies, tests and tsconfig, extending the root's `configs/tsconfig.base.json`.

To trace a click or a command through the code, start with [`docs/flows.md`](docs/flows.md): five requests (Build a story, Ask, Board refresh, Start listening, and an agent's claim through to its card landing), each hop with its file, line and layer. [`docs/state-map.md`](docs/state-map.md) lists every file the tool reads or writes, and [`docs/adr/`](docs/adr/) records why it's built the way it is.

- `packages/domain/contracts/` (`@once-upon-a-diff/contracts`): the contract between the bridge and everything that calls it. It imports no other package but the terms package (and Valibot, for its schemas), and uses no DOM and no Node (its tsconfig has neither). Its `exports` point at the `.ts` sources, which WXT bundles and the bridge serves type-stripped.
  - `src/types.ts`: the story and the bridge's answers as the panel takes them. It is the index: the types live in an area folder each (`story/`, `panel/`, `review/`, `bridge/`, `github/`, `board/`), and `types.ts` exports them all.
  - `src/routes.ts`: the route table, assembled from each area's `routes.ts` (`bridge/`, `github/`, `board/`, `story/`; the entries are built with `route-kit.ts`). Every call the bridge answers, with its method, path, which keys may make it (the token, the board's key, a story's key, its read-only key), the body it takes and the answer it gives. The bridge registers its handlers from it, and the extension, the board and the local page call through it with the `bridge-client` package's `client.ts`. The bridge serves `routes.ts`, `route-kit.ts` and the area route files to the pages.
  - `src/schemas.ts`: a Valibot schema for each request body, assembled from each area's `schemas.ts` (the readers they share are in `schema-kit.ts`). The bridge checks every body against one (`server/validate.ts`) after its key and story checks. It's server only: `routes.ts` takes the body types from it with `import type`, so a page never loads Valibot, and the bridge doesn't serve it.
- `packages/domain/terms/` (`@once-upon-a-diff/terms`): pure rules, with no imports at all (the lint and its own test say so), so the bridge, the pages, the panel and the extension share them: the id patterns, the `html` tag and escaping with the markdown renderer, text helpers (SHAs, plurals, gate text), times (and the board's time text), the choice of a session to listen for, PR keys and commit ranges, line references, chapter keys and numbers, the parts file's rules, and the default port. Flat `src/` with one module per area. The contracts package and everything else import it by name, and the bridge serves all of it to the pages at `/assets/terms/`.
- `packages/client-libs/bridge-client/` (`@once-upon-a-diff/bridge-client`): how a browser calls the bridge, and keeps what it shows current. It imports the contracts package's route table and the terms package and nothing else of the repo, and the panel, the pages and the extension import it. Its `exports` point at the `.ts` sources like the contracts package's do: WXT bundles them and the bridge serves them, type-stripped.
  - `src/client.ts`: `createClient(transport)` (calls over a transport each host supplies, as `call` that never throws and `ask` that throws a `BridgeError`), `pathFor`, and `matchRoute`, which the extension's service worker asks before it sends the token.
  - `src/poll.ts`: `createPoll`, a look at the bridge on a timer with no framework in it: it loads at once, every few seconds while the tab is visible and when the window gets the focus, keeps the last data through a failed load and counts the failures in a row.
  - `src/use-poll.ts`: `usePoll(load, { everyMs })`, the Preact hook over it (the board page's poll). It imports Preact as the pages do (`/assets/preact.mjs`), so only a page loads it.
- `packages/client-libs/ui-kit/` (`@once-upon-a-diff/ui-kit`): what the board, the local page, the panel and the extension share. `src/components/` holds the generic Preact components with no region state (`Busy`, `LinkButton`, `Banner`, `Chip`, `Meter`, `Elapsed`, `CopyButton`, `Dialog`, `MenuButton`, `PartsStrip`) and `src/css/ui.css` their stylesheet; the DOM and clipboard helpers, Start listening and `parseMarkup` sit beside them in `src/`. Time text and the markdown renderer are pure and live in the domain (`time.ts`, `html.ts`). It imports the contracts package, the domain and the vendored Preact only. The pages load it at `/assets/ui-kit/` and the extension by package name, so there is one Preact.
- `packages/client/github-page/` (`@once-upon-a-diff/github-page`): the host adapter for GitHub, so a change in GitHub's markup lands in one package. Its `exports` point at the `.ts` sources the same way the contracts package's do: WXT bundles them into the extension and the bridge serves them, type-stripped, to the local page. It implements the panel's port (`panel/src/host/host.ts`, `panel/src/host/diff-types.ts`) and imports nothing else of the panel.
  - `src/diff-dom.ts`: the diff-page reader, finding files, lines, Viewed toggles and expand controls on GitHub's `/changes` and `/files` and on the local page, whose diff view has `/changes`' shapes. Both apps hand it to the panel; the panel never imports it.
  - `src/pages.ts`: what a github.com path says about the page (Files changed, Conversation, a PR list), which the extension's content scripts route on.
- `packages/client/panel/` (`@once-upon-a-diff/panel`): the story panel, with no host in it. It imports the contracts package and the terms package only (never an app, the bridge or `github-page`), and the lint says so. It also holds what its host and the apps need: `dom.ts` and `clipboard.ts` (browser helpers), `host/diff-types.ts` (what a host page's reader returns) and `state/story-model.ts` (the story as the panel reads it).
  - `src/shell/overlay.ts` is the entry (`storyOverlay(story, options, host)`). It builds one context (`host/context.ts` types it, with the host's options) and wires the parts below.
  - `src/host/host.ts` is what an app injects: `PanelHost`, the host page's diff adapter (`createPage`) and the bridge's typed client with the story's id and address. `src/host/bridge-options.ts` builds from it the panel's calls every host makes the same way; the extension (`content/pages/files-changed.ts`) and the local page (`web/public/local/mount.ts`) spread it and add what is their own.
  - Shared files: `state/panel-state.ts` (the saved step and layout), `shell/layout.ts`, `shell/shell.ts` (the frame and toolbar, with `ui.css` (the shared pieces' look) then `panel.css` in its shadow root and `page.css` (docking, hiding, flashing) in the page's head; the host says where it serves them), `shell/body.ts` (the step on screen), `components/file-refs.ts` and `components/markdown.ts` (the story's text and its jump links), `components/viewed-button.ts`, `components/status-light.ts` (Start listening, the clipboard and the DOM helpers are in `packages/client-libs/ui-kit`).
  - Regions, one folder each, importing no other region and not `shell/overlay.ts` (the lint checks):
    - `ask/`: the Ask box (`questions.ts`, `question-list.ts`, `chat-dock.ts`).
    - `drafts/`: drafted comments (`drafts.ts`) and the Overview's Copy as gh script (`review-script.ts`).
    - `fixes/`: Fix before push (`fixes.ts`) and the "being changed" marks (`working.ts`).
    - `reading/`: moving and finding your place: `navigation.ts`, `scroll.ts`, `filter.ts`, `expand.ts`, `file-list.ts`, `viewed.ts` (Viewed progress) and `reading.ts` (read tracking).
    - `rebuild/`: `rebuild.ts` (Rebuild), `freshness.ts` (is the story current) and `marks.ts` (the "changed since" marks).
- `packages/domain/test-kit/` (`@once-upon-a-diff/test-kit`): the dev-only test helpers every package's tests share (temp folders and JSON files, git fixtures, a linkedom DOM). A package lists it under `devDependencies` only, and the layer rules (`configs/.dependency-cruiser.mjs`) refuse an import of it from anything that ships.
- The engine, in seven packages (ADR-24). Bottom to top: a package imports only the packages under it (`configs/layers.mjs` is the list, `packages/server/bridge/test/package-layout.test.ts` pins the folders). Their rules run no program, write no file and reach no network of their own (`eslint.side-effects.mjs`, probed by `packages/server/bridge/test/side-effects-lint.test.ts`), and the apps import them by name (`@once-upon-a-diff/stories/store`).
  - `packages/server-libs/adapters/` (`@once-upon-a-diff/adapters`): every side effect, one module per outside system: `github.ts` (gh), `git.ts`, `iterm.ts`, `larmor.ts`, `claude-sessions/` (live sessions, blank sessions, transcripts, status line and titles), `stores/` (JSON files, atomic writes, the backlog, the agent registry and the ledger log) and `os.ts` (programs, pids, ports, the browser). The apps never import it.
  - `packages/server-libs/foundation/` (`@once-upon-a-diff/foundation`): where things live and the shared vocabulary: `settings.ts` (the home folder, config.json, prefs), `repos.ts` (which repo a checkout is, `checkouts.json`), `gh.ts` (gh as the logged-in user), `ids.ts`, `errors.ts` (`BoardError`), `input.ts` (checks on what a caller hands in), `shared-files.ts` and `node-version.mjs` (the Node check every entry runs before it loads TypeScript).
  - `packages/server-libs/stories/` (`@once-upon-a-diff/stories`): finding, reading and rebuilding story folders, local stories, reads, comments, approval and the parts file.
  - `packages/server-libs/state/` (`@once-upon-a-diff/state`): `src/records/` (one folder per thing the bridge keeps or reads: `agents/`, the agent registry folded from `agents.jsonl`; `github/`, GraphQL checks through gh, PR facts, merge rules, the pending review; `worktrees/`; `listeners/`, who is listening, their history and which agent a story is bound to; `page-links/`, the pages' keys and the address the board opens on) under `src/queues/` (work waiting for someone: `requests/`, the panel's mailbox for a session: the inbox, build requests, fix requests, the relay, `working.ts`, the wait loop's `auto-stop.ts`; and `backlog/`, the cards, claims, landing by commit and the links to the worktrees and agents working a card). `test/helpers.ts` registers agent runs for tests.
  - `packages/server-libs/core/` (`@once-upon-a-diff/core`): `src/features/` (what the reviewer does with those: `review/`: review state, drafts, freshness, Approve and the background check of GitHub; `sessions/`: the Claude sessions the board can type into; `publishing/`: a finished story arrives: place the folder, settle its build request, carry the drafts; `listeners/`: listening, behind `service.ts`) and `src/orchestration/bridge/` (serve, `setBridgeFactory` and `doctor.ts`). `test/`: its unit tests.
  - `packages/server-libs/board/` (`@once-upon-a-diff/board`): the agent board's data: `board.ts`, the columns built in `stages/`, `agent-home.ts` and `voice.ts`. Only the HTTP app imports it.
  - `packages/server-libs/usage/` (`@once-upon-a-diff/usage`): the usage capture (ADR-18): coverage capture, counters, the report, with its own `src/adapters/` (the inspector session and the usage files). It sits beside the stack: only the apps and the shell import it.
- `packages/server/server/` (`@once-upon-a-diff/server`): the HTTP app, over the engine. `src/index.ts` is the server (its guards, then a route table), the routes are in `src/routes/` by area, and `pages.ts` and `assets.ts` serve the HTML pages, the scripts (type-stripped) and the stylesheets. `validate.ts` checks each body against the contracts package's schemas.
- `packages/server/cli/` (`@once-upon-a-diff/cli`): the CLI app, over the engine. `src/index.ts` is a table of commands in `src/commands/` that also builds the help.
- `packages/server/bridge/` (`once-upon-a-diff`, bin `once-upon`): the shell. Private for now; the name is free on npm, for an `npx once-upon-a-diff` later.
  - `bin/once-upon.mjs` (the `once-upon` bin) is plain JavaScript: it checks the Node version (`foundation/src/node-version.mjs`), then loads `bin/once-upon.ts`, the one place that knows both apps (it hands the server's `createBridge` to the CLI through core's `setBridgeFactory`). `configs/.dependency-cruiser.mjs` keeps each package and tier to its place: neither app, nor an engine package, imports the shell.
  - `instrumentation/`: the usage probe the bin preloads.
  - `test/`: the integration tests (they start a bridge with `startBridge`, run the CLI with `runCli`, or drive the board), their helpers, the fake `gh`, the board-world fixtures and `/api/board` goldens, and the browser tests.
- `packages/client/web/` (`@once-upon-a-diff/web`): the pages the bridge serves, with their own browser tsconfig. The page URLs are unchanged (`/board/`, `/local/...`): the server package's `src/assets.ts` serves `public/` from here, and `/assets/local/...` is `public/local/`, folder for folder.
  - `public/local/` is the local story page, one Preact tree drawn from one store. `local.ts` is the start (it loads highlight.js, the story and the panel's saved state, then draws and mounts the panel), `store.ts` the state (`createStore`: every change is a `set`, drawn in the same microtask, or by `flush()` when the panel is waiting on the DOM) and `actions.ts` what changes it (the calls to the bridge). `app.ts` is the root (`LocalApp`, which mounts the panel again after the story was read again and starts the polls) and `top.ts` the top bar. Beside them: `local.css` (the header's pieces and the layout), `page.ts` (the bridge client and the panel handle), `mount.ts` (the panel mount), `polls.ts` and the helpers the board page shares (`auth.ts`, `not-connected.ts`, `stored.ts`). `diff/` is the diff (with `diff.css`, its palettes and rules): `rows.ts` (a file's table rows as data, with notes and folds), `table.ts`, `files.ts` and `tree.ts` (the components), `notes.ts`, `highlights.ts`, and the split, narrow and syntax helpers (pure). `ship/` is Approve, Push (and push ahead) and Create pull request, with `ship.css`; their three confirm boxes are Preact, drawn by `ship/dialogs.ts` from the store with `ship/action-dialog.ts` (`ActionDialog`, on ui's `Dialog`).
  - `public/board.ts` is the agent board page: the bridge transport, the poll and a root Preact component (`BoardApp`), over the regions in `public/board/`, one folder each and none importing another (the lint checks). Each region is a Preact component: `header/` (usage and the phone controls), `columns/` (the columns, lanes and cards), `backlog/` (the Backlog card, Assign and the Add form), `worktrees/` (the Worktrees lane) and `voice/` (the voice panel, a Preact component). Styles: `public/page.css` is the base both pages link (after ui-kit's tokens.css and ui.css), `board/board.css` the board's shared card, column and lane rules, and `voice/`, `backlog/`, `header/` and `worktrees/` each a sheet for what only that region draws; `server/src/pages.ts` lists each page's sheets, and a rule lives in exactly one. `board/shared.ts` holds what two regions use (the usage meter, the focus button, `useSetting` for the remembered settings and the `Api` object).
  - `public/vendor/`: the vendored highlight.js and Preact (`yarn vendor` rebuilds them; `preact.mjs.sha256` is checked by a test and by the deploy).
  - `scripts/` builds the vendored files, and `test/` has the page tests (the board and the voice panel in a linkedom DOM).
- `packages/client/extension/` (`@once-upon-a-diff/extension`): the extension, built by WXT from `wxt.config.ts` (which writes the manifest) into `.output/chrome-mv3`, the folder to load unpacked.
  - `src/entrypoints/`: `background.ts` (the only code that makes network calls, and only to `127.0.0.1`), `content.ts` (the content script on github.com) and `options/` (the options page). `src/settings.ts` keeps the bridge's port and token.
  - `src/content/index.ts` routes by page kind: Files changed, Conversation, PR list, or other.
    - `bridge.ts` sends bridge calls through the service worker. `storage.ts` keeps the panel's state per PR and the Hide whitespace copy.
    - `pages/files-changed.ts` docks the panel and puts the story tag by the title when the panel is hidden. `pages/hide-whitespace.ts` keeps `?w=1` in step with the setting.
    - `pages/conversation.ts` and `pages/pull-list.ts` put the story tag by a PR's title.
    - `pr-tags.ts` is the tag controller every PR page shares (the status poll, the Build story click and the listen notice's looks). `tag-model.ts` says what a tag shows and does, as data with no DOM.
    - `components/` holds the elements the content script puts on GitHub's page, each one Preact with no markup string: `story-tag.ts` (the tag and its answers badge), `tag-host.ts` (the host span with its own shadow root that draws a tag), `listen-notice.ts` and `toast.ts`. Each one with its own shadow root links its CSS from a `.css` file beside it, which the build copies into the extension as is. The host element and its shadow root are made by hand, since GitHub's page is a host we do not control; `test/no-string-dom.test.ts` pins where.
  - `src/public/icons/` (`yarn workspace @once-upon-a-diff/extension icons` redraws them).
  - `test/`: the unit tests for the tag, its components (in a linkedom DOM) and Hide whitespace. The browser tests that load it (`yarn test:extension`, `yarn test:expand`) are the bridge's, in `packages/server/bridge/test/browser/`, since they start a bridge.
- `agents/`: the Claude Code agent definitions the editor launches by type, linked by `scripts/link-agents.sh`.
- `skills/once-upon-listen/`: the Claude Code skill behind **Start listening**.
- `skills/once-upon/`: the Claude Code skill that writes PR stories. Its `bin/story.ts` (run through `bin/story.mjs`, behind the same Node check) imports the bridge's and the contracts package's chapter code from this checkout. Both skills read your house rules (see [Personal settings](#personal-settings)).

## Credits

- The panel started as the once-upon skill's GitHub overlay.

## License

MIT
