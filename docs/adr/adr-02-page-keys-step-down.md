# ADR-02: Page keys and the step-down rule

Descriptive, of the code on main at 0741c6c (10/29). Since 11/5: the key code is `records/page-links/page-key.ts` in `packages/core` (the folder was `services/pages`, ADR-20), and the route table is in `packages/contracts` (it was `packages/protocol`, ADR-15). The rules are unchanged.

## Context

The bridge's own pages (a local story's diff page and the agent board) run in the browser with no extension around them, and they need to call the bridge. Giving them the bridge's token would let any of them do anything, including reading every story, typing into sessions and pushing branches. The pages are opened from links that the CLI, the extension or another page hands out.

## Decision

Every key is an HMAC under the bridge's token with its own label (`packages/core/src/records/page-links/page-key.ts`), so no key can be turned into another. A key rides in the link's `#fragment`, which the browser never sends, so a page shell (`/local/<id>/`, `/board/`) carries nothing.

| Key | Label | Reaches | Can hand out |
|---|---|---|---|
| token | (none) | everything. The extension, the CLI and listeners use it | every link |
| board key | `board-page` | the board routes (the `token+board` entries in the contracts package's route table, `packages/contracts/src/board/routes.ts`): snapshot, type into a session's tab, focus a tab, stop a listener, Start, Pause, Resume and Stop voice, phone mode and Stop phone bridge, worktree Clean up, backlog add, move, drop and assign, mark a local story reviewed | a local story's **full** link (Open story) |
| story full key | `local-page:<id>` | every route of that one local story, including Approve, `POST …/pr` (Create pull request's `git push`, and Push for a branch behind its open PR) and `POST …/push` (Push to the default branch) | nothing |
| story read-only key | `local-view:<id>` | an allowlist (`VIEW_KEY_MAY` in `page-key.ts`): read, Ask, Viewed, notes, Send fix requests, Rebuild, page prefs and UI state, `GET …/pr` | nothing |

Nothing hands out the read-only key at present: `links.story(id, true)` has no caller.

**The rule: links only step down in power.** A page can obtain only keys weaker than its own. Story keys work only on local stories (`storyCall` refuses them on a PR story) and never on Add to my review.

On an allowed host name over https, the board trades its key for a `__Host-ou-board` cookie (HttpOnly, Secure, SameSite=Strict, 30 days) at `POST /auth/session`. A write authenticated only by cookie must carry an allowed Origin. The token and story keys can't become cookies.

## Consequences

- A leaked story link stays confined to its story. A read-only one, if one were handed out, could read and annotate that story but not push, type or see the board.
- **The board key is close to the token in practice.** It types `/once-upon …` and Assign lines into Claude sessions, hands out full story keys (which can push branches), and writes outside the bridge: it runs Larmor's `voice_ctl` (Pause and Resume, Start and Stop voice, phone mode: Larmor writes its own files), and removes worktrees and merged branches (ADR-11). It sits in a 30-day cookie on `once-upon.test`.
- The read-only key is default-deny, so a new story route is closed to it until it's listed. The full story key and the board key are default-allow within their scope, so a new story route is open to full links at once.
- The read-only key may send fix requests and Rebuild, which make a listening session change code, commit or re-tell a story, though never push.
- Keys never expire on their own. The only revocation is `token --rotate`, which changes every key and cookie at once and means re-pasting the token into the extension and restarting the bridge.
- `/api/board/link` needs the token, so only the extension or the CLI can start a chain.

## Open questions

1. Should Open story on the board hand out the read-only key by default, with the full key one step further? Today it hands out the full key, and no link carries the read-only one.
2. Should the read-only key keep Send for fix requests and Rebuild?
3. Should keys or cookies carry an expiry or a generation number, so one can be revoked without rotating everything?
4. Should new story routes default-deny for the full key too, with an explicit list like `VIEW_KEY_MAY`?
5. Should the board's writes outside the bridge (Clean up, phone mode, Pause) need something stronger than the board key, such as the token or a per-action confirm key?
