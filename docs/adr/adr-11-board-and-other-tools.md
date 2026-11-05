# ADR-11: The board's reads and writes beyond the bridge

Descriptive, of the code on main at 0741c6c (10/29). Since 11/5: the board's code is `packages/core/src/orchestration/board/`, and `voice.ts` (once `services/voice/`) is a file in it. The agent source changed on 11/3 and 11/4 as the bullet below says, and the ledger trim (7a9512f) removed the last fallback. It's split from ADR-07 because it's where Once Upon a Diff depends on things it doesn't own, and, since the board gained buttons, where it changes them.

## Context

The board shows every Claude Code session and background agent, and their status, without those tools reporting to it. It also offers one-click actions that need a session, Larmor or a checkout to do something. Every source is optional and degrades to less information. Each action is gated by the board key (ADR-02).

## Decision

**What the board reads** from outside its own files:

- **Claude Code's live-session registry**, `~/.claude/sessions/<pid>.json` (`board_sessions_dir`). A file counts while its pid lives and its start time matches `procStart`.
- **Claude Code transcripts**, `~/.claude/projects/<cwd dashed>/<session>.jsonl` (`board_projects_dir`), to tell a blank session and to title a session, reading from the top until a deciding line.
- **iTerm2's `it2` CLI**: `session list`, `session get-status` per tab, matched by tty. A Stop hook that sets the tab's status is what fills the Waiting column.
- **`ps`** for each listener's parent chain, to find the session that runs a wait.
- **Registered agents** (`once-upon agent start|state|beat|finish`, events in `<home>/agents.jsonl`): structured, never parsed from text. The registry mirrors each event into the agent ledger and progress files (`board_ledger_file`, `board_progress_file`, e.g. `~/notes/agent-ledger.md`) as log lines for people and scripts. (Superseded, 11/4: the board used to parse those files by regex from the tail, for agents nobody registered; it reads only the registry now, and the files are write-only for the bridge.)
- **Status line files**, `<home>/statusline/<session id>.json`, which a status line script copies from Claude Code's status line input on every render: each session's context use and the account's usage limits (`packages/core/src/adapters/claude-sessions/statusline.ts`). The script is the user's, so the file's shape is a contract with it.
- **Larmor's voice folder** (`board_voice_dir`, `~/.larmor`): `session`, `voice-session-name`, `away`, `paused`, `last-voice.json`, `spoken.jsonl`, `turns.jsonl` and `phone.json` (for the phone bridge's port). A TCP connect to that port checks whether the bridge is listening.
- **git**, for every worktree on the machine: `git worktree list`, and per worktree the last commit, unpushed commits, whether the work is in the main line, and clean or dirty. These run in a background scanner with timeouts, `core.fsmonitor=false` and `--no-optional-locks`, and the last answer is kept in `<home>/worktrees.json`.

**What the board writes**, each on a click, and each outside the bridge's own stores:

| Action | What it does | Where |
|---|---|---|
| Open in iTerm | `it2 window focus`, `it2 session focus`, `open -a iTerm` | iTerm |
| Build story, Start listening, Assign | `it2 session run "<line>"` into the session's tab, after checking it's at its prompt (Assign's voice session may be mid-turn, since Claude Code queues the line). The bridge builds the line itself (`/once-upon <PR url>`, `/once-upon-listen <repo>`, `Start backlog card <id>: <title>`) and finds the tab from the session's tty, never from what the page sent | a Claude Code session |
| Pause, Resume voice | makes or removes Larmor's `paused` file in `board_voice_dir`, which Larmor's ear watches (`setPaused` in `packages/core/src/adapters/larmor.ts`) | Larmor |
| Start voice, Stop voice | runs `python app/voice_ctl.py start [session id]` or `stop` from the Larmor checkout, the same way. `start` types `/larmor` into the session's iTerm tab (the last voice session when none is given) and waits for voice to come on, which takes up to about 30 s. Larmor refuses when voice is already on, its engine isn't ready, or the session is busy or gone, and the reason comes back. The page sends a session id from the board's own list and nothing else | Larmor |
| Phone mode on and off, Stop phone bridge | runs `python app/voice_ctl.py phone-on`, `phone-off` or `bridge-stop` from the Larmor checkout (`board_larmor_dir`), with its own venv python, a fixed list of subcommands and a 20 s timeout. Larmor makes the checks, writes or removes its `away` file and starts or stops its phone bridge. It may refuse, and the reason comes back | Larmor |
| Clean up (a worktree) | `git worktree remove <path>`, never `--force`, and `git branch -d` only when the branch is merged into the default branch. Before it runs, the bridge looks again at that worktree and re-runs the same `judge` the board used, refuses on any reason to keep it, and asks the page's confirm for the "superseded" and "ignored-files" cases. A repo on the keep list (`everfi-frontend`, and `board_keep_branches`) never loses its branch. The attempt, with the line that restores the branch, is appended to `<home>/worktree-cleanups.jsonl` first | the checkouts |
| Finish (an agent's card) | finishes an agent still waiting through the registry (a `finish` event, which the registry mirrors as `- [done] sid:<sid> <name> — <time> — finished from the board` in the ledger), and records the click in `<home>/finished-agents.json` so the card stays gone until the agent does something more. The bridge looks the agent up in the registry itself, from the sid and name | the registry and its ledger log, our own store |
| Backlog add, move, drop; Assign | appends events to `<home>/backlog.jsonl` (ADR-04) | our own store |
| Stop listening | writes `listener-stops.json` | our own store |
| Remove a gone session's status line file | the board deletes `statusline/<id>.json` once the session is gone and the file is a day old | the status line's folder |

## Consequences

- No changes to Claude Code, iTerm or Larmor were needed. Every source is optional and degrades to less information, and the matching buttons go missing when a setting isn't there (no `board_larmor_dir`, no phone buttons).
- **It's coupled to formats it doesn't own:** Claude Code's registry fields and transcript lines and its folder-naming rule for projects, Larmor's files and `voice_ctl`'s one-line JSON answer, and the status line script's file. An update to any of them can quietly break blank detection, session discovery, voice state or the usage meters.
- **The ledger's line format is a contract with scripts outside the repo** (the subagent status line, the iTerm status hook), which parse what the registry mirrors. The board no longer parses it (11/4); `agent-registry.test.ts` pins the format.
- It only works on macOS with iTerm2. Without `it2` the board falls back to busy or idle and can't type or focus.
- **The board is no longer read-only.** The board's actions (`packages/core/src/orchestration/board/board.ts`) are its only writes. Three actions now change things that outlive the bridge: voice (Larmor's state and its phone bridge process), worktree Clean up (deletes folders and branches), and typing into a terminal.
- **Clean up is the most destructive thing the bridge does,** and the bridge key reaches it (ADR-02). The guards are in the bridge's code: git's own refusal of a dirty or locked worktree, no `--force`, a fresh judgement just before, the confirm acks, a restore line logged first, and a single attempt with no retry. A branch is deleted only when git agrees it's merged. A detached HEAD that no branch reaches is kept.
- **Typing into a terminal is still the strongest thing a page can make happen.** It's gated by the board key, a confirm, and the at-prompt check. The check and the typing are two separate `it2` calls, so a prompt typed in between gets the line appended.
- The board reads the `~/.claude/projects` tree (often gigabytes) by heads only, cached per session id and size. The worktree scanner has its own cadence (discovery every 10 minutes, dirty checks every 5, sizes hourly) so a poll never waits on git.

## Open questions

1. Could Claude Code hooks (SessionStart, Stop, UserPromptSubmit) write a small status file per session that the board reads, instead of reading Claude Code's internals? The status line files are already this pattern for context and usage.
2. ~~Should the ledger get a tiny writer CLI that validates lines, rather than hand-written Markdown?~~ Answered by `once-upon agent`, the registry: the ledger is now written only by it.
3. Should the board's writes (typing, voice, phone, Clean up) stay board features, or move behind a separate opt-in setting, or a separate key?
4. Should Larmor own a small documented interface for pause and phone mode (its `voice_ctl`, or a socket) that the board calls, rather than the board writing Larmor's `paused` file itself?
