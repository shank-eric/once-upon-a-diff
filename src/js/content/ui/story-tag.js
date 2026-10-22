/*
 * The one story tag a PR gets, on PR lists and on the PR's Conversation tab.
 * The tag is the control:
 *   ready      "Story", a link to Files changed, where the panel docks; once they've read some of it (read.json),
 *              "Story · 2 of 5 read", linking to the first unread chapter, and "Read" (muted) once they've read it all
 *   stale      "Story out of date · Update", asks for an update to the PR's latest commit: a "Since you read it"
 *              chapter for the new commits (Update (new commits)), or with its small "Re-tell" a whole new story
 *   read+new   "Read · 3 new commits · Update" (or "2 of 5 read · …"), with "Re-tell" beside it, when they've read
 *              some of it and the PR has moved on
 *   none       "Build story", asks for one
 *   queued     "Queued", asked for and no session has it yet (not clickable)
 *   building   "Building…", a session claimed it (not clickable)
 * Who's listening is said once per page, per repo, by the notice (notice.js), not on each tag.
 *
 * No DOM or chrome.* here, so node can test it.
 */
import { escapeHtml } from '../../shared/util/html.js';
import { shortSha } from '../../shared/util/text.js';
import { clockTime } from '../../shared/util/time.js';

/**
 * What the tag shows and does, from a status-many result.
 * @returns {{kind: 'link'|'button'|'progress', cls: string, label: string, title: string, href?: string, act?: 'build'|'update', spin?: boolean, base?: string,
 *   alt?: {act: 'retell', label: string, title: string}}}
 */
export function tagFor(result, { repo, number }) {
  const href = `https://github.com/${repo}/pull/${number}/changes`;
  const asked =
    result && result.request && result.request.requested_at
      ? ` at ${clockTime(result.request.requested_at)}`
      : '';
  if (!result || result.state === 'none' || !result.state) {
    const failed = result && result.request && result.request.status === 'failed';
    return {
      kind: 'button',
      act: 'build',
      cls: '',
      label: 'Build story',
      title: `Ask a Claude session to write a story for this PR${failed ? '. The last build failed.' : ''}`,
    };
  }
  if (result.state === 'queued') {
    return {
      kind: 'progress',
      cls: 'queued',
      label: 'Queued',
      title: `A story was asked for${asked}. No session has taken it yet.`,
    };
  }
  if (result.state === 'building') {
    return {
      kind: 'progress',
      cls: 'building',
      label: 'Building…',
      spin: true,
      title: `A Claude session is building the story (asked for${asked})`,
    };
  }
  if (result.updating) {
    return result.update_state === 'building'
      ? {
          kind: 'progress',
          cls: 'building',
          label: 'Updating…',
          spin: true,
          title: 'A Claude session is updating the story to the latest commit',
        }
      : {
          kind: 'progress',
          cls: 'queued',
          label: 'Update queued',
          title: 'An update to the latest commit was asked for. No session has taken it yet.',
        };
  }
  const readCount = result.reads && result.reads.total ? result.reads : null;
  const all = !!readCount && readCount.read >= readCount.total;
  if (result.stale && readCount && readCount.read) {
    const newer = Number.isFinite(result.newer) ? result.newer : null;
    const label = `${all ? 'Read' : `${readCount.read} of ${readCount.total} read`} · ${newer != null ? `${newer} new commit${newer === 1 ? '' : 's'}` : 'new commits'} · Update`;
    return {
      kind: 'button',
      act: 'update',
      base: result.story_head,
      cls: 'stale',
      label,
      title:
        `Update (new commits): you've read ${all ? 'the story' : `${readCount.read} of its ${readCount.total} chapters`}, and the PR has moved on from ${shortSha(result.story_head)} to ${shortSha(result.current_head)}. ` +
        'Adds a "Since you read it" chapter for the new commits, first, and keeps the chapters you read.',
      alt: {
        act: 'retell',
        label: 'Re-tell',
        title:
          'Re-tell from scratch: a whole new story at the latest commit, for a rebase or a big rework',
      },
    };
  }
  if (result.stale) {
    return {
      kind: 'button',
      act: 'update',
      base: result.story_head,
      cls: 'stale',
      label: 'Story out of date · Update',
      title:
        `Update (new commits): the story is for ${shortSha(result.story_head)} and the PR has newer commits (${shortSha(result.current_head)}). ` +
        'Adds a "Since you read it" chapter for them, first, and keeps the chapters you read.',
      alt: {
        act: 'retell',
        label: 'Re-tell',
        title:
          'Re-tell from scratch: a whole new story at the latest commit, for a rebase or a big rework',
      },
    };
  }
  const upTo = result.story_head ? ` (up to date with ${shortSha(result.story_head)})` : '';
  if (all) {
    return {
      kind: 'link',
      href,
      cls: 'read',
      label: 'Read',
      title: `You've read all ${readCount.total} chapters${upTo}. Opens the story on Files changed.`,
    };
  }
  if (readCount && readCount.read) {
    // the panel opens on the step a #prs-step-N hash names (pages/files-changed.js)
    return {
      kind: 'link',
      href: readCount.next ? `${href}#prs-step-${readCount.next}` : href,
      cls: 'ready',
      label: `Story · ${readCount.read} of ${readCount.total} read`,
      title: `You've read ${readCount.read} of ${readCount.total} chapters${upTo}. Opens the first one you haven't read.`,
    };
  }
  return {
    kind: 'link',
    href,
    cls: 'ready',
    label: 'Story',
    title: `Open the story on Files changed${upTo}`,
  };
}

/** The step a Files changed URL's #prs-step-N hash asks the panel to open on, or null. */
export function stepOfHash(hash) {
  const match = /^#prs-step-(\d{1,3})$/.exec(String(hash || ''));
  return match ? Number(match[1]) : null;
}

/** The build request a button tag sends. retell: the stale tag's "Re-tell" was clicked. */
export function requestFor(tag, { repo, number }, { retell = false } = {}) {
  const body = {
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    requested_at: new Date().toISOString(),
  };
  return tag.act === 'update' && tag.base
    ? { ...body, mode: 'update', base_sha: tag.base, ...(retell ? { retell: true } : {}) }
    : body;
}

/**
 * The page's "no session listening" lines: one per repo on the page whose listener is missing.
 * @param {Record<string, {ok: boolean, prompt?: string, details?: string, checkout?: string}>} listening by repo
 */
export function missingListeners(listening) {
  return Object.entries(listening || {})
    .filter(([, listener]) => listener && !listener.ok && listener.prompt)
    .map(([repo, listener]) => ({
      repo,
      prompt: listener.prompt,
      details: listener.details || '',
      checkout: listener.checkout || null,
    }));
}

export const TAG_CSS = `
  :host { all: initial; display: inline-block; vertical-align: middle; margin-left: 6px; }
  .b { font: 500 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; display: inline-flex; align-items: center; gap: 4px;
    padding: 0 7px; border-radius: 999px; border: 1px solid var(--borderColor-default, #d1d9e0); color: var(--fgColor-muted, #59636e);
    background: var(--bgColor-default, #fff); cursor: pointer; text-decoration: none; white-space: nowrap; }
  .b:hover { color: var(--fgColor-accent, #0969da); border-color: var(--fgColor-accent, #0969da); }
  .b.ready { color: var(--fgColor-success, #1a7f37); border-color: var(--fgColor-success, #1a7f37); }
  .b.read { color: var(--fgColor-muted, #59636e); border-color: var(--borderColor-muted, #d1d9e0b3); font-weight: 400; }
  .b.stale { color: var(--fgColor-attention, #9a6700); border-color: var(--fgColor-attention, #9a6700); }
  .b.queued, .b.building { cursor: default; }
  .b.queued:hover, .b.building:hover { color: var(--fgColor-muted, #59636e); border-color: var(--borderColor-default, #d1d9e0); }
  .b[disabled], .alt[disabled] { opacity: .6; cursor: default; }
  .alt { font: 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; margin-left: 3px; padding: 0 2px; border: 0;
    background: none; color: var(--fgColor-muted, #59636e); text-decoration: underline dotted; cursor: pointer; }
  .alt:hover { color: var(--fgColor-accent, #0969da); }
  .spin { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; border-top-color: transparent; animation: s .9s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

/** The tag's HTML, for a shadow root that has TAG_CSS. */
export function tagHtml(tag) {
  const inner = `${tag.spin ? '<span class="spin"></span>' : ''}${escapeHtml(tag.label)}`;
  if (tag.kind === 'link') {
    return `<a class="b ${tag.cls}" href="${escapeHtml(tag.href)}" title="${escapeHtml(tag.title)}">${inner}</a>`;
  }
  const alt = tag.alt
    ? `<button class="alt" data-act="${tag.alt.act}" title="${escapeHtml(tag.alt.title)}">${escapeHtml(tag.alt.label)}</button>`
    : '';
  if (tag.kind === 'button') {
    return `<button class="b ${tag.cls}" data-act="${tag.act}" title="${escapeHtml(tag.title)}">${inner}</button>${alt}`;
  }
  return `<span class="b ${tag.cls}" title="${escapeHtml(tag.title)}" aria-live="polite">${inner}</span>`;
}
