/*
 * What a github.com path says about the page: a PR's Files changed (/files or
 * /changes), its Conversation tab, a PR list, or a commit range inside a PR.
 * The content scripts route on these, and the panel reads the commit range.
 * No DOM or chrome.* here, so node can test it.
 */

const FILES_CHANGED = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(changes|files)(?:\/|$)/;
const CONVERSATION = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const COMMIT_RANGE =
  /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\/?$/;

/** The PR key the extension stores state under: "owner/repo#12", lower-cased. */
export const prKey = (repo, number) => `${repo}#${number}`.toLowerCase();

/**
 * A PR's Files changed page (/owner/repo/pull/N/changes or /files, and anything under them):
 * {owner, repo, number, key, view} with view 'changes' or 'files', else null.
 */
export function filesChangedPr(pathname) {
  const match = FILES_CHANGED.exec(String(pathname || ''));
  if (!match) {
    return null;
  }
  const [, owner, repo, number, view] = match;
  return { owner, repo, number: Number(number), key: prKey(`${owner}/${repo}`, number), view };
}

/** A PR's Conversation tab, /owner/repo/pull/N with nothing after it: {repo: "owner/name", number}, else null. */
export function conversationPr(pathname) {
  const match = CONVERSATION.exec(String(pathname || ''));
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

/** A repo's /pulls, the global /pulls, or a search for PRs (issues searches with is:pr included). */
export function isPullListPage({ pathname, search }) {
  const query = new URLSearchParams(search);
  if (/^\/[^/]+\/[^/]+\/pulls\/?$/.test(pathname) || /^\/pulls\/?$/.test(pathname)) {
    return true;
  }
  if (/^\/search\/?$/.test(pathname)) {
    return (
      /^(pullrequests|issues)$/i.test(query.get('type') || '') ||
      /\bis:pr\b/.test(query.get('q') || '')
    );
  }
  if (/^\/[^/]+\/[^/]+\/issues\/?$/.test(pathname)) {
    return /\bis:pr\b/.test(query.get('q') || '');
  }
  return false;
}

/** The kind of GitHub page this is, for the content script's router: 'files', 'conversation', 'list' or 'other'. */
export function pageKindOf(loc) {
  if (filesChangedPr(loc.pathname)) {
    return 'files';
  }
  if (conversationPr(loc.pathname)) {
    return 'conversation';
  }
  if (isPullListPage(loc)) {
    return 'list';
  }
  return 'other';
}

/** GitHub's diff of a commit range in a PR: /owner/repo/pull/N/files/<from>..<to> (or /changes/…). {from, to} or null. */
export function rangeOfPath(pathname) {
  const match = COMMIT_RANGE.exec(String(pathname || ''));
  return match ? { from: match[1], to: match[2] } : null;
}
