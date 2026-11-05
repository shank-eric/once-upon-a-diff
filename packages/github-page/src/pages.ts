/*
 * What a github.com path says about the page: a PR's Files changed (/files or /changes), its Conversation tab, or a PR
 * list. The extension's content scripts route on these. No DOM or chrome.* here, so node can test it.
 */
import { prKey } from '@once-upon-a-diff/domain/pr-key';

/** A PR's Files changed page. */
export interface FilesChangedPr {
  owner: string;
  repo: string;
  number: number;
  key: string;
  view: string;
}

export type PageKind = 'files' | 'conversation' | 'list' | 'other';

const FILES_CHANGED = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(changes|files)(?:\/|$)/;
const CONVERSATION = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

/**
 * A PR's Files changed page (/owner/repo/pull/N/changes or /files, and anything under them):
 * {owner, repo, number, key, view} with view 'changes' or 'files', else null.
 */
export function filesChangedPr(pathname: string | null | undefined): FilesChangedPr | null {
  const match = FILES_CHANGED.exec(String(pathname || ''));
  if (!match) {
    return null;
  }
  const [, owner, repo, number, view] = match;
  return { owner, repo, number: Number(number), key: prKey(`${owner}/${repo}`, number), view };
}

/** A PR's Conversation tab, /owner/repo/pull/N with nothing after it: {repo: "owner/name", number}, else null. */
export function conversationPr(
  pathname: string | null | undefined,
): { repo: string; number: number } | null {
  const match = CONVERSATION.exec(String(pathname || ''));
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

/** A repo's /pulls, the global /pulls, or a search for PRs (issues searches with is:pr included). */
export function isPullListPage({
  pathname,
  search,
}: {
  pathname: string;
  search: string;
}): boolean {
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
export function pageKindOf(loc: { pathname: string; search: string }): PageKind {
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
