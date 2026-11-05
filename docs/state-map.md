# Once Upon a Diff: state map

This covers every file and in-memory cache that the bridge, the CLI, the extension and the skills read or write, as the code stands on main at 7fa8447 (11/4). Turn capture (`parked/turn-capture`) isn't mapped. Paths are under `packages/bridge/src/` unless they start with another package. The bridge's code is in four layers (ADR-15): `server/` and `cli/` over `services/` over `adapters/`, and only an adapter writes a file, runs a program or reaches the network. [`flows.md`](flows.md) follows five requests (Build a story, Ask, Board refresh, Start listening, and an agent's claim through to its card landing) through those layers, hop by hop with `file:line`.

"Bridge" is the `once-upon serve` process. "CLI" is any other `once-upon` command, each a short-lived process (except `wait`). "Skills" are `once-upon` and `once-upon-listen` running inside a Claude Code session. `<home>` is `~/.once-upon` (`ONCE_UPON_HOME` moves it).

## The short version

1. **One process serves, many processes write.** The bridge is the only HTTP server. Every CLI command opens the same JSON files directly (`StoryStore`, `Builds`, `Inbox`, `readFixes`). Four stores take a lock for their read-modify-write: `builds.json`, `fixes.json` (with every `notes.json`) and `handed.json` through `adapters/stores/fs/lock.ts`, and `usage/coverage-cli.json` through its own lock folder. Everywhere else a write from the bridge and one from the CLI can cross. `backlog.jsonl` avoids that by being append-only, one event per line.
2. **JSON writes are read-modify-write of a whole file, and each one is atomic.** Every JSON file and every file rewritten in place goes through `writeJsonAtomic`, `writeFileAtomic` or `copyFileAtomic` (`adapters/stores/fs/json-file.ts`: a temp file and a rename), so a reader never sees half a file. Appends (`inbox.jsonl`, `backlog.jsonl`, the logs) go through `appendText` in `adapters/stores/fs/files.ts`. Two writes in place are left: making an empty `inbox.jsonl`, and Larmor's `paused` marker file. Atomic stops torn reads. It doesn't stop lost updates.
3. **Nothing is pruned except listener history (7 days), kept GitHub answers (7 days), the board's 30-day view of stories, and a gone session's status line file (a day old).** `inbox.jsonl`, `state/<id>/`, `cursors/`, `listeners/`, `builds.json`, `fixes.json`, `handed.json`, `asking.json`, `backlog.jsonl`, `agents.jsonl`, `worktree-cleanups.jsonl`, `stories.json`, `bridge.log` and `listeners.log` only grow.
4. **The same fact is often kept twice:** reads, notes and fix events in both `state/` and `inbox.jsonl`; panel UI in both `chrome.storage` and `ui.json`; Hide whitespace in both `prefs.json` and `chrome.storage`; a story's chapters in both its served folder and the skill's scratch folder (`meta.source`).
5. **State keys use two schemes.** Drafts and reads are keyed by PR (`pr-<owner>-<repo>-<N>`). Everything else is keyed by story id (`<Owner>-<repo>-<N>`, `local-<folder>-<branch>`). A story id that changes (a different worktree folder, a renamed branch) starts with empty viewed, notes, reviewed and position state.
6. **A local story told over `HEAD` follows `HEAD`, not its branch.** `once-upon local` defaults `--head HEAD` (`services/stories/local-story.ts`), and the skill's first build passes it. Every page poll runs `refreshLocal`, which re-diffs whatever the worktree has checked out. `meta.branch` is recorded but never checked. In a worktree that switches between stacked branches, an older branch's story silently shows the new branch's diff. A story told over a branch name or a sha is pinned to the commits it was told over (`services/stories/local-diff.ts`) and doesn't drift.

## 1. `<home>`: bridge-wide files

| File | Writer | Readers | Format | Lifetime, pruning | Missing or stale |
|---|---|---|---|---|---|
| `config.json` | `loadConfig` (any process, first run), `token --rotate`, a person | everything (`readSettings` on almost every request) | JSON `{port, token, …settings}`, 0600. The board's settings are here: `board_voice_dir`, `board_larmor_dir` (the Larmor checkout whose `voice_ctl` the phone buttons run), `board_ledger_file`, `board_worktrees`, `board_keep_branches`, and `ship` rules | forever | Missing: a new token is made, and the extension stops matching until it gets the new one. Rotated: page keys and cookies all change, and a running bridge keeps the old token until restart |
| `bridge.json` | bridge on listen (atomic), removed on close if its own pid | `once-upon local`, `doctor` (port check) | `{pid, port, token fingerprint}` | while the bridge runs. A `kill -9` leaves it, but a dead pid reads as "foreign" | Stale: `local` reports the port as foreign or an old token instead of starting a bridge |
| `bridge.log` | bridge (`services/bridge/bridge.ts`) | `doctor`, people | text lines | **never trimmed** | none |
| `extension-seen.json` | bridge, at most every 30 s (`server/index.ts`, written by `services/bridge/bridge.ts`, atomic) | `doctor` (also in memory as `app.extensionSeen`) | `{at, origin}` | overwritten | Missing: doctor says the extension has never called |
| `prefs.json` | bridge `POST /api/prefs` (`writePrefs`, `services/config/settings.ts`, atomic) | bridge on each local-story request, panel via `/api/prefs` | `{hideWhitespace, diffView, layout?: {width, chatHeight}}` (one panel width and dock height across stories) | forever | Missing: defaults. **Copy also in `chrome.storage`** (§5) |
| `stories.json` (index) | `storyDirFor` (`services/stories/placement.ts`) from `publish` and `local` (CLI), atomic | every `StoryStore.dirs()`: each request that finds a story, the board, `wait`'s auto-stop | `{id: folder}` | **never pruned**: entries for deleted worktrees stay | A dead entry is skipped (`isStoryDir`). Missing: only `<home>/<id>` stories are found until each is published again |
| `checkouts.json` | `seenCheckout`: `wait --repo` (CLI), `once-upon local`, **and the bridge on every `GET /api/stories/<local id>`** (`server/routes/story.ts`) | `checkoutFor` (story placement, listen prompts) | `{owner/name: path}` | last writer wins, never pruned | It can name a worktree (say `owner/repo` → `~/code/repo-worktrees/feature`), and then prompts say to work there. If that path goes, it falls back to `checkout_dirs/<name>` and then nothing |
| `inbox.jsonl` | bridge (questions, notes, reads, review comments, fix events, `approved`), CLI `ask`, `answer`, `fixed` | `wait` (from its cursor), bridge `questions()` (whole file), `once-upon inbox` | one JSON object per line, append only | **never trimmed or rotated**. Every panel pulse rereads all of it | Missing: `wait` creates it empty. Truncated: cursors past the end reset to 0, so every reader replays everything |
| `cursors/<consumer>.json` | `wait`, `inbox --unread` (atomic) | the same | `{offset, at}` byte offset | **never pruned**: one per consumer name ever used (e.g. one per `story-<id>`) | Missing: the next wait starts from the end, and earlier questions are skipped for that consumer |
| `cursors/<consumer>.deferred.json` | `wait` (atomic) | `wait` | `[question id]` held for a live story listener | never pruned | Missing: deferred questions are not looked at again by that repo wait |
| `listeners/<consumer>.json` | `wait` every 5 s and on handover. `working` refreshes a handling beat | bridge `listeners()` (status light, routing, board), CLI routing | `{consumer, pid, state, at, repo?, story?, builds?, fixes?}` | **never deleted**. Live means a waiting beat under 15 s with a live pid, or a handling beat under 10 min | Two sessions with the same consumer name share one file and one cursor (below) |
| `listener-history.json` | `wait --repo` at start, board on each build (atomic) | board's Listeners lane | `{repo: {consumer, started_at, last_seen}}` | entries over 7 days dropped on read | Missing: the lane shows only live listeners |
| `listener-stops.json` | board's Stop listening (`services/board/board.ts` → `services/inbox/auto-stop.ts`, atomic) | `wait --repo` every loop | `{repo: ms}` | one key per repo, never cleared | A stop older than a wait's start is ignored, so stale is harmless |
| `finished-agents.json` | board's Finish on an agent's card (`services/board/board.ts`, atomic) | the board's agents stage | `{"<sid>:<name>": ms}` | entries older than a week are dropped on the next write | A card stays hidden while nothing the agent did is later than its time, so a new ledger line or beat brings it back |
| `listeners.log` | `wait` when it stops itself | people | text | **never trimmed** | none |
| `handed.json` | `wait` when it hands questions over: the check that no other wait has a question and the mark that this one does are one write under `handed.json.lock` (`routeQuestions`), atomic | routing, panel ("answered by"), `answer` | `{question id: {consumer, at}}` | **never pruned** | Missing: a question could be handed again, and "Answered by" falls back to `--consumer` |
| `asking.json` | CLI `asking` (a session says what it is doing on a question), cleared by `answer` (atomic) | panel via pulse (question status: working, gone quiet) | `{question id: {note, at, by}}` | one entry per open question, removed when answered | Missing: the panel shows only the handover time |
| `backlog.jsonl` | bridge (board Add, Edit, Move, Drop, Assign) and CLI `backlog` (add, edit, start, claim, done, land, hold, move, drop, reopen), by **append** (`services/backlog/backlog.ts`, through `adapters/stores/backlog-file.ts`). `backlog land`, which `scripts/deploy-local.sh` runs after a deploy, writes a `done` event for each card whose agent's recorded commit went live (`services/backlog/landing.ts`) | board, CLI `backlog list`, `show`, `land` | one event per line: `add`, `edit`, `start`, `assign`, `claim`, `done` (with the landed sha), `hold`, `move`, `drop`, `reopen`, folded on read | **never trimmed**. A drop leaves its lines | Missing: an empty Backlog. A bad line is skipped |
| `agents.jsonl` | `once-upon agent start\|state\|beat\|finish` (`services/ledger/registry.ts`, through `adapters/stores/agents-file.ts`), and the board's Finish on a registered agent, by append | the board (`readAgents`, `services/ledger/read.ts`), `agent list`, `backlog land` (the commit each finish recorded) | one JSON event a line (§4 has the fields) | forever, read whole | Missing: no registered agents |
| `github-answers.json` | the bridge's GitHub watcher (`services/review/github-watcher.ts`, through `adapters/stores/github-answers.ts`, atomic), once per turn in which GitHub answered | the watcher, at bridge start | `{version, branches: {<repo>@<branch>: {at, pr}}, prs: {<repo>#<N>: {at, info}}, requested: {at, list}}` | entries over a week old are dropped on read and on write | Missing, damaged or another version: empty, and the board shows no PR details until GitHub answers. Read entries count as stale, so the watcher asks again at once |
| `parts/<owner>-<name>.json` | a person (the reviewer's own parts file for a repo, which wins over the repo's) | the bridge when it loads a story (`services/stories/parts.ts`, cached by path and mtime) | a version 1 parts file (`protocol/src/domain/parts.ts`): groups of named parts by folder | forever | Missing: the repo's `.once-upon-parts.json` is used (§3). Too big (over 256 KB) or bad: ignored with a warning |
| `worktrees.json` | the board's `WorktreeScanner` in the bridge, in the background (`services/worktrees/worktrees.ts`, atomic) | the scanner at start, so a restart shows the last scan | `{at, items: [worktree facts]}` | overwritten each scan | Missing or stale: the lane shows after the first scan, and stale facts are marked until one confirms them |
| `worktree-cleanups.jsonl` | bridge, board Clean up (`services/worktrees/worktree-clean.ts`), by append | people (it holds the line that restores a removed branch) | one line per attempt and outcome | **never trimmed** | none |
| `statusline/<session id>.json` | a status line script in the user's Claude Code setup, on every render. The **board deletes** one for a gone session once it is a day old (`adapters/claude-sessions/statusline.ts`) | board (context use per session, account usage) | `{session_id, at, context, rate_limits}` | per session, a day after it goes | Missing: no meters. A script that stops writing makes usage stale, and it's hidden after 6 h |
| `builds.json` | bridge (Build story, Update, Rebuild, status-many settling), CLI (`wait` claims, `publish`/`local` settle, `done`, `builds --start`). Every write is a read-modify-write under `builds.json.lock` (`services/inbox/queue.ts` over `adapters/stores/fs/lock.ts`), atomic | bridge pulse, PR tags, board, `wait`, auto-stop | `{owner/repo#N or story:<id>: Build}` | one per PR or local story, kept after done | Missing: queued requests are gone |
| `fixes.json` | bridge (send, take back, auto-send), CLI `wait` (claim), `fixed`. Under `fixes.json.lock`, atomic | bridge pulse and fixes view, board, `wait`, auto-stop | `{request id: FixRequest}` | **never pruned** (the view shows the last 10 per story) | Missing: notes sent to a request it no longer has go back to the drafts ("lost") at the next look |
| `builds.json.lock`, `fixes.json.lock`, `handed.json.lock` | any process writing builds, fixes or handed questions (`adapters/stores/fs/lock.ts`, O_EXCL) | the next writer | `{pid, at}` | removed after each write; one a crash leaves is taken over when its pid is gone or it's 10 s old | none |
| `usage/coverage-bridge.json` | the bridge (`services/usage/capture.ts`): every 5 minutes, on SIGUSR2 and on SIGTERM (atomic) | `once-upon usage report` | `{since, updated, lastFlush, starts, files: {<repo-relative path>: [{sha, mode, lines, uncovered (base64 bitset), firstSeen, lastSeen, takes, dayUncovered}]}}`, at most 3 versions per path | forever, bounded by the code's size; `usage clear` removes it | Missing or damaged: the report shows no coverage |
| `usage/coverage-cli.json` | each CLI run, only when it learned a line no run had covered (atomic, under a `coverage-cli.json.lock` folder so runs at once keep each other's lines) | the report | the same shape | the same | the same |
| `usage/actions.json` | the bridge only (`services/usage/counters.ts`), within seconds of a count, and on SIGUSR2 and SIGTERM | the report | `{since, updated, lastFlush, days: {<ET day>: {routes: {<surface>: {<route key>: n}}, ui: {<surface>: {<action name>: n}}, unknownDropped}}}`, names from closed lists only | days older than 60 are dropped | Missing: no counts |
| `usage/cli-runs.log` | each CLI run, one appended line `YYYY-MM-DD command[.verb]` (`services/usage/cli-log.ts`) | the report | text | stops growing at 1 MB | Missing: no command counts |
| `usage/settings.json` | `once-upon usage on [--lines]` / `off` | every process that starts the capture, the bridge at each flush | `{mode: 'off'|'function'|'lines', epoch}` (`epoch` counts `usage clear` runs: the bridge drops its in-memory counts when it moves) | forever; `usage clear` keeps it | Missing: function level, on |
| `usage/bridge-pid.json` | the bridge, once its SIGUSR2 handler is installed; removed on exit | `usage report`, which signals only a pid listed here whose command is still `once-upon ... serve` | `{pid, startedAt}` | while the bridge runs; `usage clear` keeps it | Missing or stale: the report reads the files as they are |
| `usage/last-report.json` | `once-upon usage report` (a full report only: not with `--no-save`, `--since` or `--last`) | the next report's "since the last report" block | counts-only snapshot | overwritten each report | Missing: no comparison |
| `house-rules.md` | a person | the skills (shell `jq`/`cat` in SKILL.md) | Markdown | forever | Missing: skills use their own rules only |
| `<id>/` | `publish` when the repo has no known checkout | `StoryStore.dirs()` scans every child folder of `<home>` | a story folder (§3) | forever | Any child folder with `chapters.json` and `meta.json` counts as a story, turn-capture leftovers included |

## 2. `<home>/state/<key>/`: per-story and per-PR state

`stateFile` makes the folder on first use. `<key>` is the story id, except for `drafts.json` and `read.json`, which use `stateKeyOf` (`services/stories/meta.ts`): `pr-<owner>-<repo>-<N>` for a PR story, so a re-told story keeps them, or the story id for a local one. Folders keyed by an older id scheme (`repo-123`) are left behind with no story. **Nothing deletes a state folder.**

| File | Writer | Readers | Format | Missing or stale |
|---|---|---|---|---|
| `ui.json` | bridge `POST …/ui` (local page only) | local page | panel step, width, collapsed, hidden | Missing: Overview. **The extension keeps its own copy per PR in `chrome.storage`** |
| `position.json` | bridge `POST …/position` (panel, debounced 1.2 s) | skills ("this one"), the board's `seen_at` for a story | `{step, chapter, file, at}` | Missing: the skill can't tell where the reader is |
| `seen.json` | bridge on pulse, version poll and hidden-tab ping, at most every 30 s (in-memory throttle) | `wait --story`/`--repo` auto-stop | `{at}` | Missing: the idle window counts from the wait's start |
| `viewed.json` | bridge `POST …/viewed` (local stories) | local page via story data | `{path: {hash}}` | A changed file hash shows "changed since viewed" |
| `notes.json` | bridge (add, edit, send, take back), CLI `fixed` | panel, local page, `notes`, `drafts`, pulse | `[LocalNote]` with `sent`/`fixed`/`returned` | Written under `fixes.json.lock`. The marks follow `fixes.json`, which is the record: each change writes the request first, then brings the notes in line (`alignNotes`), and the fixes view mends notes that lag |
| `fix-settings.json` | bridge (Auto-send) | bridge | `{auto_send, at}` | off |
| `working.json` | CLI `working`, `fixed` (atomic) | panel via pulse | `{marks: {consumer: …}, done: [last 5]}` | Marks expire after 30 min or when the listener stops beating |
| `questions.json` | bridge (dismiss, collapse, clear), `publish` on a rebuild (`moved`) | panel, routing | `{dismissed, collapsed, moved}` | Missing: dismissed questions come back and can be handed over |
| `reviewed.json` | bridge (board Mark reviewed, Approve), AutoReview in the background | board columns | `{at, by}`. Present means decided | Missing: auto-review may mark it again |
| `approved.json` | bridge, Approve on a local story (`services/review/approve.ts`), cleared by Clear approval | Push and Create pull request boxes, board (Ready to ship) | `{at, head_oid, base_oid, marked}`. It counts only while the story's head is that commit, for 7 days | Missing: not approved |
| `agent.json` | CLI `bind`, or `--agent` on `publish` or `local` (atomic; `services/listeners/binding.ts`) | `wait` (relays the story's questions to the named agent), panel via pulse | `{agent, session, at}` | ignored after a day or when its session has ended (the registry has no live pid) | Missing: the story's questions go to a listener as usual |
| `merged.json` | AutoReview | board (dropped, Done for 24 h) | `{at, why, merged_at}` | Missing: a merged PR's story shows until GitHub is asked again |
| `pr-draft.json` | CLI `pr-draft` | local page's Create pull request | `{title, body, base}` | Missing: GitHub fills the title and body from commits |
| `drafts.json` (PR key) | bridge (Dismiss, Restore, Add to my review). A rebuild's carried drafts go into `chapters.json`, not here | panel, `drafts` | `{dismissed, added}` | Missing: dismissed drafts come back |
| `read.json` (PR key) | bridge `POST …/read`, `publish` on rebuild (retire) | update `since_sha`, "changed since you read", board | `{chapter key: {head_sha, story_head, at, reason, …}}` | Missing: updates start from the story head. **Also logged as `read` lines in `inbox.jsonl`** |

## 3. Story folders

| Where | Writer | Readers | Holds | Lifetime |
|---|---|---|---|---|
| `<main checkout>/.once-upon/<Owner>-<repo>-<N>/` (PR story) | `publish` (CLI, from `story.mjs build`), through `publishPrStory` in `services/publishing/publish.ts`: `copyFileAtomic` of `chapters.json` and `file-map.json`, then an atomic `meta.json`. CLI `comment` (atomic) | bridge on every story request, skills (`chapters.json`, `meta.json`) | `chapters.json`, `file-map.json`, `meta.json` (`head_oid`, `pr_author`, `head_ref`, `source`, …) | forever. Folders made before the umask was set keep 0755 |
| `<worktree>/.once-upon/local-<folder>-<branch>/` (local story) | `once-upon local` (CLI), **and the bridge**: `refreshLocal` rewrites `local.diff` and `meta.json` whenever HEAD or the base moved, on every version poll, pulse and load (`services/stories/local-diff.ts`). `local-w.diff` on demand | bridge, skills | `meta.json` (`repo_path`, `base`, `head`, `branch`, oids, `commits`, `built_at`), `local.diff`, `local-w.diff`, `chapters.json` | goes when the worktree is deleted, but its index entry and state folder stay |
| `skeleton.json` in a story's folder (PR or local) | `noteSkeleton` (`services/stories/skeleton.ts`), from `publish` and `once-upon local`, by atomic write | `storyData` (marks each such chapter `skeleton`), the board and Approve (`unwrittenCount` reads `chapters.json`) | `[chapter key, …]`: chapters that were ever published with no narrative. A union, never shrunk | forever, with the story. Missing: the panel may credit a read from Viewed ticks made while a chapter was being written |
| `<home>/<id>/` | `publish` with no known checkout | bridge | as a PR story | forever |
| `<checkout>/.once-upon-parts.json` | the repo's own people, committed with the code | the bridge when it loads a story (`services/stories/parts.ts`): a local story's worktree, or a PR story's main checkout (its working tree, not the PR's head) | the repo's parts map (`protocol/src/domain/parts.ts`). Worked out on each load and never stored, so an older story gains its strip the day the repo gets a file | forever, with the repo. A reviewer's own `<home>/parts/` file wins (§1) |
| `<checkout>/.git/info/exclude` (common dir) | `excludeStories` appends `/.once-upon/` once | git | one line | forever |
| skill scratch `<scratchpad>/once-upon/<repo>-<N>/` (`meta.source`) | the once-upon skill (`gather.sh`, `story.mjs`), `publish` on a rebuild, CLI `comment` (keeps a second copy of `chapters.json` in step) | `publish`, `prAuthorOf` fallback | `pr.json`, `pr.diff`, `threads.json`, `checks.json`, `viewed.tsv`, `checkouts.txt`, `brief.json`, `chapters.json`, `file-map.json` | Claude Code's session scratchpad, which goes when the session ends, so `meta.source` points at a folder that's often gone. `comment` checks it exists |
| `refs/tmp/pr-<N>` in a checkout | skills (fetch a PR head) | skills | git ref | the skill says to delete it, and nothing checks that it did |

## 4. Outside state the bridge and skills read, and what the board writes

Each source is reached through one adapter: `adapters/claude-sessions/` (the registry, transcripts, status lines and titles), `larmor.ts`, `iterm.ts`, `git.ts`, `github.ts` and `os.ts` (`ps`, ports, the browser), with `adapters/stores/fs/lines.ts` tailing the ledger and progress files.

| Source | Read by | How | What if it's missing or stale |
|---|---|---|---|
| `~/.claude/sessions/<pid>.json` (Claude Code registry, `board_sessions_dir`) | board, and `Sessions` (`services/sessions/sessions.ts`) for typing and focus | every snapshot (cached 2 s). A file counts only while its pid lives and `ps` start time matches `procStart` | No sessions on the board. A format change in Claude Code breaks the board |
| `~/.claude/projects/<cwd dashed>/<session>.jsonl` (transcripts, `board_projects_dir`) | board `BlankSessions` | reads from the start until a deciding line, cached by session id and size, and rescans other folders every 10 s | A deleted transcript makes its session look blank (the README says so). The tree can be gigabytes, and only heads are read |
| `agents.jsonl` | `once-upon agent start\|state\|beat\|finish` (a launching session or the agent), the board's Finish on a registered agent | the board (`readAgents`), `agent list` | one JSON event a line, appended: `start` (kind, task, repo, branch, PR, cwd, card, and `slots` for kind `editor`), `state`, `beat`, `finish` (result, findings); never rewritten, 0600 | forever (read whole) | A registered agent is told by its events alone: ledger lines for the same `sid:name` are ignored. Where an agent goes on the board comes from its registered repo, branch, PR, card and lane, never its task text: an agent with none of them is a card of its own. With `board_ledger_file` / `board_progress_file` set, each event also appends its legacy line there (none for an editor, `kind: editor`: a session running a repo's queue, read apart from the agents and shown in the editors strip with the authors launched under its session id) |
| an agent ledger and progress file, e.g. `~/notes/agent-ledger.md`, `~/notes/agent-progress.md` (`board_ledger_file`, `board_progress_file`) | board, as a fallback for agents with no registry events: **being removed** (branch `ledger-trim`), after which the registry is the board's only source and these files are a log the CLI writes | tail only (1 MB) | Unset means no unregistered agents |
| `~/.larmor/session`, `voice-session-name`, `away`, `paused`, `last-voice.json`, `spoken.jsonl`, `turns.jsonl`, `phone.json` (`board_voice_dir`) | board | each snapshot. A TCP connect to the phone bridge's sink port (from `phone.json`, default 8171) is probed at most every 2 s | Off means no voice strip |
| `it2` (iTerm2 CLI) | board status (`session list`, `get-status` per tab), Open in iTerm, Build story, Start listening (`session run`) | spawned on each snapshot. Status is fetched for every live session | No `it2`: the registry's busy and idle only, and no typing or focusing |
| `ps -A -o pid=,ppid=` | board (who runs which wait), registry check | each snapshot with listeners | Not found: no "listening" marks |
| `gh` (keychain login, `GITHUB_TOKEN` dropped when `gh_unset_github_token` is set) | freshness, drafts, Add to my review, AutoReview (PR facts, branch PR, requested reviews), pull-request view, skills' `gather.sh` and `viewed.sh` | `execFile`, 20 s timeout. **No `gh --cache`**: caching is the bridge's own in memory (§6) | Logged out: freshness, drafts and the board's PR details stay empty. The panel still works |
| `git` in the checkouts | local diffs, branch per session (cached 10 s), origin per checkout (cached 5 min), merge-base checks, `ls-remote`, push, and the board's worktree scanner (`worktree list`, status, log per worktree) | `execFile`/`execFileSync`. The scanner's calls have timeouts, `core.fsmonitor=false` and `--no-optional-locks` | A hung mount is guarded on the async origin lookup (3 s timeout) and the scanner's calls, which keep their last answer when one times out |

The board also **writes** outside `<home>`, each on a click (ADR-11):

| Target | Action | How |
|---|---|---|
| `~/.larmor/paused` (`board_voice_dir`) | Pause and Resume voice | creates or removes the file (`setPaused` in `adapters/larmor.ts`), and Larmor's ear acts on it |
| Larmor's phone mode and bridge (`board_larmor_dir`) | Phone mode on and off, Stop phone bridge | runs `python app/voice_ctl.py phone-on \| phone-off \| bridge-stop` there. Larmor writes or removes its `away` file and starts or stops its phone bridge |
| iTerm tabs | Open in iTerm, Build story, Start listening, Assign | `it2 window focus`, `it2 session focus`, `it2 session run "<line>"` |
| a checkout | worktree Clean up | `git worktree remove` (no `--force`), then `git branch -d` when the branch is merged. The attempt is logged first in `worktree-cleanups.jsonl` |
| the agent ledger (`board_ledger_file`) | Finish on a card of an agent still `[waiting]` | appends one `[done]` line (`appendLine`). A finished agent's card is cleared through `<home>/finished-agents.json` instead, with no ledger line |
| `<home>/statusline/` | housekeeping | deletes a gone session's file after a day |

## 5. Browser-side state

| Where | Writer | Holds | Notes |
|---|---|---|---|
| `chrome.storage.local.settings` | options page | `{port, token}` | the only copy of the token outside `config.json` |
| `chrome.storage.local["ui:<owner/repo#N>"]` | content script | the panel's state per PR | **duplicates `state/<id>/ui.json`**, which only the local page uses. Never pruned |
| `chrome.storage.local.prefs` | content script | `{hideWhitespace, dirty}` | **copy of `prefs.json`**. `dirty` means it changed while the bridge was down and is pushed on reconnect |
| `sessionStorage` (GitHub tab) | content scripts | Hide whitespace guard (15 s), small per-tab values | gone with the tab |
| `localStorage` (board page) | `packages/web/public/board/shared.ts` (`useSetting`) | seven keys, each read by its own function: Idle lane, worktrees lane, collapsed repo headings, hide-on-author, voice panel open, voice panel width, and the filter text | per browser |
| `#key=` fragment, then the `__Host-ou-board` cookie (30 days) | bridge `/auth/session` on an allowed host name | the board's page key | Rotating the token makes old cookies fail with 401, and the page says it isn't connected |
| In-page memory | panel, local page (`highlightCache`), PR tags (`results`) | per tab | gone on reload |

## 6. In-memory caches in the bridge

All of them reset on restart, and none is shared with CLI processes.

| Cache | Where | TTL | Bound |
|---|---|---|---|
| `statusCache` (story list and builds, for PR tags) | `server/routes/catalog.ts` | 5 s, cleared on a build or rebuild request | one |
| Board snapshot | `services/board/board.ts` `CACHE_MS` | 2 s | one |
| Session branch per cwd | `services/board/board.ts` `branches` | 10 s | grows with cwds |
| Merged-locally answers and worktree lists per checkout | `services/board/board.ts` `landed`, `trees` | a few seconds | grow per branch and checkout |
| Commits ahead of origin per checkout and branch (`ls-remote`, in the background) | `services/board/board.ts` `aheads` | 60 s | grows per branch |
| Per-snapshot lookups: how stories ship, unread answers, local checkouts, the last listening input | `services/board/stages/` (`shipById`, `unreadById`, `localCheckouts`) and `services/board/board.ts` (`listeningNow`) | rebuilt each snapshot | one per story or repo |
| Status-since per session | `services/board/board.ts` `seen` | none | **grows with every session id seen** |
| Blank-session answers, session titles | `adapters/claude-sessions/blank-sessions.ts`, `titles.ts` `known` | by file size | **grow with every session id** |
| Worktree scan: facts, merged and superseded answers, histories | `services/worktrees/worktrees.ts` (`WorktreeScanner`) | rescans every 10 min (discovery), 5 min (dirty), hourly (size) | per worktree and branch tip |
| Is a session live (for a story's agent binding) | `services/listeners/binding.ts` | 2 s | per session |
| Is Larmor's phone bridge listening | `adapters/larmor.ts` | 2 s | per port |
| In-flight sets: a push per story, a Clean up per path, one phone call at a time | `server/routes/pull-request.ts`, `server/routes/push.ts`, `services/worktrees/worktree-clean.ts`, `services/board/board.ts` `phoneBusy` | while running | per story or path |
| AutoReview: PR facts, `PrInfo`, branch PRs, requested list | `services/review/github-watcher.ts` (rules: `merge-rules.ts`) | 3 min (rules 30 min) | **grows with every PR and branch seen** |
| gh comments per PR, gh login | `services/review/drafts.ts` | 60 s, login kept until restart | grows per PR |
| Freshness (head and compare) | `services/review/freshness.ts` | 60 s | grows per PR and head pair |
| Repo per checkout (sync, never expires) and async (5 min) | `services/config/repos.ts` | none / 5 min | per dir. **The sync one never expires**, so a changed origin needs a restart |
| `seen.json` write throttle | `services/inbox/auto-stop.ts` | 30 s | per story |
| Public host resolves here | `services/pages/address.ts` | 60 s | per host |
| Type-stripped assets | `server/assets.ts` | by mtime | per asset |
| `cliCache` (is `once-upon` on PATH) | `services/listeners/listeners.ts` | forever | one |

## 7. Flags

### Races (no lock between the bridge and CLI processes)

Items 1 and 2 were closed by the request queue's lock (183210b, 11/4). Items 3 to 7 were checked again on 7fa8447 and are still open.

1. **`builds.json` lost updates.** The bridge writes it on a click (request, rebuild, settle in status-many), and the CLI writes it from `wait` (claim, `services/inbox/builds.ts`), `publish`, `local`, `done` and `builds --start`. Each reads the whole file, changes it and writes it back. The write is atomic, so a half-written file is no longer a risk, but a claim landing between the bridge's read and write was lost, so the request showed Queued and could be handed to a second session. Two waits could also hand out the same request, and status-many could finish a request from a cached copy. **Closed:** every write is one locked read-modify-write (`services/inbox/queue.ts`, `adapters/stores/fs/lock.ts`): a wait claims what it hands out in that one step, and a finish checks the request as it is under the lock (`test/queue-races.test.ts`).
2. **`fixes.json` and `notes.json` are two writes, not one.** `sendNotes` saves notes and then fixes (`services/inbox/fixes.ts`). `reportFix` (CLI) saves notes and then fixes too. A crash between them leaves notes "sent" to a request that doesn't exist, or a request whose notes aren't marked. The bridge's Send and the CLI's `wait` claim (`services/inbox/fixes.ts`) both rewrite `fixes.json`. **Closed:** both files are written under `fixes.json.lock`. `fixes.json` is the record and is written first, and the notes' marks follow from it (`alignNotes`), so a crash leaves notes a step behind, and the next fixes view mends them. A note sent to a request that was never saved goes back to the drafts as "lost".
3. **`wait` advances its cursor before handing over** (`cli/commands/inbox.ts`). If the process is killed after the read and before it prints, those questions are skipped for that consumer for good (only build and fix requests come back, from their own files).
4. **Two sessions with one consumer name.** Two sessions running `/once-upon-listen owner/repo` both default to `repo-owner-name` (`consumerOf`, `cli/commands/inbox.ts`). They share one cursor and one heartbeat file, race on the cursor, and the bridge sees one listener. Nothing warns about it.
5. **The bridge writes into checkouts on reads.** `GET …/version`, `pulse` and `load` on a local story over `HEAD` run `refreshLocal`, which rewrites `local.diff` and `meta.json` in the worktree, while `once-upon local` may be writing the same files from the CLI. (A pinned story writes `local.diff` only when it's missing.) `GET /api/stories/<local id>` also rewrites `checkouts.json`.
6. **`publish` isn't atomic across files.** `publishPrStory` (`services/publishing/publish.ts`) copies two files and then writes `meta.json`, each atomic on its own, but not together. A pulse in between serves new chapters with the old `head_oid` for up to one poll.
7. **Board typing is check-then-act.** Build story, Start listening and Assign check that the session is at its prompt (`Sessions.typeable` in `services/sessions/sessions.ts`; Assign lets the voice session be mid-turn), then call `it2 session run` (`adapters/iterm.ts`). A prompt typed in between gets the line appended.

### Duplicates

8. Reads: `read.json` and `read` lines in `inbox.jsonl`. Notes: `notes.json` and `note` lines. Fix outcomes: `fixes.json` and `fix` lines. The inbox copies are a log nothing reads back for state.
9. Panel UI: `chrome.storage` `ui:<pr>` for GitHub and `state/<id>/ui.json` for the local page. Same shape, different keys (PR vs story id).
10. Hide whitespace: `prefs.json` and `chrome.storage.prefs` with a `dirty` merge.
11. Chapters: the served `chapters.json` and the skill's scratch `chapters.json` (`meta.source`), kept in step by `comment` and `publish`. The scratch copy usually vanishes with its session.
12. Story location: `stories.json` index plus the `<home>` child-folder scan. When two folders hold one id, the index wins. When two hold one PR, the newer mtime wins (`StoryStore.find`).
13. Who's listening: `listeners/*.json` beats, `listener-history.json` and `handed.json`, all three read by the board.

### Unpruned growth

14. `inbox.jsonl` is reread whole on every 5-second pulse of every open panel (`server/routes/story.ts`), on every `answer` and on every deferred-question check. It grows forever.
15. `state/` (including orphaned folders), `cursors/` and `listeners/` (one per consumer ever used), `stories.json` (dead entries), `handed.json`, `fixes.json`, `backlog.jsonl`, `worktree-cleanups.jsonl`, `bridge.log`, `listeners.log`, `chrome.storage` `ui:*`, and the bridge's per-PR and per-session maps (§6).
16. Old story folders in checkouts. Nothing removes `.once-upon/<id>` for a merged PR. `merged.json` only hides it.

### Other things that look off

17. **A local story told over `HEAD` follows HEAD.** See short-version item 6. Restacking in one worktree moves such a story to whatever is now checked out.
18. **Story ids depend on the worktree folder.** `local-<folder>-<branch>` (`services/stories/local-story.ts`): the same branch `feature` reviewed from `~/code/repo-worktrees/a/` and from `~/code/repo-worktrees/b/` is two stories (`local-a-feature`, `local-b-feature`) with separate reviewed, read and viewed state.
19. **File modes on disk don't match the README.** The CLI sets `umask 077` (`bin/once-upon.ts`), so new files are private, but files and folders made before that keep their modes. `ownerOnly` only fixes `<home>` and each `.once-upon/`. So a home created by an older version can still have 0644 files (`builds.json`, `stories.json`, `checkouts.json`, `prefs.json`, state files) and 0755 folders (`state/`, `cursors/`, `listeners/`, older `.once-upon/<id>/`).
20. **The sync repo-of-checkout cache never expires** (`services/config/repos.ts`), unlike the async one.

## ADRs (`docs/adr/`)

1. `adr/adr-01-extension-and-local-bridge.md`: an extension plus a local bridge, everything on this machine
2. `adr/adr-02-page-keys-step-down.md`: page keys and the step-down rule
3. `adr/adr-03-story-folders-in-checkouts.md`: story folders in each checkout's `.once-upon/`
4. `adr/adr-04-json-files-as-store.md`: JSON files as the store
5. `adr/adr-05-http-only-browser-bridge.md`: HTTP only between browser and bridge, with the CLI in-process
6. `adr/adr-06-sessions-and-listeners.md`: Claude sessions and listeners as the working side
7. `adr/adr-07-agent-board-page.md`: the agent board as a bridge page
8. `adr/adr-08-stacked-branches-as-local-stories.md`: stacked local branches reviewed as stories before PRs
9. `adr/adr-09-github-through-gh.md`: GitHub through `gh`, read-mostly, never waited on
10. `adr/adr-10-polling.md`: polling everywhere, no push channel
11. `adr/adr-11-board-and-other-tools.md`: the board's reads and writes beyond the bridge: other tools' files, iTerm, Larmor and checkouts
12. `adr/adr-12-one-panel-two-hosts.md`: one panel on GitHub's page and on a page that copies its DOM
13. `adr/adr-13-untrusted-pr-content.md`: PR content is data, and the guard is skill rules, not a sandbox
14. `adr/adr-14-front-end-approach.md`: Preact and htm, vendored as one file, adopted one region at a time
15. `adr/adr-15-layered-packages-and-protocol.md`: layered packages, with the protocol (types, route table, schemas) as the only place client and server meet
16. `adr/adr-16-what-the-rebuild-built.md`: what the 10/29 rebuild built under ADR-14 and ADR-15, and what it left
17. `adr/adr-17-host-github-and-the-end-of-shared.md`: a `host-github` package, and the end of `shared`
18. `adr/adr-18-usage-capture.md`: usage capture, counting what the tool actually uses, with names from closed lists only
19. `adr/adr-19-parts-map.md`: a repo's parts map, read from its checkout and never stored
