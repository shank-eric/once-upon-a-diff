/*
 * GitHub's commit-range pages and what the panel's host port asks of them (host.ts in the panel): the link to the diff of
 * just some commits, the way back from it, and that drafts can be posted on GitHub's page.
 */
import { sameSha } from '@once-upon-a-diff/terms/text';
import { rangeOfPath } from '@once-upon-a-diff/terms/pr-key';
import type { PanelHost } from '@once-upon-a-diff/panel/host/host';

/** The step (1-based) of the "Since you read it" chapter for the range this page shows, or null. */
export function rangeStepOf(
  chapters: { since?: { from: string; to: string } }[],
  pathname: string,
): number | null {
  const range = rangeOfPath(pathname);
  if (!range) {
    return null;
  }
  const index = chapters.findIndex(
    (chapter) =>
      chapter.since &&
      sameSha(chapter.since.from, range.from) &&
      sameSha(chapter.since.to, range.to),
  );
  return index < 0 ? null : index + 1;
}

/**
 * The link to GitHub's diff of just a chapter's commits. /changes/<from>..<to> loads as is logged in
 * (checked 2026-10-22) and redirects to /files/<from>..<to> logged out.
 */
export const rangeUrl = (
  prUrl: string | null | undefined,
  since: { from: string; to: string } | null | undefined,
): string | null =>
  prUrl && since ? `${String(prUrl).replace(/\/+$/, '')}/changes/${since.from}..${since.to}` : null;

/** On that range's own page, the link back to all of the PR's changes; null anywhere else. */
export function backFromRange(
  prUrl: string | null | undefined,
  since: { from: string; to: string },
): string | null {
  return rangeUrl(prUrl, since) && rangeStepOf([{ since }], location.pathname) === 1
    ? `${prUrl}/changes`
    : null;
}

/** GitHub's side of the host port's link members. */
export const GITHUB_HOST_LINKS: Pick<PanelHost, 'rangeLink' | 'backFromRange' | 'canPostDrafts'> = {
  rangeLink: rangeUrl,
  backFromRange,
  canPostDrafts: true,
};
