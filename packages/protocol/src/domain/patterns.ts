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
