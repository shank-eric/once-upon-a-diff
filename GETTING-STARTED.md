# Getting started with Diff Story Mode

Diff Story Mode puts a code-review story (an overview, then chapters) in a side panel on a GitHub PR's Files changed page, with the diff filtered to each chapter's files. A Claude Code session writes the story and answers questions you type in the panel. A small local server, the bridge, carries things between the two.

This guide takes you from nothing to your first story. The [README](README.md) has the details behind each step.

## Setting up

### 1. Check you have what it needs

- **Node 20 or newer** (`node --version`). The repo's `.nvmrc` says 20.
- **Claude Code**, signed in.
- **The GitHub CLI, logged in.** Run `gh auth status`. The bridge uses gh to check whether a story is up to date and which of your drafted comments you've posted. It runs gh with `GITHUB_TOKEN` unset, so it uses your keychain login, not a token in your environment.
- **Chrome** (or another Chromium browser that loads unpacked extensions).
- **A Mac, ideally.** `diff-story local` opens its page with macOS `open`. Elsewhere it still prints the URL for you to open.

### 2. Clone and install

```bash
git clone <repo url> diff-story-mode
cd diff-story-mode
yarn
```

The bridge has no runtime dependencies, so `yarn` is only for tests and lint. The repo uses Yarn 4 and carries its own copy (`.yarn/releases`), which any `yarn` on your PATH hands off to. If you don't have `yarn` at all, run `corepack enable` once. Corepack ships with Node 20, and it reads the `packageManager` field in `package.json` to fetch the same Yarn 4.

### 3. Make the bridge's config

```bash
node bridge/bin/diff-story.mjs setup
```

The first run creates `~/.diff-story/config.json` (mode 600) with a port, 4823 by default, and a random token. It prints both. You'll paste them into the extension in step 5.

### 4. Start the bridge (optional)

You can let the agent start this for you if you want. You don't have to start this directly. When `/diff-story-listen` (step 9) finds no bridge running, it starts one in the background that keeps running after the session ends. Any Claude Code session you ask will do the same.

To start it yourself instead:

```bash
yarn bridge
```

That's the same as `node bridge/bin/diff-story.mjs serve`. Keep it in a terminal tab you leave open. Either way it listens on `127.0.0.1` only, and the repo has no login item or launch agent, so after a reboot it needs starting again (by you or the skill).

### 5. Load the extension

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this repo's `src/` folder.
3. The options page opens on install. If it doesn't, go to Diff Story Mode → Details → Extension options.
4. Paste the port and token from step 3, click **Save**, then **Test connection**.

### 6. Install the listener skill

`/diff-story-listen` turns a Claude Code session into one repo's listener: it answers Ask-box questions and takes Build story requests. It ships in this repo's `skills/` folder. Link it into your Claude Code skills folder from the repo root:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/diff-story-listen" ~/.claude/skills/diff-story-listen
```

It's a link, so a `git pull` updates the skill too. The skill finds the `diff-story` command through that link, so it doesn't need the alias in step 8. Start a new Claude Code session to pick it up.

### 7. Install the pr-story skill

Building a story for a PR needs a second skill, **pr-story**, which also ships in `skills/`. The listener hands every Build story request to it, and its `render` step is what publishes the story where the bridge finds it. Link it the same way, from the repo root:

```bash
ln -s "$PWD/skills/pr-story" ~/.claude/skills/pr-story
```

It finds this repo through the link, so the checkout can live anywhere. Two things to know:

- **It needs session-story.** pr-story's `render` draws its page with [session-story](https://github.com/nalaj/session-story) (public, MIT), pinned at `b432256`, at `~/.claude/skills/session-story` (or `SESSION_STORY_DIR`). Without it `render` fails before it publishes, so Build story doesn't finish.
- **You can give it your own rules.** It's generic: it drafts comments and never posts them. Rules about your own setup (where checkouts live, how to name people, the voice for comments) go in `~/.diff-story/house-rules.md`, which the skills read when it's there. See [Personal settings](README.md#personal-settings).

What works without pr-story: local mode (step 10, which makes its own starting chapters), the panel and its Ask box on any story you have, and the listener answering questions. What doesn't: Build story on a PR, and a story's update after new commits.

### 8. Add the `diff-story` alias (optional)

```bash
alias diff-story="node /path/to/diff-story-mode/bridge/bin/diff-story.mjs"
```

Put it in your shell profile. The rest of this guide uses `diff-story`. Run it with no arguments to see every command.

## Using it

### 9. Your first PR story

1. Open a PR's **Files changed** tab. With no story yet, a small control at the bottom right says **No story yet · Build story**.
2. Click **Build story**. With no Claude session listening for that repo, it changes to **Story queued · no session listening**, with a **Copy prompt for Claude** button. (On PR lists and a PR's Conversation tab, the same thing shows as a "No session listening for owner/name" notice.)
3. Click **Copy prompt for Claude**. It copies one line, `/diff-story-listen owner/repo`.
4. Open Claude Code in your local checkout of that repo and paste the line. The session checks the bridge (starting it if it isn't running), says it's listening, and waits in the background. The control turns to **Building story**.
5. When the story is written, the panel opens on the page by itself, at the Overview step.

Then, in the panel:

- **Prev and Next** (or the Steps list) filter the diff to one chapter. **Show all files** undoes the filter.
- **Mark viewed.** In each chapter, a file with a **Mark viewed** button is one this chapter finishes. Click the button (or GitHub's own Viewed checkbox, which is the same thing) and it becomes **Viewed ✓**; click that to untick it. A file a later chapter finishes has no button yet. The panel follows the checkboxes and counts your progress, and only ever ticks one when you click its button.
- **Ask.** Type a question and press **Cmd+Enter**. The listening session answers it from the story and the code, and the answer shows under the question.
- **Draft comments.** Comments Claude drafts show in the chapter's Draft comments. On a line comment, **Add to my review** puts it in your pending GitHub review (starting one if needed) and never submits it. **Mark posted** and **Dismiss** keep track of the rest.
- **Hide whitespace** is GitHub's own setting, and the extension remembers it across PRs. On GitHub, use GitHub's own split view. The local page (step 10) has its own **Hide whitespace** and **Unified / Split** in its header.

Tell the session "stop" when you're done. Run one listener per repo, each in its own session.

### 10. Local mode: commits before you push

```bash
diff-story local --repo <checkout> --base <ref>
```

This tells the story of `git diff <base> HEAD` (`--head` picks another end) on a page the bridge serves, and starts a bridge if none is running. Without `--chapters <file>` you get one chapter per top-level folder as a starting point. The same panel runs on the page. Click a line number to add a "fix before push" note, and `diff-story notes --story <id>` prints them as a checklist. The page redraws when you amend or add a commit.

## Where stories live

Each story lives in the checkout it's about, in a hidden `.diff-story/` folder. Git ignores that folder through the checkout's `.git/info/exclude`, which is local and never committed, so `git status` stays clean. Everything else, like your config, preferences, the question inbox and what you've read, is in `~/.diff-story` (`DIFF_STORY_HOME` moves it).

The bridge learns where your checkouts are from local stories and from where a listener runs. Otherwise it looks under `~/Development/<name>` (`checkout_dirs` in `~/.diff-story/config.json` or `DIFF_STORY_DEV_DIR` changes that).

## When something's off

- **`diff-story doctor`** prints PASS, WARN or FAIL for the config, the token, the bridge, the extension's last contact, the stories, the listeners and pending builds, with a fix for anything that isn't passing.
- **The light in the panel header**, left of "Hide story". Hover it for a summary or click it for details.
  - Green: the bridge works, the story's found, and a session is listening.
  - Amber: everything works, but no session is listening for this repo. Questions wait in a queue.
  - Red: the bridge is down, too old for the panel, or rejects the token.
- **After a `git pull`**, restart the bridge, reload the extension on `chrome://extensions`, then reload your PR tabs.
- **A new token** (`diff-story token --rotate`) means pasting it into the extension's options and restarting the bridge.

## What it never does

- It never posts comments or reviews, never submits a review and never pushes. Add to my review is the only thing that writes to GitHub, and only when you click it, into your own pending review.
- The listener never commits, checks out a branch or changes files in your checkout. It reads code with `git show`.
- The bridge only listens on `127.0.0.1`, wants the token on every call, and refuses requests from other web pages.

**Data and privacy.** The story is written by Claude Code on your machine. Like any Claude Code session, it reads the PR's diff and code from your local checkout and with gh, and sends what it reads to Claude to write the story and answer questions. Stories, questions and answers stay in `.diff-story/` and `~/.diff-story`. Use it on code you're allowed to share with Claude.
