/**
 * The joins `once-upon doctor` reports across the stores, as pure functions over what the doctor read (so nothing here
 * touches a file, and nothing is fixed): a state folder that matches no story, an inbox story that is no story, and a repo on
 * a card or a cardless run that looks like a typo of a repo the machine otherwise knows. Keys are the id module's.
 */
import { canonicalRepo, repoAlias, repoKey } from '@once-upon-a-diff/terms/ids';

/** A state/ folder and how many files it holds. */
export interface StateFolder {
  name: string;
  files: number;
}

/** The state folders that are neither a story's id nor a story's state key, one line each. */
export function stateFolderProblems(
  folders: StateFolder[],
  storyIds: ReadonlySet<string>,
  stateKeys: ReadonlySet<string>,
): string[] {
  return folders
    .filter((folder) => !storyIds.has(folder.name) && !stateKeys.has(folder.name))
    .map(
      (folder) =>
        `${folder.name} (${folder.files ? `${folder.files} file${folder.files === 1 ? '' : 's'}` : 'empty'})`,
    );
}

/** The inbox story ids that are no story, with how many events each has, one line each. */
export function inboxStoryProblems(
  storyOfEvents: string[],
  storyIds: ReadonlySet<string>,
): string[] {
  const counts = new Map<string, number>();
  for (const story of storyOfEvents) {
    if (story && !storyIds.has(story)) {
      counts.set(story, (counts.get(story) ?? 0) + 1);
    }
  }
  return [...counts].map(([story, count]) => `${story} (${count} event${count === 1 ? '' : 's'})`);
}

/** One use of a repo: a card (its id, with its state) or a cardless run (its name). */
export interface RepoUse {
  repo: string;
  kind: 'card' | 'run';
  label: string;
}

const editDistance = (first: string, second: string): number => {
  let row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i++) {
    const next = [i];
    for (let j = 1; j <= second.length; j++) {
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[second.length];
};

/**
 * How near a repo key is to another's, or null when too far to call a typo. One edit counts from a 6-character name and two
 * from 10, so short siblings (`app`, `ui`, `api`) are not typos of each other, and keys that differ only in a trailing number
 * (`svc-1`, `svc-2`) are different repos.
 */
function closeness(key: string, other: string): number | null {
  if (key.replace(/\d+$/, '') === other.replace(/\d+$/, '')) {
    return null;
  }
  const distance = editDistance(key, other);
  const length = Math.min(nameOf(key).length, nameOf(other).length);
  if (distance === 1 && length >= 6) {
    return 1;
  }
  return distance === 2 && length >= 10 ? 2 : null;
}

const nameOf = (repo: string): string => repo.slice(repo.indexOf('/') + 1).toLowerCase();

const some = (labels: string[]): string =>
  labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3} more` : '');

/**
 * The repos on cards and cardless runs, checked against `anchored`: the repos a store that never takes a typed repo vouches
 * for (a checkout's remote, a PR's URL). Nothing here asks the network. A repo that is not anchored is a suspect when it
 * has the name of an anchored repo under another owner, or is within one edit of one (two for a long name, see `closeness`). `owners` lists a name that more than
 * one owner uses (a fork, or a typo: doctor does not say which). `unvouched` lists the rest of the repos nothing vouches for.
 */
export function repoProblems(
  anchored: string[],
  uses: RepoUse[],
): { suspects: string[]; owners: string[]; unvouched: string[] } {
  const known = new Map<string, string>();
  for (const repo of anchored) {
    if (!known.has(repoKey(repo))) {
      known.set(repoKey(repo), canonicalRepo(repo));
    }
  }
  const groups = new Map<string, { repo: string; uses: RepoUse[] }>();
  for (const use of uses) {
    // grouped as spelled (lower-cased): a named typo reads as the repo it is a typo of everywhere else, but doctor flags it
    const key = use.repo.toLowerCase();
    if (key) {
      const group = groups.get(key) ?? { repo: use.repo, uses: [] };
      group.uses.push(use);
      groups.set(key, group);
    }
  }
  const countsOf = (group: { uses: RepoUse[] }): string => {
    const cards = group.uses.filter((use) => use.kind === 'card').length;
    const runs = group.uses.length - cards;
    return [
      cards && `${cards} card${cards === 1 ? '' : 's'}`,
      runs && `${runs} run${runs === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(', ');
  };
  const suspects: string[] = [];
  const settled: { repo: string; uses: RepoUse[]; key: string }[] = [];
  for (const [key, group] of groups) {
    const typoOf = repoAlias(key);
    if (typoOf) {
      suspects.push(
        `${group.repo} (${some(group.uses.map((use) => `${use.kind} ${use.label}`))}) looks like ${typoOf}`,
      );
      continue;
    }
    if (known.has(key)) {
      settled.push({ ...group, key });
      continue;
    }
    const sameName = [...known].find(([other]) => nameOf(other) === nameOf(key));
    const near = [...known]
      .map(([other, spelled]) => ({ spelled, distance: closeness(key, other) }))
      .filter((hit): hit is { spelled: string; distance: number } => hit.distance !== null)
      .sort((first, second) => first.distance - second.distance)[0];
    const like = sameName?.[1] ?? near?.spelled;
    if (like) {
      suspects.push(
        `${group.repo} (${some(group.uses.map((use) => `${use.kind} ${use.label}`))}) looks like ${like}`,
      );
    } else {
      settled.push({ ...group, key });
    }
  }
  const byName = new Map<string, typeof settled>();
  for (const group of settled) {
    byName.set(nameOf(group.key), [...(byName.get(nameOf(group.key)) ?? []), group]);
  }
  const owners = [...byName]
    .filter(([, group]) => group.length > 1)
    .map(
      ([name, group]) =>
        `${name} is used under ${group.length} owners: ${group
          .map((one) => `${one.repo} (${countsOf(one)})`)
          .join(', ')}`,
    );
  const unvouched = settled
    .filter((group) => !known.has(group.key))
    .map((group) => `${group.repo} (${countsOf(group)})`);
  return { suspects, owners, unvouched };
}
