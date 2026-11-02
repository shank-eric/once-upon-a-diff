# ADR-07: The agent board as a bridge page

Descriptive, of the code on main at 0741c6c (10/29). The review inbox page this ADR first covered was removed in 1eb023f, and its jobs moved to the board.

## Context

Stories pile up across repos and PRs, and Claude sessions and background agents run in many iTerm tabs. The reviewer needs one place for "what waits for me" and "where is each piece of work", and for the backlog of work not yet started. The bridge already serves pages and holds the stories.

## Decision

- **One more page served by the bridge**, `/board/`: a page shell plus a type-stripped script (`packages/web/public/board.ts`, over the regions in `public/board/`), with its own page key (ADR-02) and an optional cookie on a proxy name. It's opened from `once-upon board`, the options page, or Alt+Shift+B, and polls every 3 s while visible.
- **Cards by branch or PR, in columns** Backlog, Working, Agent checks, Waiting, Ready for your review, Ready to ship, PR open, Back to you, Done, Idle and Error, laid out by repo (`services/board/columns.ts` has the rules). A story is a card, so the board is also where PR and local stories wait for review. A local story you've approved at its head waits in Ready to ship until its commit is delivered.
- **Other surfaces on the same page:** a Listeners lane (who listens for which repo, with Stop listening), a worktrees lane, a strip of blank sessions in Idle, usage meters in the header, and a voice side panel for the Larmor session.
- **It's built from** Claude Code's session registry, iTerm tab status, an agent ledger and progress file, Larmor's voice files, status line files, listeners, build and fix requests, local and PR stories (`services/review/story-lists.ts`), `git worktree list`, and GitHub (approvals, checks, threads, requested reviews). ADR-11 lists the outside sources.
- **Actions from the page:** focus a tab, type Build story, Start listening or Assign into a session, Stop listening, Open story, Mark reviewed, add, move and drop Backlog items, Start, Pause, Resume and Stop voice, phone mode, and worktree Clean up. The writes beyond the bridge's own files are in ADR-11.
- **The Backlog is ours.** Its items live in `backlog.jsonl`, an append-only event log (ADR-04), and can be added from the page or `once-upon backlog`. A started item rides on its work's card and is linked to its worktree, session and ledger agent.
- **Snapshots are cached 2 s, and GitHub is never waited on.** The board reads what AutoReview already has and starts checks in the background. AutoReview is also what marks a PR story reviewed on its own (you reviewed after the story was built, or every file is Viewed) and what drops a merged one (`merged.json`).

## Consequences

- No new app or service: the board shares the bridge's process, port, auth and files. Typing into a session is the `Sessions` service (`services/sessions/sessions.ts`), which asks the board for what it needs through a `SessionsFeed` interface and imports nothing from `Board`. The board's routes call `app.sessions`, but Start listening in the panel (`server/routes/story.ts`) still goes through the one-line delegates `Board` keeps, so the panel's routes depend on the board object at run time.
- **The bridge has two jobs.** It's a story server (product-shaped, generic), and a personal dashboard built around one setup: iTerm2's `it2`, a Stop hook that sets tab status, an agent-ledger line format, Larmor, a status line script and `~/.claude` internals. Most of it is behind `board_*` settings, but it's in the same package, routes and process.
- **The board is the biggest part of the bridge.** `services/board/` is about 2,550 source lines: `board.ts` (the actions and the cache, 526 lines) over `stages/` (what each source adds to the data, about 1,800 lines), and the board's test file is 5,799 lines. Sessions, voice, worktrees, the backlog, the ledger and the story lists are services of their own. Column rules (`columns.ts`) encode review etiquette (whose turn it is), which will keep changing.
- The board page is a Preact tree that the poll feeds, and Preact's keyed diff keeps focus, scroll and half-typed text without being told to (ADR-14, ADR-16).
- AutoReview's one GitHub check per PR costs a large GraphQL query per PR every 3 min while the board is open.
- Each poll walks the registry, `ps`, `it2` per session, the ledger tail, the worktree list and the story list (the 2 s cache absorbs a second tab).

## Open questions

1. Is the board part of the product that goes to the Web Store, or the author's own tool that happens to live in the bridge? With a board this size, and Start listening depending on it, should it move to its own package or a plugin, so the bridge can ship without it? What would have to come out of `Board` first (the session registry and typing)?
2. Should the ledger format be documented as an interface (or replaced by an API) rather than parsed by regex from a notes file?
3. Should the board keep stories past 30 days for anything unreviewed?
