/*
 * GitHub, through the gh CLI: the one place the bridge runs it and builds its arguments, with ONCE_UPON_GH standing in
 * for gh in tests. The services call these through foundation/src/gh.ts (the only importer of this file, enforced by
 * depcruise), which hands each the environment config.json asks for (GITHUB_TOKEN dropped, so gh answers as the
 * logged-in user). The callers keep what to do with the answer: they pass a path or a query and get the parsed JSON back,
 * typed as the caller says (`ghApiJson<T>`): an unchecked type, so the caller still guards what it reads.
 */
import { execFile } from 'node:child_process';

/** The gh binary: ONCE_UPON_GH when set (the tests' fake gh), else gh on PATH. */
const ghBinary = () => process.env.ONCE_UPON_GH || 'gh';

export interface GhOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs gh with these arguments and resolves to its stdout.
 * Rejects with the first line of stderr (or of the error) when gh fails.
 */
export function runGh(
  args: string[],
  { timeout = 20000, maxBuffer = 32 * 1024 * 1024, env = process.env }: GhOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghBinary(), args, { env, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim().split('\n')[0]));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** gh's stdout as JSON. Rejects with a short message when it isn't, never with the text itself. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("gh returned something that isn't JSON");
  }
}

const ghApi = (args: string[], options: GhOptions = {}): Promise<string> =>
  runGh(['api', ...args], options);

/**
 * `gh api <path>`, parsed. With `paginate`, gh fetches every page and prints one JSON array per page; they come back
 * as one array.
 */
export async function ghApiJson<T = unknown>(
  path: string,
  { paginate = false, ...options }: GhOptions & { paginate?: boolean } = {},
): Promise<T> {
  const out = await ghApi(paginate ? [path, '--paginate'] : [path], options);
  return (
    paginate
      ? (parseJson(`[${out.trim().replace(/\]\s*\[/g, '],[')}]`) as unknown[]).flat()
      : parseJson(out)
  ) as T;
}

/**
 * `gh api graphql` with a query and its variables (a number is sent as an integer with -F, a string with -f), parsed:
 * the whole `{ data, errors }` answer, so the caller decides what an error means.
 */
export async function ghGraphql<T = unknown>(
  query: string,
  variables: Record<string, string | number> = {},
  options: GhOptions = {},
): Promise<T> {
  const args = ['graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  }
  return parseJson(await ghApi(args, options)) as T;
}

/**
 * `gh pr list` for the open PR whose head is this branch of the repo itself: its number, url and creation time, parsed
 * (an empty array when none). A PR from a fork with the same branch name is dropped: it is not this branch's PR.
 */
export const ghOpenPullList = async (
  repo: string,
  branch: string,
  options: GhOptions = {},
): Promise<{ number: number; url: string; createdAt?: string }[]> => {
  const found = parseJson(
    await runGh(
      [
        ...['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open'],
        ...['--json', 'number,url,createdAt,isCrossRepository', '--limit', '30'],
      ],
      options,
    ),
  ) as { number: number; url: string; createdAt?: string; isCrossRepository?: boolean }[];
  return found
    .filter((pull) => !pull.isCrossRepository)
    .map(({ number, url, createdAt }) =>
      createdAt ? { number, url, createdAt } : { number, url },
    );
};

/**
 * A PR's head branch, for a run started with `--pr N` and no branch (agent start). One gh call, with a short timeout: a
 * start must not hang. Null when gh answers without one; rejects with gh's first error line.
 */
export async function prHeadBranch(
  repo: string,
  number: number,
  options: GhOptions = {},
): Promise<string | null> {
  const body = await ghApiJson<{ head?: { ref?: unknown } } | null>(
    `repos/${repo}/pulls/${number}`,
    {
      timeout: 15000,
      ...options,
    },
  );
  const ref = body?.head?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}
