/*
 * The shapes of a GitHub PR the bridge, the panel and the extension all name: the PR key stories and drafts are stored
 * under, and the commit range in a PR's diff URL. The page routing that reads the rest of GitHub's URLs is host-github's
 * (packages/host-github/src/pages.ts). Pure: no DOM and no browser API, so node can test it.
 */

const COMMIT_RANGE =
  /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\/?$/;

/** The PR key the extension stores state under: "owner/repo#12", lower-cased. */
export const prKey = (repo: string, number: number | string): string =>
  `${repo}#${number}`.toLowerCase();

/** GitHub's diff of a commit range in a PR: /owner/repo/pull/N/files/<from>..<to> (or /changes/…). {from, to} or null. */
export function rangeOfPath(
  pathname: string | null | undefined,
): { from: string; to: string } | null {
  const match = COMMIT_RANGE.exec(String(pathname || ''));
  return match ? { from: match[1], to: match[2] } : null;
}
