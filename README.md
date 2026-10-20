# Diff Story Mode

A code-review story (an overview, then chapters) in a side panel docked on top of a diff, with the diff filtered to each chapter's files. It works in two places:

- **GitHub PRs.** An unpacked Chrome extension docks the panel on a pull request's `/changes` or `/files` page whenever a story exists for that PR.
- **Local commits.** The bridge serves its own diff page for a local commit range, before anything is pushed, and the same panel runs on it.

The two work the same way and read the same `chapters.json` (pr-story's format). The panel comes back on the same step after a reload, after GitHub's in-page navigation, and when the story on disk changes.

The panel is a port of the pr-story skill's GitHub overlay (`~/.claude/skills/pr-story/bin/overlay.js`). It has the same Overview step, the same per-file "Mark viewed / Leave unviewed: comes back in chapter N / Already finished" status, and the same file and line jumps. It adds a saved step, an Ask box, and a shadow root so the page's CSS can't reach it.

## Installing

You need Node 20 or newer. The bridge has no runtime dependencies. `yarn install` only fetches eslint and playwright-core for development.

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

An alias saves typing: `alias diff-story="node ~/Development/SideProjects/diff-story-mode/bridge/bin/diff-story.mjs"`. The rest of this README uses `diff-story`.

## Using it on a PR

1. Make a story with the pr-story skill. Its `render` step copies `chapters.json` and `file-map.json` to `~/.diff-story/<owner>-<repo>-<N>/`, and you can also run `pr-story.mjs publish --dir <D>`. The bridge also reads pr-story's scratch folders directly.
2. Open the PR's **Files changed** tab. The panel docks on the right at the Overview step.
3. Prev and Next (or the Steps list) filter the diff to a chapter. "Show all files" undoes the filter.
4. To hide the panel, use **Hide story** (it collapses to a strip) or **×** (it goes away and that's remembered for the PR). The toolbar button or **Alt+Shift+S** shows or hides it.
5. Type a question in the Ask box and press **Cmd+Enter**. The question goes to the bridge inbox, and the answer shows under it once a Claude session replies (see [Q&A relay](#qa-relay)).

When Claude rewrites `chapters.json`, the panel redraws within ≈5 seconds without losing its step.

### Story ready, Building, Build story

Every PR Files changed page gets a small status control in the bottom-right corner, shown whenever the panel isn't:

- **Story ready · Read it** opens the panel. You see it when a story exists and the panel is hidden.
- **Building story · asked 5:44 PM** means someone asked for a story and it isn't there yet. While it's Building, the page asks the bridge every ≈10 seconds, and when the story turns up the panel opens by itself. That's the only polling a page without a story does.
- **No story yet · Build story** asks for one. The extension sends `{repo, number, url, requested_at}` to the bridge, which appends a `build_request` line to the inbox and keeps a pending marker in `~/.diff-story/builds.json`. Every tab on that PR then shows Building.

A Claude session fulfils the request. `diff-story wait` hands it build requests the same way as questions, and `diff-story builds` lists the pending ones. The session writes the story with the pr-story skill, whose `render` publishes it. The request then counts as done as soon as the bridge sees the story, or the session can say so with `diff-story done <id>` (`--failed --note "…"` if it can't be done). The × on the control hides it until the page reloads. The control is the extension's own button in its own shadow root, and it never clicks anything of GitHub's.

**autoBuild (off).** The bridge can run a command for each new request itself. It's off unless `~/.diff-story/config.json` turns it on:

```json
"autoBuild": { "enabled": true, "command": ["claude", "-p", "/pr-story {url}"], "cwd": "~/Development" }
```

The command is an argv array and is never run through a shell. `{url}`, `{repo}` and `{number}` in its arguments are replaced. The values are also in `DIFF_STORY_URL`, `DIFF_STORY_REPO`, `DIFF_STORY_NUMBER` and `DIFF_STORY_BUILD`. Output goes to `~/.diff-story/builds/<id>.log`, and a non-zero exit marks the request failed. Restart the bridge after changing it. It's left off because it runs a Claude session without anyone at the keyboard. Whether that's wanted, and with what permissions, is Eric's call.

## Local mode: commits before you push

```bash
diff-story local --repo ~/Development/web-app-worktrees/no-useless-assignment --base 3a669da7625 --head HEAD --chapters chapters.json
```

This builds `git diff <base> <head>` into `~/.diff-story/local-<repo>-<branch>/`. If no bridge is running, it starts one, then opens `http://127.0.0.1:<port>/local/<id>/`. The page draws the diff with the same DOM shapes as GitHub's `/changes` page, so the same panel code runs on it unchanged.

- **Viewed** toggles are kept by the bridge. A file whose diff changes after you marked it shows as "changed since viewed" and is unviewed again.
- **Comments become "fix before push" notes.** Click a line number to add a note. Notes are listed under "Fix before push" at the top, can be ticked done, and go to the inbox. `diff-story notes --story <id>` prints them as a checklist. Comments drafted in `chapters.json` show in the panel as "Fix before push (drafted)".
- **The page follows the branch.** Amend or add a commit and the page redraws with the new diff within ≈5 seconds.
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

It scans `~/.claude/projects` (main and subagent transcripts) for ones that mention a checkout of the repo (any worktree) or a commit SHA in the range, then reads each candidate with [session-story](https://github.com/nalaj/session-story)'s extractor through its CLI (`story.mjs extract --no-chain`, `~/.claude/skills/session-story` or `SESSION_STORY_DIR`). A session counts only if, in the commits' time window, it edited a file of the diff, ran a `git commit` whose subject or printed SHA is in the range, or ran a write-ish script naming a diff file. Lint, test and build runs count only beside that work and only in the checkout where it happened. Each edit's and commit's added lines are found in the final diff, which gives line ranges. From the raw transcripts it also takes what was said (prompts, Larmor voice), the task and messages the main session sent each agent, and the agents' hand-back reports. With no match (a PR someone else wrote, say) it writes `found: false` and the story has no backstory.

`backstory.json` holds the evidence and a draft `timeline`. The story writer (the pr-story skill) puts the real text in `chapters.json`: a top-level `backstory` (`summary`, `sessions`, `timeline`), each chapter's `backstory` (`summary`, `steps`), a file entry's `backstory.text` and a line's `backstory`. When `chapters.json` has no timeline, the bridge uses the draft.

## Story folders

```
~/.diff-story/                      (DIFF_STORY_HOME moves it)
  config.json                       {port, token}, mode 600
  inbox.jsonl                       questions, answers, positions, notes
  cursors/<consumer>.json           how far each reader has read the inbox
  state/<story id>/                 ui.json, position.json, viewed.json, notes.json
  <owner>-<repo>-<N>/               chapters.json, file-map.json, meta.json   (from pr-story)
  local-<repo>-<branch>/            chapters.json, meta.json, local.diff      (from diff-story local)
                                    backstory.json in either, when there is one
```

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
| `GET /api/stories` | every story it can serve |
| `GET /api/stories/find?repo=O/R&number=N` | the story for a PR, if any |
| `GET /api/stories/:id` | the panel's data, plus the diff, viewed files and notes for a local story |
| `GET /api/stories/:id/version` | changes when the story or (for local) the commits change |
| `GET`/`POST /api/stories/:id/ui` | the panel's step, width, collapsed and hidden state (the local page uses this, and the extension keeps its own in `chrome.storage`) |
| `POST /api/stories/:id/position` | `{step, chapter, file}`, written to `position.json`, and to the inbox when it changes |
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

## Layout

- `src/`: the extension, which is the folder to load unpacked.
  - `js/content/index.js` finds the story and mounts the panel.
  - `js/background.js` is the only code that makes network calls, and only to `127.0.0.1`.
  - `js/shared/overlay.js` is the panel, shared with the local page.
- `bridge/`: the CLI (`bin/diff-story.mjs`), the server and story code (`lib/`), and the local page (`public/`).
- `test/`: unit tests and `extension/load-test.mjs`.

## Credits

- The panel started as the pr-story skill's GitHub overlay.
- The pr-story skill renders its chat-mode pages with [session-story](https://github.com/nalaj/session-story) (MIT, © 2026 Nenad Alajbegovic), pinned at `b432256`. Diff Story Mode's local page is its own simple diff view and copies no session-story code.

## License

MIT
