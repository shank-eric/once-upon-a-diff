/*
 * The commit range in a PR's diff URL, which the panel and the extension read. The PR key stories and drafts are stored
 * under is `prKey` in ids.ts. The page routing that reads the rest of GitHub's URLs is github-page's
 * (packages/client/github-page/src/pages.ts). Pure: no DOM and no browser API, so node can test it.
 */

const COMMIT_RANGE =
  /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\/?$/;

/** GitHub's diff of a commit range in a PR: /owner/repo/pull/N/files/<from>..<to> (or /changes/…). {from, to} or null. */
export function rangeOfPath(
  pathname: string | null | undefined,
): { from: string; to: string } | null {
  const match = COMMIT_RANGE.exec(String(pathname || ''));
  return match ? { from: match[1], to: match[2] } : null;
}
