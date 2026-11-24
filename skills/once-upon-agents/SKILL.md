---
name: once-upon-agents
description: "Rules for launching a background agent or subagent for repo work, and for running a heavy command (a full test suite, whole-repo typecheck or lint, a browser run), in a repo that uses once-upon. Use before an Agent call or a heavy command, from any session that is not the editor."
---

# Launching agents and running heavy commands

For a session that is not running `/once-upon-editor` (that skill runs a whole build queue and covers all of this). `once-upon` is the linked command from `scripts/install-cli.sh`; where the shell is not on Node 24, put `fnm exec --using=24` in front of it. README "Running a build queue" has the detail behind each line.

## Launching an agent

1. Prefer `once-upon dispatch <card> --role author|fixer|critic|storyteller|helper`. It registers the run on its card and prints the Agent call's arguments and a brief that already has the beat, heavy and handback lines. Make that one Agent call just after it, so the agent's first beat finds its run.
2. A run for a branch that has a card names it: `--card <id>` (`once-upon backlog list` finds it). A fixer or critic with only `--branch` joins the branch's open card and the start prints `joined <card>`; with several open cards it is refused until `--card` names one. A fix round or a rebase is a fresh `--role fixer --card <card>` once the author has handed back, never a second commit and never a resumed author.
3. No card, a lookup only: `once-upon agent start <name> --role helper|research --task "<task>" --sid <sid8>`. Never type ledger lines; the CLI writes them. Never `git stash` in a repo with parallel worktrees.
4. A brief you write by hand names the agent (a short kebab-case `name`, also in the Agent call's description), registers it just before launching, runs in the background, and tells the agent to:
   - post progress beats with `fnm exec --using=24 once-upon beat <name> <N>/<M> <step> "<few words>"` (plain `once-upon beat` where the shell is on Node 24), where M is the agent's own step count and the last beat is M/M. A failing beat means Node 24 was not found: the agent tells the launching session.
   - run heavy commands through the lock (below).
   - end with `once-upon handback <name> --sid <sid8> --outcome "<one line>"`, or the same with `--state waiting --outcome "<question>"` when it needs a decision. A critic finishes with `--findings N` (0 if none). An author hands back as soon as its commit is in, even while its story waits for review. `handback` records the branch tip, branch and card.
5. The optional `require-beats.sh` PreToolUse hook (`once-upon install-hooks` prints the settings block) refuses an Agent launch whose brief has no `once-upon beat`, or `no-beats` to skip.

## Big builds plan first

A new feature, work across more than one package, auth or token handling, shared contracts or schemas, or more than about a day of work: `dispatch <card> --role author --plan` writes its plan to its notes file, posts beat 2 and hands back with `--plan`. Check the plan against the code, then finish the planner and start a fresh author with `--role author --from-notes <notes file>`; never resume the planner. A plan that departs from something the user decided goes to the user first. A follow-up on a checked plan, a small fix or a bump skips this.

## Heavy commands

Parallel full runs from several repos have exhausted the machine's memory, so heavy commands take turns through one lock, in every repo, whether an agent or you runs them: `ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy <name> <command>` (plain `once-upon heavy <name> <command>` on Node 24), with `run_in_background: true`, then wait for the completion notice. Heavy means a full test suite, a browser or Cypress run, a whole-repo typecheck or lint and a deploy gate. A targeted test file, `format:check` and a lint of the changed files run bare. The repo's AGENTS.md or editor profile may list more.

## Review before a story

Each branch gets a fresh reviewer (`dispatch <card> --role critic`) and, when the repo builds stories, its storyteller launched in the same step. Step 5 of `/once-upon-editor` has the rest: checking each finding, the fixer round, the "Agent review:" comments on the story.
