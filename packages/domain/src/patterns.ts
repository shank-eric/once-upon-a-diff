/*
 * The domain: pure rules that both sides share. Nothing here reads a file, the DOM or the network, and nothing here
 * imports anything, not even the contracts package (which imports the domain, never the other way).
 * The shapes of the ids the pages and the bridge both check.
 */

/** An `owner/name` GitHub repo, as the bridge and the pages name one. */
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** A story's id: the name of its folder, as the bridge and the pages name one. */
export const STORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A Claude Code session id as the board and the panel send it. */
export const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A backlog item's id. */
export const BACKLOG_ID_RE = /^bl_[a-z0-9]{6,24}$/;

/** A full commit id: SHA-1 (40 characters) or SHA-256 (64). A commit abbreviated to 7 or more is `SHA_RE` in text.ts. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A git branch name a page sends: what git allows in a ref (no spaces, control characters or `~^:?*[\\`), at most 255 characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
export const BRANCH_RE = /^[^\s\x00-\x1f\x7f~^:?*[\\]{1,255}$/;

/** A board agent's session id: the first 8 hex characters of a Claude Code session id. */
export const SID_RE = /^[0-9a-f]{8}$/;

/** An agent's, lane's or run's name as the ledger and the backlog take one: letters, digits, `_`, `.` and `-`. */
export const AGENT_NAME_RE = /^[\w.-]{1,100}$/;

/** The branch a backlog card or a ledger line records: letters, digits, `.`, `_`, `-` and `/`, at most 200. Tighter than BRANCH_RE. */
export const CARD_BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
