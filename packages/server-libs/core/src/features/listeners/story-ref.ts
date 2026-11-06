/*
 * The story a `--story` flag names. It takes the id itself, a PR (owner/name#N or its URL), or a bare PR number in the repo of
 * the checkout the command runs in. A PR's story is the one the bridge has for it, else the id `once-upon publish` will give it.
 */
import { repoOfCheckout, checkoutRoot } from '@once-upon-a-diff/foundation/repos';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { parsePrRef, storyIdForPr } from '@once-upon-a-diff/terms/ids';

/** The repo (owner/name) of the checkout that holds `cwd`, or null. */
export function repoAt(cwd: string): string | null {
  try {
    return repoOfCheckout(checkoutRoot(cwd));
  } catch {
    return null;
  }
}

/** `value` as a story id. `repoHere` says which repo a bare number means (the caller's checkout). */
export function resolveStory(home: string, value: string, repoHere: () => string | null): string {
  const text = String(value).trim();
  const pr = parsePrRef(text);
  let repo: string | null = pr ? pr.repo : null;
  const number = pr ? pr.number : /^\d+$/.test(text) && text;
  if (!number) {
    return text;
  }
  repo ||= repoHere();
  if (!repo) {
    throw new Error(`--story ${text}: run it in the repo's checkout, or say owner/name#${text}`);
  }
  const found = new StoryStore({ home }).find(repo, number);
  return found ? found.id : storyIdForPr(repo, number);
}
