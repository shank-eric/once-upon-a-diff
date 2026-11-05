/*
 * The addresses of a PR on github.com. Parsing one back is in pr-key.ts and github-page, which read different shapes.
 */

/** A PR's page: https://github.com/acme/widgets/pull/7, or its tab (`files`, `changes`) when given. */
export function prUrl(repo: string, number: number | string, tab?: string): string {
  return `https://github.com/${repo}/pull/${number}${tab ? `/${tab}` : ''}`;
}
