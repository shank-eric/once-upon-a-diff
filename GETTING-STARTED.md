# Getting started with Once Upon a Diff

Once Upon a Diff puts a code-review story (an overview, then chapters) in a side panel on a GitHub PR's Files changed page, with the diff filtered to each chapter's files. A Claude Code session writes the story and answers questions you type in the panel. A small local server, the bridge, carries things between the two.

This guide takes you from nothing to your first story. The [README](README.md) has the details behind each step.

## Setting up

### 1. Check you have what it needs

- **Node 24 or newer** (`node --version`), the current LTS. The repo's `.nvmrc` says 24, so with [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) it's `fnm use` or `nvm use` in the repo (`fnm install 24` or `nvm install 24` first if you don't have it). The skills look for fnm's or nvm's Node 24 themselves when the shell's `node` is older.
- **Claude Code**, signed in.
- **The GitHub CLI, logged in.** Run `gh auth status`. The bridge uses gh to check whether a story is up to date and which of your drafted comments you've posted. It runs gh with `GITHUB_TOKEN` unset, so it uses your keychain login, not a token in your environment.
- **Chrome** (or another Chromium browser that loads unpacked extensions).
- **A Mac, ideally.** `once-upon local` opens its page with macOS `open`. Elsewhere it still prints the URL for you to open.

### 2. Clone, install and build

```bash
git clone <repo url> once-upon-a-diff
cd once-upon-a-diff
yarn
yarn build
```

`yarn` installs the tools and links the repo's three packages (shared code, the bridge, the extension). `yarn build` builds the extension into `packages/extension/.output/chrome-mv3`, the folder you load in step 5. The bridge needs no build: Node 24 runs it as it is.

The repo uses Yarn 4 and carries its own copy (`.yarn/releases`), which any `yarn` on your PATH hands off to. If you don't have `yarn` at all, run `corepack enable` once. Corepack ships with Node 24, and it reads the `packageManager` field in `package.json` to fetch the same Yarn 4.

**Just want the extension?** A release zip (`once-upon-a-diff-<version>-chrome.zip`) is the same extension, built. Unzip it somewhere it can stay and load that folder in step 5 instead of building. You still need the clone for the bridge and the skills.

### 3. Make the bridge's config

```bash
node packages/bridge/bin/once-upon.mjs setup
```

The first run creates `~/.once-upon/config.json` (mode 600) with a port, 4823 by default, and a random token. It prints both. You'll paste them into the extension in step 5.

### 4. Start the bridge (optional)

You can let the agent start this for you if you want. You don't have to start this directly. When `/once-upon-listen` (step 9) finds no bridge running, it starts one in the background that keeps running after the session ends. Any Claude Code session you ask will do the same.

To start it yourself instead:

```bash
yarn bridge
```

That's the same as `node packages/bridge/bin/once-upon.mjs serve`. Keep it in a terminal tab you leave open. Either way it listens on `127.0.0.1` only, and the repo has no login item or launch agent, so after a reboot it needs starting again (by you or the skill).

### 5. Load the extension

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this repo's `packages/extension/.output/chrome-mv3` folder (or the unzipped release).
3. The options page opens on install. If it doesn't, go to Once Upon a Diff → Details → Extension options.
4. Paste the port and token from step 3, click **Save**, then **Test connection**.

### 6. Install the listener skill

`/once-upon-listen` turns a Claude Code session into one repo's listener: it answers Ask-box questions and takes Build story requests. It ships in this repo's `skills/` folder. Link it into your Claude Code skills folder from the repo root:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/once-upon-listen" ~/.claude/skills/once-upon-listen
```

It's a link, so a `git pull` updates the skill too. The skill finds the `once-upon` command through that link, so it doesn't need the alias in step 8. Start a new Claude Code session to pick it up.

A listener reads PR text that anyone who can comment on a PR can write, so don't run it in bypass-permissions mode (`--dangerously-skip-permissions`). Add the deny list in the README's [Keep listener sessions on a short leash](README.md#keep-listener-sessions-on-a-short-leash) to the checkout's `.claude/settings.local.json` or your `~/.claude/settings.json`, so `git push`, `gh` writes, `curl` and WebFetch are refused outright.

### 7. Install the once-upon skill

Building a story for a PR needs a second skill, **once-upon**, which also ships in `skills/`. The listener hands every Build story request to it, and its `build` step is what publishes the story where the bridge finds it. Link it the same way, from the repo root:

```bash
ln -s "$PWD/skills/once-upon" ~/.claude/skills/once-upon
```

It finds this repo through the link, so the checkout can live anywhere.

- **You can give it your own rules.** It's generic: it drafts comments and never posts them. Rules about your own setup (where checkouts live, how to name people, the voice for comments) go in `~/.once-upon/house-rules.md`, which the skills read when it's there. See [Personal settings](README.md#personal-settings).

What works without once-upon: local mode (step 10, which makes its own starting chapters), the panel and its Ask box on any story you have, and the listener answering questions. What doesn't: Build story on a PR, and a story's update after new commits.

### 8. Add the `once-upon` alias (optional)

```bash
alias once-upon="node /path/to/once-upon-a-diff/packages/bridge/bin/once-upon.mjs"
```

Put it in your shell profile. The rest of this guide uses `once-upon`. Run it with no arguments to see every command.

## Using it

### 9. Your first PR story

1. Open a PR's **Files changed** tab. With no story yet, a **Build story** tag sits next to the PR title.
2. Click **Build story**. It changes to **Queued**, and with no Claude session listening for that repo, a notice at the bottom right says "No session listening for owner/name", with a **Copy prompt for Claude** button. PR lists and a PR's Conversation tab show the same tag and notice.
3. Click **Copy prompt for Claude**. It copies one line, `/once-upon-listen owner/repo`.
4. Open Claude Code in your local checkout of that repo and paste the line. The session checks the bridge (starting it if it isn't running), says it's listening, and waits in the background. The tag turns to **Building…**.
5. When the story is written, the panel opens on the page by itself, at the Overview step.

Then, in the panel:

- **Prev and Next** (or the Steps list) filter the diff to one chapter. **Show all files** undoes the filter.
- **Mark viewed.** In each chapter, a file with a **Mark viewed** button is one this chapter finishes. Click the button (or GitHub's own Viewed checkbox, which is the same thing) and it becomes **Viewed ✓**; click that to untick it. A file a later chapter finishes has no button yet. The panel follows the checkboxes and counts your progress, and only ever ticks one when you click its button.
- **Ask.** Type a question and press **Cmd+Enter**. The listening session answers it from the story and the code, and the answer shows under the question with the session that gave it. The line under the Ask box says who's answering. **Copy prompt for this story** copies `/once-upon-listen --story <id>` for the session that built the story, which then answers this story's questions ahead of the repo's listener.
- **Tidy the questions.** ▾ collapses an exchange to its question, **Dismiss** hides one, and **Clear conversation** hides them all, with **Undo** for a few seconds and **Show dismissed** after that. They stay that way after a reload.
- **Draft comments.** Comments Claude drafts show in the chapter's Draft comments. On a line comment, **Add to my review** puts it in your pending GitHub review (starting one if needed) and never submits it. **Dismiss** hides one you don't want, and a draft you post shows as posted once gh finds it. On the Overview, **Copy as gh script** copies a script that puts all the line drafts still to post into one pending review with `gh api`. It only copies, and the review isn't submitted until you submit it.
- **Fix before push.** **Add to fix before push** on a line comment makes it a note for the session to fix instead. Notes collect as drafts you can edit or remove, until **Send N notes to <session>** hands them over as one request. The session makes one change, commits it as your house rules say (never pushing), and the notes then say "Fixed in <sha>". **Auto-send** sends each note as you add it. While a session works, the files it's changing are dimmed with "Being changed by <session>".
- **Hide whitespace** is GitHub's own setting, and the extension remembers it across PRs. On GitHub, use GitHub's own split view. The local page (step 10) has its own **Hide whitespace** and **Unified / Split** in its header.

Tell the session "stop" when you're done. Run one listener per repo, each in its own session.

### 10. Local mode: commits before you push

```bash
once-upon local --repo <checkout> --base <ref>
```

This tells the story of `git diff <base> HEAD` (`--head` picks another end) on a page the bridge serves, and starts a bridge if none is running. Without `--chapters <file>` you get one chapter per top-level folder as a starting point. The same panel runs on the page. Click a line number to add a "fix before push" note. The panel's **Fix before push** box sends them to the listening session, and `once-upon notes --story <id>` prints them as a checklist. The page redraws when you amend or add a commit.

## Where stories live

Each story lives in the checkout it's about, in a hidden `.once-upon/` folder. Git ignores that folder through the checkout's `.git/info/exclude`, which is local and never committed, so `git status` stays clean. Everything else, like your config, preferences, the question inbox and what you've read, is in `~/.once-upon` (`ONCE_UPON_HOME` moves it).

The bridge learns where your checkouts are from local stories and from where a listener runs. Otherwise it looks under `~/Development/<name>` (`checkout_dirs` in `~/.once-upon/config.json` or `ONCE_UPON_DEV_DIR` changes that).

## When something's off

- **`once-upon doctor`** prints PASS, WARN or FAIL for the config, the token, the bridge, the extension's last contact, the stories, the listeners and pending builds, with a fix for anything that isn't passing.
- **The light in the panel header**, left of "Hide story". Hover it for a summary or click it for details.
  - Green: the bridge works, the story's found, and a session is listening.
  - Amber: everything works, but no session is listening for this repo. Questions wait in a queue.
  - Red: the bridge is down, too old for the panel, or rejects the token.
- **After a `git pull`**, run `yarn` and `yarn build`, restart the bridge, reload the extension on `chrome://extensions`, then reload your PR tabs. The extension keeps its settings: its ID doesn't change.
- **A new token** (`once-upon token --rotate`) means pasting it into the extension's options and restarting the bridge.

## What it never does

- It never posts comments or reviews, never submits a review and never pushes. Add to my review is the only thing that writes to GitHub, and only when you click it, into your own pending review.
- The listener never checks out a branch or pushes, and never runs a PR's code, tests or scripts unless you say so in chat. It reads code with `git show`. It changes files and commits only for fix-before-push notes you send it, on the branch the checkout is already on.
- The bridge only listens on `127.0.0.1`, wants the token on every call, and refuses requests from other web pages. A local page gets a key for its own story only, in its link, never the token.

**Data and privacy.** The story is written by Claude Code on your machine. Like any Claude Code session, it reads the PR's diff and code from your local checkout and with gh, and sends what it reads to Claude to write the story and answer questions. Stories, questions and answers stay in `.once-upon/` and `~/.once-upon`. Use it on code you're allowed to share with Claude.
