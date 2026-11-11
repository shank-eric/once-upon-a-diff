/*
 * story-kinds.json: what each story was made as (`{story id: "github" or "local"}`), kept in the bridge's own home and
 * written under a lock by the bridge and the CLI (stories/src/placement.ts). Its own file, without valibot, because
 * schemas.ts (which holds the other shared files' formats and points here) is at the package's file-length limit.
 * An entry of any other kind is left out of the view and stays in the file, which whoever records a kind rewrites whole.
 */
export type StoryKinds = Record<string, 'github' | 'local'>;

/** The kinds the file holds, or null when it is not an object. */
export function readStoryKinds(value: unknown): StoryKinds | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, kind]) => kind === 'github' || kind === 'local'),
  ) as StoryKinds;
}
