/* What the story routes check before they act: a local story only, and one push at a time for a story. */
import { HttpError } from '../request.ts';
import type { ServedStory } from '@once-upon-a-diff/core/records/stories/types';

/** Refuses (400, with the route's own words) a story that isn't a local one. */
export function localOnly(story: ServedStory, why: string): void {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, why);
  }
}

/** Stories with a push or a pull request push under way, across every route that pushes. */
const pushing = new Set<string>();

/** Runs the push unless one is already running for the story (409), and frees the story when it ends or throws. */
export async function oncePerStory<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (pushing.has(id)) {
    throw new HttpError(409, 'a push for this story is already running');
  }
  pushing.add(id);
  try {
    return await work();
  } finally {
    pushing.delete(id);
  }
}
