# ADR-10: Polling everywhere, with no push channel

Descriptive, of the code on main at 0741c6c (10/29).

## Context

State changes come from many processes: Claude rewrites `chapters.json`, the CLI answers a question, a session claims a request, a branch gets a commit. The pages need to follow, and the bridge has no event bus, because writers are often other processes writing files (ADR-05).

## Decision

| Who | Polls | Every |
|---|---|---|
| Panel (GitHub and local) | `GET …/pulse`: version, questions (with what a session says it is doing and the unread-answer count), drafts, fixes and working revs, listening, who answers, rebuild, request | 5 s while visible (`packages/panel/src/overlay.ts` `TICK_MS`), and a "still open" `POST …/seen` every 60 s while hidden |
| Local page, panel closed | `GET …/version` | 5 s |
| PR lists and Conversation tags | `POST /api/stories/status-many` | on load and redraw, 10 s while queued or building, 30 s while the bridge is down, and at about 5, 15 and 30 s after Start listening, to see who listens |
| Board page | `GET /api/board` | 3 s while visible |
| Create pull request box | PR state | 30 s |
| `once-upon wait` | `inbox.jsonl` via `fs.watch`, plus `builds.json` and `fixes.json` | each change, or 2 s |
| Listener heartbeat | writes `listeners/<consumer>.json` | 5 s |

The pulse is one call, so the panel fetches a part only when its rev changes.

## Consequences

- It's simple and survives bridge restarts, sleep and reloads with no reconnect logic.
- Changes show within about 2 to 5 s, not at once.
- The bridge's own polling of GitHub (3 minutes) has a nudge, not a push channel: the extension tells it when you act on GitHub (`POST /api/github/refresh`), which marks that PR's cached answers stale so the board's next poll asks again; the poll stays the fallback.
- **The cost grows with open tabs and file sizes.** Each pulse rereads the whole `inbox.jsonl`, loads and normalizes the story, runs `refreshLocal` for a local story (two `git rev-parse`, possibly a re-diff), reads the listeners folder and the fixes, and hashes it all. Ten open panels make two pulses a second, each reading the whole inbox.
- **Reads have side effects.** Pulses and version polls write `seen.json` (throttled to 30 s), `refreshLocal` rewrites files in the checkout, and loading a local story rewrites `checkouts.json`. Listener auto-stop depends on these polls happening.
- Background tabs are throttled by Chrome. The 60 s "still open" ping is there so a hidden tab still counts.

## Open questions

1. Cache the pulse per story for a second or two, as the board does, so several tabs cost one read?
2. Keep a byte offset into the inbox per story in the bridge, instead of rereading it all?
3. Is Server-Sent Events from the bridge worth it for the panel? The bridge would still have to watch files for CLI writes.
4. Should a GET ever write? Move `refreshLocal` and `seenCheckout` out of read paths?
