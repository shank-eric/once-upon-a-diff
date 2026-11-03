/*
 * Lane keys. A board lane is keyed by the full "owner/name" of its repo, so two owners' repos of one name are two lanes;
 * a lane with no repo (a folder, "General", "No live session") is keyed by its own name. A lane is shown by its short
 * name unless two lanes' short names are the same. Keys compare without regard to case (GitHub's owner and repo names
 * do, and the places that name a repo spell it differently). Pure, so the bridge, the board page and node tests share it.
 */

/** The short name of a lane key: the repo's name for "owner/name", else the key as it is. */
export const shortLane = (key: string): string => key.slice(key.indexOf('/') + 1);

/** Whether two lane keys (or a key and a repo) are the same lane. */
export const sameLaneKey = (first: string, second: string): boolean =>
  first.toLowerCase() === second.toLowerCase();

/** The distinct keys, the first spelling of each. */
const distinct = (keys: Iterable<string>): string[] => {
  const seen = new Map<string, string>();
  for (const key of keys) {
    if (!seen.has(key.toLowerCase())) {
      seen.set(key.toLowerCase(), key);
    }
  }
  return [...seen.values()];
};

/**
 * The label for each key given (every spelling of it): its short name, or the whole key when another lane has the same
 * short name. A key with no short name (a session in "/") is labeled by the key itself.
 */
export function laneLabels(keys: Iterable<string>): Map<string, string> {
  const all = [...new Set(keys)];
  const counts = new Map<string, number>();
  for (const key of distinct(all)) {
    const short = shortLane(key).toLowerCase();
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return new Map(
    all.map((key) => {
      const short = shortLane(key);
      return [key, !short || (counts.get(short.toLowerCase()) ?? 0) > 1 ? key : short];
    }),
  );
}

/**
 * The lane key for a lane tag (a ledger agent's `lane:<name>`, which is usually a short name): the one known "owner/name"
 * whose short name is the tag. A tag that names none of them, or more than one (two owners' repos of that name), stays
 * as it is, because nothing says which repo it meant.
 */
export function resolveLane(tag: string, knownKeys: Iterable<string>): string {
  const known = distinct(knownKeys).filter((key) => key.includes('/') && shortLane(key));
  if (tag.includes('/')) {
    return known.find((key) => sameLaneKey(key, tag)) ?? tag;
  }
  const named = known.filter((key) => sameLaneKey(shortLane(key), tag));
  return named.length === 1 ? named[0] : tag;
}

/** Whether a lane tag names a lane key: the whole key, or its short name. */
export const tagNamesLane = (tag: string, key: string): boolean =>
  sameLaneKey(tag, key) || sameLaneKey(tag, shortLane(key));
