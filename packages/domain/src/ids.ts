/*
 * The keys a thing is called by, one function for each: a repo, a PR, a branch, a story and the folder its state is kept in,
 * the board's work keys, an agent and a run. Every store, the board and the extension build and read these through here, so
 * a key has one spelling. Pure, so the engine, the board and the extension share it. Each function returns exactly what the
 * code that built the key inline returned, because the keys are on disk (builds.json, the state/ folders, stories.json,
 * the cursors and listeners files) and in the extension's storage: a change to one is a migration.
 *
 * What is NOT here: git remote parsing (foundation/repos.ts, it runs git), the lane keys (lane-key.ts, a lane may not be a
 * repo) and the minting of a fresh id (foundation/ids.ts, it needs random bytes).
 */

/** A repo as a lookup key: lower-cased, since GitHub's owner and repo names compare without case. Null reads as none (''). */
export const repoKey = (repo: string | null | undefined): string => (repo ?? '').toLowerCase();

/** Whether two repos (owner/name) are the same one. False when either is empty. */
export const sameRepo = (first: unknown, second: unknown): boolean =>
  !!first && !!second && String(first).toLowerCase() === String(second).toLowerCase();

/** The PR key stories and drafts are stored under and the builds file is keyed by: "owner/repo#12", lower-cased. */
export const prKey = (repo: string, number: number | string): string =>
  `${repo}#${number}`.toLowerCase();

/** A branch of a repo, as a lookup key: the repo lower-cased, the branch as it is. */
export const branchKey = (repo: string | null | undefined, branch: string): string =>
  `${repoKey(repo)}@${branch}`;

/** What every `prKey` or `branchKey` of a repo starts with, to find a repo's keys in a map. */
export const prKeyPrefix = (repo: string | null | undefined): string => `${repoKey(repo)}#`;
export const branchKeyPrefix = (repo: string | null | undefined): string => `${repoKey(repo)}@`;

/** What the board's works are keyed by: a PR, a local story and a branch with no PR. */
export const prWorkKey = (repo: string, number: number | string): string =>
  `pr:${repo.toLowerCase()}#${number}`;
export const storyWorkKey = (id: string): string => `story:${id}`;
export const branchWorkKey = (repo: string, branch: string): string =>
  `branch:${branchKey(repo, branch)}`;

/** A local story's key in the builds file (a PR story's is its `prKey`). */
export const storyBuildKey = (id: string): string => `story:${id}`;

/** A story's id from text: anything but letters, digits, `.`, `_` and `-` becomes a dash, trimmed, at most 100 characters. */
export const slug = (text: string): string =>
  String(text)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

/**
 * The id `once-upon publish` gives a PR's story: the repo as GitHub's page URL spells it (the case is kept, so a PR's id is the
 * same on every rebuild), dashed, and the number. Callers look a story up by repo and number first and mint this only for a
 * PR with no story.
 */
export const storyIdForPr = (repo: string, number: number | string): string =>
  slug(`${repo.replace('/', '-')}-${number}`);

/** The folder under state/ that holds a PR's per-PR files (what has been read, the drafts), lower-cased: "pr-owner-repo-12". */
export const stateKeyForPr = (repo: string, number: number | string): string =>
  `pr-${repo.replace('/', '-')}-${number}`.toLowerCase();

/** The name of a repo's listener (a cursor and a listener file, `repo-owner-name`), as `once-upon wait --repo` gives it. */
export const repoListenerName = (repo: string): string =>
  `repo-${String(repo).toLowerCase().replace('/', '-')}`;

/** The name of a repo's parts file under parts/, `owner-name.json`. */
export const partsFileName = (repo: string): string =>
  `${repo.toLowerCase().replace(/\//g, '-')}.json`;

/** The PR a story id, `owner/name#N` or a PR URL names: {repo, number} with both as typed, else null. */
export function parsePrRef(text: string): { repo: string; number: string } | null {
  const hit =
    /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(text) ||
    /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(text);
  return hit ? { repo: hit[1], number: hit[2] } : null;
}

/** An agent's id: the first 8 characters of its session id, a colon and the name it registered under. */
export const agentId = (sid8: string, name: string): string => `${sid8}:${name}`;

/** An agent's card on the board. */
export const agentWorkKey = (sid8: string, name: string): string => `agent:${agentId(sid8, name)}`;

/** A run's id as `agent start` mints it: `r_` and 10 hex digits. A review draft's id is `r_` too, but longer. */
export const RUN_ID_RE = /^r_[0-9a-f]{10}$/;
