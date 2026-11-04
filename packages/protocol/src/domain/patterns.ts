/*
 * The domain: pure rules that both sides share. Nothing here reads a file, the DOM or the network, and nothing here
 * imports anything, not even the rest of the protocol (the protocol imports the domain, never the other way).
 * The shapes of the ids the pages and the bridge both check.
 */

/** An `owner/name` GitHub repo, as the bridge and the pages name one. */
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** A Claude Code session id as the board and the panel send it. */
export const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A backlog item's id. */
export const BACKLOG_ID_RE = /^bl_[a-z0-9]{6,24}$/;

/** A git branch name a page sends: what git allows in a ref (no spaces, control characters or `~^:?*[\\`), at most 255 characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
export const BRANCH_RE = /^[^\s\x00-\x1f\x7f~^:?*[\\]{1,255}$/;
