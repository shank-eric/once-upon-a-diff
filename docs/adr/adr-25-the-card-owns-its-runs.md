# ADR-25: The card owns its runs: a run names its card at start, and the board reads a card's column from its runs

Decided 11/5 by Eric (option A of the draft `2026-11-05-adr-card-as-key`, with the D3 store plan). Built in the commit that adds this file (11/6), and descriptive of the code on main at that commit. It supersedes, in part, [ADR-04](adr-04-json-files-as-store.md) on what `agents.jsonl` and `backlog.jsonl` are joined by, and the claim-to-run rules in the header of `state/src/queues/backlog/claims.ts`. What it leaves for later cards is under Not built here.

## Context

Eric, 11/5: "I feel like we have some sort of gap in how we are connecting editors, worktrees, authors and board tickets. Shouldn't there just be a single understanding of all of those things?" Every agent reported its own repo, branch, card, lane and kind when it registered (`once-upon agent start`), and the board joined those copies back together: a card found its run through its claim (the agent's name, and a 2-hour window around the claim's time), and an agent found its card through `homeOf` (repo, branch, PR and card, which must all agree). Three misses on 11/5 came from that:

- **Two cards for one piece of work.** panel-css had two runs (`r_a9a0ce6271`, then the fix round `r_de1d4bc4c9`), both with `--card bl_mw47rlfr3ef880`. The claim held run 1, so run 2 was not held: the board showed the backlog card in Ready to ship and `agent:eeea873a:panel-css` in Ready for review at once.
- **A critic with the wrong `--repo`** (`review-cli-no-server`, `esshank/...`, no `--card`) matched no card, so it became a card of its own in another lane and column, and the work it reviewed was in Agent checks as "no critic".
- **A fix round shown as Ready to ship.** A critic finished with no `--findings` (a null reads as a pass), and the editor sent the fix round by message, so no run was open. Even with a run, one started after a pass was not the claimed run and was ignored.

Each is a join by name, time or a typed copy. The fix is that a run says which card it is for, and the card's column comes from its own runs.

## Decision

- **The card owns its runs (option A).** `agent start NAME --card ID` names the card for good: the run is that card's, whatever its repo, branch or lane flags said. The card's repo and branch are the run's; the registry fills them from the card when it writes the start row, and the board reads the card's, never the run's copy. `--role author|fixer|critic|storyteller|helper|research` names what the run does (it maps to the kind; there is no new stored field).
- **A fix round is a run of the card.** A restart of the same sid and name is the card's next run (the registry keeps the run before it as `earlier`, and carries its `card` over to the restart, as it does the kind, while that card is open), and a card shows every agent that has a run on it, critics included.
- **One table reads the card.** `cardPhase` (`state/src/queues/backlog/phase.ts`) maps the card's runs to its column. It replaces `agentColumn`, `criticHold` and the claim-to-run time window for every card that a run names.
- **Where runs are stored: `agents.jsonl`, with `card` a required, checked key.** The draft's option A stored run events in `backlog.jsonl`. That was dropped here (Eric, 11/6): it would put one `agent start` in two files with no atomicity, `backlog.jsonl` has no incremental reader and would triple in size (start, state and finish rows are about 540 of the 895 KB of `agents.jsonl`), and `records/` cannot import `queues/`, so the registry would have needed a collaborator to write another tier's file. The board behaves the same either way, because it reads runs by card id. D3 holds: JSON and JSONL for now, with checks at write; the linking core (cards, claims, runs) moves to SQLite later behind `BacklogStore` and `AgentRegistry`.
- **The claim keeps its shape and loses its job.** A claim still says who took the card and shows "claimed, pending" for 2 hours before the agent's first row lands. It no longer finds the card's runs: a card that runs name is never read by its claim. A card no run names (old rows, a cardless agent) is read by the old rules until the flip deletes them.

## The phase table

`runsOf(card)` is every run whose `card` is the card's id, oldest first (an agent's earlier runs and its latest). Work runs are kind author, or none (old rows); critics are kind critic; researchers, helpers and storytellers show on the card and never move it. A card is read by its runs only when a work run names it: a card named only by critics, helpers or researchers (its author an old cardless run) is still read by its claim, and the author is shown on it. First row that fits:

| # | Condition | Column |
|---|---|---|
| 1 | a work run is open | waiting (a question): Waiting; plan (the plan to check): Agent checks; running or fixing: Working |
| 2 | skip-review repos only: a critic is open and alive (a sign of life in the last 24 h) | Agent checks |
| 3 | the latest work run failed or stopped | back in Backlog, tried |
| 4 | skip-review repos only: the latest critic finished with findings above 0 after the latest work run ended (and under 24 h ago) | Agent checks until a fix run opens (then row 1) |
| 5 | a skip-review repo with no critic, or the latest critic failed, stopped or died | Agent checks |
| 6 | built (started, with a branch) | Ready to ship in a skip-review repo (once-upon-a-diff, Larmor), else Ready for your review |
| 7 | no branch | Done for one hour after the work ended, then off the board |

A landed or merged card is Done for one hour, as before. Rows 2, 4 and 5 are for skip-review repos only, as before: elsewhere a critic's findings are the story's fix-before-push comments and hold nothing. Row 1 comes before every critic row, so any open author run on the card (a fix round included, with or without a `fixing` state) is Working, or Agent checks at its plan check, never Ready to ship. In a skip-review repo a critic's findings put the card in Agent checks at once (row 4), until a fix run opens and it is Working, as the draft decided.

## Reading old rows

Nothing in `agents.jsonl` or `backlog.jsonl` is rewritten. An old start row with `card` naming a card that exists is a run of that card, whatever repo, branch, lane or kind it typed; a fix round with the same card is its second run. A run whose card is unknown or dropped, and every run with no card, keeps today's placement (`homeOf`, `criticHold`'s repo-and-branch fallback, the claim's time window), read-only, until the flip deletes it. A card with a carded work run and a claimed cardless run is read by the carded run: the cardless run keeps a card of its own. A card named only by carded critics or helpers is read by its claim, so its cardless author is on it. An old critic row that finished without `--findings` still reads as a pass, so an old fix round sent by message with no run still shows Ready to ship until its rows age out.

## Write checks (D3), and what is refused, warned or left

At `agent start` with a card (the CLI turns these on by giving the registry a view of the backlog, `cardLookup`; a registry made without one only records, as before):

- **Refused:** a card that does not exist, was dropped or has landed; a second author on a card (a different sid and name, running, at its plan check or fixing, and not stale; one parked at a question or a story review does not block; a restart of the same sid and name is a fix round and ends its earlier run); a critic with no card, and `--role critic|fixer|storyteller` with no card.
- **Refused at `agent finish`:** a carded critic's `--state done` without `--findings N` (0 is fine).
- **Refused at `backlog claim`:** a `--repo` that differs from the card's, which used to rewrite it.
- **Warned and ignored:** `--repo` or `--branch` that differs from the card's, and `--pr` and `--lane` on a run with a card. The card's values are written. When the card has no repo or branch yet, the typed one is kept for the registry's commit-made check (`made.ts`).
- **Warned:** an author started on a card with no claim. The editor claims right after it launches an author, so the first `agent start` can come first.
- **`once-upon doctor`** lists the joins that do not hold, read only: a run naming a missing or dropped card, a typed repo or branch that differs from the card's, a finish naming another card than its start, open runs silent for over 24 hours, and a card with two open authors. Built since (11/6): it also joins state folders and inbox story ids to stories, and the repos on cards and cardless runs to the repos a checkout, a build or a PR story vouches for (`orchestration/bridge/doctor-joins.ts`).

## Options considered

- **A, run events in `backlog.jsonl` (the draft).** The card's whole story in one file. Not chosen for the storage reasons above; the read model it needed (a card's runs) is the same here.
- **B, keep the registry's joins and fill the typed fields from the card.** Phase would still be inferred by `criticHold` and `agentColumn` from whichever runs the board could tie back. Smaller, and it leaves the guessing in.
- **C and D1 to D3, the store.** D1 (JSON with checks) and D3 (D1 now, SQLite for the linking core later) are the plan; a relational store now is a store migration on top of the model change, and the model change is what fixes the misses. SQLite stays blocked on `node:sqlite` still printing its ExperimentalWarning on load.

## Consequences

- An author, critic or storyteller gives a card id and a role, and the repo, branch and lane flags are dead letters (warned now, refused at the flip).
- A landed card's runs no longer get a "Done, landed" agent card of their own for 30 minutes: the landed card sits in Done for an hour and shows them. A card whose runs a finished author's own card used to show in Ready for your review (the commit on a branch with no PR) is now the backlog card's column (row 6).
- A critic must say how many findings it has.
- The editor skill and the `agent start` line in Eric's global CLAUDE.md should say `--card ID --role R` and drop `--repo`, `--branch` and `--lane` for card work, and critics pass `--findings N`. Neither file is in this repo.
- The ledger, the progress file and the status line are unchanged: the events are the same rows.

## Not built here

Follow-up cards: (a) implicit cards for work that did not start in the backlog, `editor start --slots`, the 24-hour sweep and `backlog adopt`; (b) the flip: refuse the typed flags and an author with no card, delete the claim-to-run window, `criticHold` and `homeOf`'s card guessing, and rewrite the board goldens; (c) one id module for repo, PR and story keys (the draft's D1 list). The draft's claim that records the editor's session and the worktree path, and a critic or storyteller refused on a card with no branch, wait for (a) and (b). Built since (11/6, the editors half of (a)): `editor start --slots`, `editor slots --json` over one `slotsInUse` (`state/src/queues/backlog/slots.ts`), the sweep of silent `running` and `fixing` author and critic runs, and the claim's `session` and optional, checked `worktree`. Implicit cards, `backlog adopt` and the no-branch refusal are still to come. The sweep's limits: it closes only authors and critics, never a helper of any kind (a storyteller registers as one, and the live editor skill still registers the editor as one, so spared by kind rather than by name), a researcher or an editor, and never a run parked in `waiting`, `review` or `plan`. A plan stop marked only by a beat, with no `agent state --state plan`, is a `running` run and is swept after 24 hours of silence, so authors set `--state plan` themselves before they stop. An editor's slots carry over a restart of its name; one author fills one editor's pool (the claim's session when the claim names an editor, else its launching session).

## Open questions

- Whether a worktree shown as "in use" needs the run's `cwd` once most runs carry none (`workingIn` matches by repo and branch now).
