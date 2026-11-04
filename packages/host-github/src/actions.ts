/*
 * What you just did on a GitHub page that changes a PR's state (submit a review, open a PR, merge, mark ready for review,
 * close), read from the control you clicked or the form you submitted and the page's URL. The extension tells the bridge, which
 * asks GitHub again so the board's card moves now and not at the next poll (bridge services/review/auto-review.ts refresh).
 *
 * This is a guess at intent, made from GitHub's button texts and URLs, which GitHub can change. A wrong guess costs one
 * request to GitHub, and a miss costs nothing: the bridge's own poll still runs. The page's text is untrusted (a PR's
 * description can say anything), so only a real control counts, never rendered markdown, and a branch is read from the URL.
 * No chrome.* here, and the DOM only through the small `El` shape below, so node can test it.
 */
import { conversationPr, filesChangedPr } from './pages.ts';

/** What the refresh's `reason` can be: the protocol's list (GITHUB_REFRESH_REASONS). */
export type RefreshReason = 'review' | 'open' | 'merge' | 'ready' | 'close';

/** An action seen: the repo it was on, and the PR's number and head branch when the page says them. */
export interface Intent {
  reason: RefreshReason;
  repo: string;
  number?: number;
  branch?: string;
}

/** The part of an Element this reads (so a test needs no DOM). */
export interface El {
  closest(selector: string): El | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
  /** an `<input type=submit>`'s label */
  value?: string;
}

/** The controls that count: a button, a submit input, or anything the page marks as one. */
const CONTROL = 'button, input[type="submit"], [role="button"]';
/** Rendered user content, where a "button" is only text someone wrote (a PR description, a comment, a review body). */
const USER_CONTENT =
  '.markdown-body, .comment-body, .js-comment-body, [data-testid="markdown-body"]';

/** Button text, exactly (whitespace folded, case ignored), to the action it does. */
const BUTTONS: [RegExp, RefreshReason][] = [
  [/^submit review$/, 'review'],
  [
    /^(merge pull request|squash and merge|rebase and merge|confirm (merge|squash and merge|rebase and merge))$/,
    'merge',
  ],
  [/^(ready for review|convert to draft)$/, 'ready'],
  [/^(close pull request|reopen pull request)$/, 'close'],
  [/^create (draft )?pull request$/, 'open'],
];

/** A control's label: the text you see, else an input's `value` (its label), else its aria-label. A button's own `value` attribute is not its label. */
const text = (control: El) =>
  String(control.textContent?.trim() || control.value || control.getAttribute('aria-label') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The head branch a compare or new-PR path names, when it is a branch of the repo itself: null for a fork's or none. */
export function compareHead(pathname: string): { repo: string; branch: string | null } | null {
  const match =
    /^\/([^/]+)\/([^/]+)\/compare\/(.+?)\/?$/.exec(pathname) ??
    /^\/([^/]+)\/([^/]+)\/pull\/new\/(.+?)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  const [, owner, name, spec] = match;
  let decoded: string;
  try {
    decoded = decodeURIComponent(spec);
  } catch {
    return { repo: `${owner}/${name}`, branch: null };
  }
  // `base...head`, `base..head` or just `head`; a base can hold slashes, so split at the dots
  const head = decoded.includes('..') ? decoded.slice(decoded.lastIndexOf('..') + 2) : decoded;
  // `owner:head` and `owner:repo:head` (a branch name never holds a colon): the repo's own branch only when owner (and repo) are this one's
  const parts = head.split(':');
  const branch = parts[parts.length - 1];
  const from = parts.slice(0, -1);
  const own =
    from.length === 0 ||
    (from[0].toLowerCase() === owner.toLowerCase() &&
      (from.length === 1 || from[1].toLowerCase() === name.toLowerCase()));
  return { repo: `${owner}/${name}`, branch: own && branch ? branch : null };
}

/** What a PR page's URL names (its Conversation or Files changed tab). */
function prOfPath(pathname: string): { repo: string; number: number } | null {
  const files = filesChangedPr(pathname);
  return files
    ? { repo: `${files.owner}/${files.repo}`, number: files.number }
    : conversationPr(pathname);
}

/**
 * What a click did, from the element clicked and the page's path: an action when it is on a real control whose whole text is
 * one of GitHub's (a Submit review, a Merge or Confirm merge, Ready for review, Close pull request, Create pull request),
 * on the page it belongs to (a PR's, or its compare page for Create pull request). Null for anything else.
 */
export function intentOfClick(target: El | null, pathname: string): Intent | null {
  const control = target?.closest(CONTROL);
  if (!control || control.closest(USER_CONTENT)) {
    return null;
  }
  const label = text(control);
  const found = BUTTONS.find(([pattern]) => pattern.test(label));
  if (!found) {
    return null;
  }
  const reason = found[1];
  if (reason === 'open') {
    const compare = compareHead(pathname);
    return compare
      ? { reason, repo: compare.repo, ...(compare.branch ? { branch: compare.branch } : {}) }
      : null;
  }
  const pr = prOfPath(pathname);
  return pr ? { reason, repo: pr.repo, number: pr.number } : null;
}

/**
 * What a form submit did: a review's form (`/owner/repo/pull/N/reviews`, the classic Files changed page) or the Create pull
 * request form (`/owner/repo/pull/create`, on the compare page). `action` is the form's action path.
 */
export function intentOfSubmit(action: string, pathname: string): Intent | null {
  const review = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/reviews\/?$/.exec(action);
  if (review) {
    return { reason: 'review', repo: `${review[1]}/${review[2]}`, number: Number(review[3]) };
  }
  if (/^\/[^/]+\/[^/]+\/pull\/create\/?$/.test(action)) {
    const compare = compareHead(pathname);
    return compare
      ? {
          reason: 'open',
          repo: compare.repo,
          ...(compare.branch ? { branch: compare.branch } : {}),
        }
      : null;
  }
  return null;
}
