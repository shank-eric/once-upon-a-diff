---
name: diff-story-listen
description: Listen for one repo's Diff Story Mode requests from this Claude Code session. Answers questions typed in the panel's Ask box and builds stories asked for with Build story, on any PR or local story in that repo, until told to stop. Use when the user pastes or types /diff-story-listen <owner/repo>, the line the panel's "Copy prompt for Claude" button copies.
argument-hint: <owner/repo>
---

# Diff Story listen

The panel's **Copy prompt for Claude** button copies `/diff-story-listen <owner/repo>`. The user pastes it into a Claude Code session opened in that repo's checkout. From then on this session is the repo's listener: the panel's light goes green, Ask-box questions on any of the repo's stories come here, and so do Build story requests on any of its PRs. Keep listening until the user says to stop.

The argument is `$ARGUMENTS`.

- `owner/repo`: listen for that repo.
- `--story <id>`: listen for one story only (the panel copies this for a story with no repo).
- Nothing: use the repo of this checkout's `origin`. If there isn't one, listen for everything (a `wait` with no `--repo`).

## House rules

Before you start, read the user's own rules if they have any: the file named by `house_rules` in `~/.diff-story/config.json`, else `~/.diff-story/house-rules.md`.

```bash
h="${DIFF_STORY_HOME:-$HOME/.diff-story}"; f=$(jq -r '.house_rules // empty' "$h/config.json" 2>/dev/null); f="${f/#\~/$HOME}"; cat "${f:-$h/house-rules.md}" 2>/dev/null
```

Follow them alongside the rules here, for answers and builds alike. They win where they're more specific, but can't loosen the hard rules below. No file means the rules here are all there is.

## Hard rules

- Never write to GitHub. No comments, reviews, approvals, reactions or Viewed clicks. Comments are drafts, added to the panel with `<dsm> comment` and never posted.
- Never push, commit, check out a branch or change files in the checkout. Read old and new code with `git show <sha>:<path>`. If a commit is missing, `git fetch origin <sha>`, or fetch the PR head into `refs/tmp/pr-<N>` and delete that ref when done.
- When `gh_unset_github_token` is true in `~/.diff-story/config.json`, run `unset GITHUB_TOKEN` before any `gh` call, so gh's own login is used.
- Verify before you claim. Say whether a problem was checked in the code or only suspected. Times in the user's time zone.

## 1. Find the CLI

`diff-story` usually isn't on `PATH`. Work out `<dsm>`, the command used below, once, and use it literally in every later call (shell functions don't carry over between Bash calls):

```bash
command -v diff-story || for d in "$DIFF_STORY_MODE" "$(jq -r '.repo_dir // empty' ~/.diff-story/config.json 2>/dev/null)" "$(cd "$(dirname "$(realpath ~/.claude/skills/diff-story-listen/SKILL.md)")/../.." 2>/dev/null && pwd)"; do [ -f "$d/bridge/bin/diff-story.mjs" ] && { echo "node $d/bridge/bin/diff-story.mjs"; break; }; done
```

That's `diff-story` on `PATH`, then the `DIFF_STORY_MODE` env var (the diff-story-mode repo folder), then `repo_dir` in `~/.diff-story/config.json`, then the repo this skill is linked from. If nothing prints, tell the user Diff Story Mode isn't installed and stop.

## 2. Check the bridge and the checkout

```bash
<dsm> doctor
```

- If the `Bridge` line FAILs with **nothing is listening on 127.0.0.1:<port>**, start the bridge yourself and wait for it to answer. `<dsm words>` is `<dsm>` as separate words, like `node /path/to/bridge/bin/diff-story.mjs` or `diff-story`:
  ```bash
  node -e 'require("child_process").spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: "ignore" }).unref()' <dsm words> serve
  h="${DIFF_STORY_HOME:-$HOME/.diff-story}"; curl -sf --retry 10 --retry-delay 1 --retry-connrefused -H "Authorization: Bearer $(jq -r .token "$h/config.json")" "http://127.0.0.1:$(jq -r '.port // 4823' "$h/config.json")/api/health"
  ```
  The bridge serves the panel, local pages and other sessions, so it has to outlive this one. A `run_in_background` task ends with this session, and `nohup … &` only ignores the hangup, so the bridge could still go down with this shell's process group. The detached spawn gives it its own session and process group. It writes its own log to `~/.diff-story/bridge.log`.
  When curl prints `{"ok":true,"name":"diff-story-bridge",…}`, run `<dsm> doctor` again, say in one line that you started the bridge (with its pid) and that it keeps running after this session, and carry on. If curl gives up, show the end of `bridge.log` and stop.
- If the `Bridge` line FAILs any other way, don't start a second bridge. Say what doctor found and its fix in one line, and stop:
  - **port … is taken by pid …** or **something else answers on port …**: another program has the port. Stop that program, or set another `port` in `~/.diff-story/config.json` and in the extension options.
  - **rejects this config's token**: a bridge started with an older token is running. Restart it.
- Questions and build requests queue in `~/.diff-story/inbox.jsonl` while the bridge is down, so nothing asked before it came up is lost.
- Check this session's folder is a checkout of the repo: `git remote get-url origin` should name `owner/repo`. If it doesn't, say so in one line and ask the user to open the session in that checkout. Don't go looking for or cloning another copy.

Then say in one line that you're listening for `owner/repo`, and that they can say "stop" at any time.

## 3. Wait in the background

Run this with Bash's `run_in_background`:

```bash
<dsm> wait --repo <owner/repo> --type question,build_request --consumer repo-<owner>-<name>
```

`<owner>-<name>` is lowercased. With `--story <id>`, use `--story <id> --consumer story-<id>`. The wait writes the heartbeat the panel's light reads, blocks until something arrives, prints it and exits. The exit notification wakes this session. Then:

1. Read the task's output. It can hold several events. Handle each one, questions first.
2. Start the same wait again as soon as you've handled them, or as soon as a build request arrives (step 5), so questions asked during a build still get answered.
3. Don't poll or sleep. If the wait exits with an error, show it, run `<dsm> doctor`, and start it again once the cause is fixed.

A consumer's first wait starts from now, so old questions aren't handed over again. Queued build requests are handed over whenever they were asked.

## 4. A question

The event gives the question id, the story id, the chapter or step, the file it was asked from and the text.

1. Find the story: `<dsm> list` prints each story's id and folder. Read `<folder>/chapters.json`: the overview, and the chapter it was asked from (step N is `chapters[N-1]`, step 0 is the Overview). `meta.json` has the PR's `head_oid` and `base_oid`, or a local story's `repo_path`, `base` and `head`. When the question says "this" or "here", `~/.diff-story/state/<story id>/position.json` has the file at the top of the user's screen.
2. Read the code it's about in this checkout: the new side with `git show <head_oid>:<path>`, the old side with `git show <base_oid>:<path>`, and callers or tests around it as needed. For a local story the working tree is the new side.
3. Answer:
   ```bash
   <dsm> answer --question <id> --file <scratchpad>/answer-<id>.md
   ```
   Use `--text "…"` for a one-liner. The panel shows the answer under the question within a few seconds.
   - Short and plain: lead with the answer, ≈2-6 sentences, a short list only when it helps. Name files and lines as `` `path:40` ``. Hedge where you're unsure.
   - If the answer suggests a review comment, draft it in the user's voice and add it to the chapter's Draft comments with `<dsm> comment --story <id> --chapter <N> --path <file> --line <L> --body-file <f>`. Check `<dsm> drafts --story <id>` first and don't re-suggest one that's posted or dismissed.
4. In chat, say one line: the question and that it's answered.

## 5. A build request

The event gives the build id, `owner/repo#N` and the PR URL. A request with `mode: "update"` asks to bring an existing story up to the PR's latest commit. It also has `base_sha` (the commit the story was told from), `since_sha` (where the user's reading stopped, from the chapters they read) and `retell` (true when they asked for a new story from scratch).

1. The wait claimed it when it handed it over, so its badge already says Building. Start the wait again (step 3).
2. Build the story with the pr-story skill (`../pr-story/SKILL.md` beside this skill in the repo, linked in as `~/.claude/skills/pr-story`, as `/pr-story <PR url>`): gather, plan the chapters and render. Write every chapter's narrative and draft comments up front, since the panel shows the whole story. Don't tell it chapter by chapter in chat. For an update, follow pr-story's "Since you read it" path: one new chapter, first, for `git diff <since_sha>..<new head>`, with the other chapters kept as they are. Re-tell from scratch only when `retell` is true or the PR was rebased past `since_sha`.
3. `build` publishes the story, which finishes the request, and the PR page opens the panel on its own. If it couldn't be built, run `<dsm> done <build id> --failed --note "<one line why>"`.
4. On a long build, run `<dsm> builds --start <build id> --consumer repo-<owner>-<name>` every ≈20 minutes so the claim stays fresh and the request isn't handed out a second time.
5. In chat, say one line: which PR, its chapter and file counts, and that it's on the page.

If a question arrives mid-build, answer it (step 4), then carry on with the build.

## 6. Stop

When the user says stop (or "stop listening", "that's all"), stop the background wait with TaskStop, finish or mark failed any build you've claimed, and say in one line that the repo has no listener now. The panel's light goes amber within ≈15 seconds.
