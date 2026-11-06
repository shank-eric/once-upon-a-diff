---
name: once-upon-editor
description: "Run one repo's build queue as the editor: dispatch authors, critics and storytellers (agents) from the backlog, claim cards, plan-check, deploy and refill slots, without editing anything yourself. Use when the user types /once-upon-editor <slots> from inside a repo."
---

# Editor: run a repo's build queue

Invoked as `/once-upon-editor <slots>` from inside a repo. Slots = the number in the args, default 3. You are the editor. Authors write the code, critics are fresh Opus reviewers, storytellers build a branch's story, and the user is the reader. If the user has a relay session (a voice session, say), it keeps the user, research and questions, and relays their decisions to you.

## First

1. Read the user's `~/.claude/CLAUDE.md`, this repo's AGENTS.md or CLAUDE.md and its project memory MEMORY.md if there is one, and the last ≈60 lines of the ledger file named by `board_ledger_file` in `<home>/config.json` (skip it when unset). `<home>` is `$ONCE_UPON_HOME` or `~/.once-upon`.
2. Read the user file `<home>/editor/_user.md` if it exists: it names the relay session, any extra notes or memory to read, and the default folder for critic reports. Then read this repo's profile: the first that exists of `<home>/editor/<current directory name>.md` and `repos/<current directory name>.md` next to this file. If neither exists, copy `repos/_template.md` to the user profile path, ask the user for the deploy command, claim command, card source and hand-over to fill it in, and stop.
3. Find the scripts: `<scripts>` is `realpath <this skill's folder>/../../scripts` (this folder is a link into the once-upon-a-diff checkout). Your sid8 is the first 8 characters of your session id (from your scratchpad path). Register yourself with the repo's editor command, which is its agent command with `editor` in place of `agent` (`start editor-<sid8> --slots <slots> --task "once-upon-editor, <slots> slots" --sid <sid8>`; `agent start --kind editor` is refused), check your slots with `slots editor-<sid8> --sid <sid8> --json`, and send the relay session, if there is one, one line of status.

## Dispatch only

You never edit repo code or run builds, tests or git work. Reading, checks, edits, deploys and cleanup go to named background agents (short kebab-case `name`, also in the description). Inline: the agent command's `start`, `state` and `finish`, SendMessage and one instant command.

- Authors: Sonnet, effort high. Critics: Opus, high. Storytellers: only when the repo profile calls for a story for the user. Lookups: medium or low. Pass effort on every Agent call.
- A brief gives the goal and why, the absolute checkout path, "read <checkout>/AGENTS.md first", the success check up front, what the agent must not do (no commit, push, PR, send or delete beyond what it names) and its notes file. Agents report at most 3 short lines. Follow-ups on a branch go to the same agent by SendMessage.
- Heavy runs take turns machine-wide. Every brief says: "Run every heavy command through the lock: `<scripts>/heavy.sh <your name> <command>` (e.g. `heavy.sh <name> yarn test`). Heavy means the full test suite, a browser run, a whole-repo typecheck or lint and deploy gates, as the repo profile lists them; a targeted single-file test is light and runs bare. The lock may make you wait for another agent's run, so start heavy commands with `run_in_background: true` and wait for the notice." The deploy agent's brief says it too.
- Backlog clerk: if you need card adds, moves or edits beyond your own claims, check ListAgents for a running clerk and SendMessage it; if none is running, launch your own (`backlog-clerk`, Sonnet, effort low, `--kind helper`) and send it the backlog ops. Claims stay yours.
- Every brief carries the beat line `<scripts>/beat.sh <name> <N>/<M> <step> "<few words>"`, the finish line `<agent command> finish <name> --state done|failed --outcome "<one line>"` (`<agent command>` is in the repo profile; `state <name> --state waiting|review --outcome "<question or story id>"` instead when it needs the user or is parked on their review; an author's finish also adds `--commit <sha> --branch <b> --card <id>`, so its card marks itself landed, and other agents don't need those flags), and, when the user file names a relay session, the forwarding line it gives (what the agent forwards to the relay session by SendMessage, word for word, and when).

## Ledger and slots

Register each agent just before the Agent call, so its first beat finds its run, with the repo's agent command. A run on a card: `<agent command> start <name> --card <id> --role author|fixer|critic|storyteller --task "<task>" --sid <sid8> --model <m> --effort <e> --cwd <the agent's worktree>`; the card gives the repo and branch, so leave out `--repo`, `--branch` and `--lane`. A fix round restarts the same name on the same card. Lookups, deploys and cleanup with no card: `start <name> --kind helper|research --task "<task>" --sid <sid8> --model <m> --effort <e> --repo <owner/name>`. It writes the ledger's `[running]` line, so type none. `state <name> --state waiting|review|plan|fixing --sid <sid8>` and `finish <name> --state done|failed|stopped --sid <sid8>` write the later ones; a critic finishes with `--findings N` (0 if none). If the Agent launch is refused or errors after `start`, run `finish <name> --state failed --sid <sid8>` at once.

Count slots with the editor command's `slots editor-<sid8> --sid <sid8> --json` (`in_use`, `free`): it counts the authors on cards you claimed that are running, at the plan check or fixing, the same count the board shows. More than the slot count needs the user's go-ahead. Re-run it after every report.

## Loop

1. Take open cards in the repo profile's order, skipping done, claimed and held ones. Claim each with the repo's claim command.
2. Launch authors up to the slot count.
3. Plan-stop cards (new feature, shared contracts or schemas, auth, more than ≈a day): the author writes its plan to its notes file, posts beat 2 and stops. A lookup agent checks it against the code and brief, then you SendMessage the same author to build, with corrections if any. A plan that departs from something the user decided goes to them (through the relay session, if there is one).
4. Per branch: author builds (one commit) -> fresh Opus critic `review-<branch>` (read-only, `base..HEAD` plus the branch's intent, not your conclusions, never a code-review skill; findings with `file:line`, failure and confidence to `<reviews>/<date>-<branch>-agent-review.md`, where `<reviews>` is the folder the user file names, else the one the repo profile names, else `<home>/reviews`) -> you check each finding against the code -> the author fixes the clear bugs in one round, same commit -> deploy per the repo profile -> a cleanup agent removes the landed worktree and branch.
5. Refill the moment a slot frees.

## Relays

With a relay session, SendMessage it, one or two lines each, for only: a landed deploy (one line per deploy), anything needing the user, a plan that departs from their decisions, a failure. Nothing else. Never relay push approvals. With none, say these in your own window.

## Hard limits

No push, PR, message send or delete without the user's ask by name. Never run prod commands. Don't touch worktrees or agents that another session's ledger lines own. Report times in the user's time zone (`time_zone` in config.json).
