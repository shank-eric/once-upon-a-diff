# ADR-06: Claude sessions and listeners as the working side

Descriptive, of the code on main at 7fa8447 (11/4).

## Context

Questions, Build story, Update, Rebuild and Fix before push all need a model working in the repo's checkout, with the reviewer's tools and permissions. The bridge has no model, no API key and no agent loop of its own.

## Decision

- **The bridge only queues.** Questions go to `inbox.jsonl`, build, update and rebuild requests to `builds.json` (one per PR, or `story:<id>`), and fix requests to `fixes.json`.
- **A Claude Code session does the work by running `once-upon wait` as a background task** (the once-upon-listen skill). The wait writes a heartbeat every 5 s (`listeners/<consumer>.json`, written by `services/listeners/listeners.ts`), blocks on `fs.watch` plus a 2 s poll, and exits when it has something. The exit wakes the session, which handles the request and starts the wait again.
- **Scopes and routing** (`services/inbox/conversation.ts`, `builds.ts`, `fixes.ts`): `--story <id>` beats `--repo owner/name`, which beats a catch-all wait. A repo wait defers a story's questions to that story's live listener and takes them back when it goes quiet (`*.deferred.json`). Build and Update requests go only to repo waits.
- **Claims.** A wait claims each build request (`claimed_by`, `claimed_at`) in the same locked write that hands it out (`services/inbox/queue.ts`), so two waits can't both take it. A claim goes stale after 30 min without `builds --start`. Fix requests are claimed with no expiry, and the reviewer's remedy is Take back. Questions are handed once (`handed.json`) and never re-handed: `routeQuestions` checks that no other wait has a question and marks it as this wait's in one write under `handed.json.lock`, so two waits on one repo can't both take it.
- **Liveness.** A listener is live while its waiting beat is under 15 s old with a live pid, or for 10 min after a handover ("answering"). `working` keeps a handling beat fresh.
- **Natural end.** A `--story` or `--repo` wait stops itself when no page has shown its stories for 10 min (`seen.json`, written from page polls), or on the board's Stop listening (`listener-stops.json`). It never stops while it holds a claim. It prints "Stopped listening", and the skill treats that as final.
- **Identity is the `--consumer` string**: `repo-<owner>-<name>`, `story-<id>`, or a name you pass. It's what the panel shows ("Answered by …").
- **Getting a session listening.** The once-upon skill starts a `--story` wait after a build, and **Start listening** is on every surface: under the Ask box in the panel (GitHub and the local page), in the notice on PR lists and a PR's Conversation tab, and on the board. It types `/once-upon-listen <repo>` (or `--story <id>`) into an idle iTerm tab (ADR-11). The Copy prompt button is gone, and a session without the skill gets a line to type by hand.
- **A story built by a named subagent is bound to it** (`services/inbox/binding.ts`, `state/<id>/agent.json`, set by `--agent` on `publish` or `local`, or `once-upon bind`). A subagent can't wait, because its background tasks end when it hands back. So the session that launched it runs the wait (`wait --story`, or any wait it already has), and what comes in on the story is printed with a message to `SendMessage` to the agent (`services/inbox/relay.ts`, `relayEntryMessage`): a question, a Rebuild, and on a local story a Fix before push request or an Approve, when the agent is a registered author (`mayRelay`). Only a wait in the owning session relays. The agent answers with `once-upon answer`, reports a fix with `once-upon fixed` and publishes a rebuild itself. When `SendMessage` can't reach it, the session never edits in the agent's place: a fix or rebuild is failed back (`relayFallback`). A binding is ignored once it's a day old or its session has ended, and `--no-relay` turns it off for one wait.
- **Voice questions and live status.** `once-upon ask --story <id> --text … [--voice]` files a question as the Ask box does, so the voice session can ask aloud. A session says what it is doing with `once-upon asking` (`asking.json`), and the panel shows the question as being worked on, then as gone quiet after 5 minutes of silence. Answers are flagged New until the reviewer has had them in view.
- **`approved` entries.** Approve on a local story appends an `approved` line to the inbox, and `wait` hands it to the story's listener, or to a repo listener when no story listener is live (`approvalsToTake`).

## Consequences

- No model runs unless a session is listening. The panel shows Queued, the light amber, and the PR tags a notice.
- The work runs with the session's own permissions and context. The safety rules are in the skills (ADR-13). A bound subagent answers from its own context, which is the point of the relay.
- **A relay needs the launching session to be the one that hears the question.** A repo or catch-all listener in another session takes it like any other and answers without the agent's context. Once the binding is stale, every listener does.
- **Work lost when a session dies mid-request.** A handed question is never re-handed. A claimed fix request stays "building" until Take back. A wait killed between advancing its cursor and printing loses those questions for that consumer (`state-map.md` §7.3).
- **Name collisions are silent.** Two sessions listening for one repo with the default consumer share one cursor and one beat file, and the bridge sees one listener.
- Each wake-up is a model turn in the listening session. A busy repo means many turns.
- `seen.json` comes from polling, so auto-stop depends on pages polling (ADR-10). A browser that throttles timers in background tabs can let a listener stop while the tab is still open.

## Open questions

1. Should a question whose handling beat has expired, with no answer, go back to the queue? The panel now says it has gone quiet, and nothing picks it up.
2. Should fix claims expire like build claims, or be refreshed by `working`?
3. Should `wait` refuse to start when a live listener already has its consumer name?
4. Should `wait` advance its cursor only after it has printed what it took?
5. Should the bridge start a headless session (`claude -p`) for a queued request, instead of relying on someone typing into a tab?
