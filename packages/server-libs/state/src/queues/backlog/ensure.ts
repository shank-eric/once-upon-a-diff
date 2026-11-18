/**
 * The one place a card is found or made (ADR-29). Whatever first learns of some work (an agent starting, a session, a PR, a story)
 * asks here: a card already on that work gets what it lacked (`link`), and none means one `add`. The find and the write are one
 * step under the backlog file's lock, so two writers racing (a CLI start and the bridge) make one card. Gh and git answers are the
 * caller's to ask and pass in: this reads only the stored cards.
 */
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import type { BacklogStore, AddInput } from './backlog.ts';
import type { BacklogItem, CardSource } from './types.ts';

export interface EnsureInput extends AddInput {
  source: CardSource;
}

/** A card the work can still be on: not dropped, not landed. */
const open = (item: BacklogItem): boolean => item.state !== 'dropped' && !item.landed_at;

/** Whether a branch can name one piece of work: a feature branch, never main or a detached HEAD (no branch). */
const namesWork = (branch: string | null | undefined): branch is string =>
  !!branch && !DEFAULT_BRANCHES.has(branch);

/** The card these facts are about, or undefined: by explicit id, then repo and PR number, then repo and branch, then (for a session's card) the session. */
export function findCard(
  items: BacklogItem[],
  input: Omit<EnsureInput, 'title'>,
): BacklogItem | undefined {
  if (input.id) {
    return items.find((item) => item.id === input.id);
  }
  const live = items.filter(open);
  const sameWork = (item: BacklogItem) =>
    input.repo ? sameRepo(item.repo, input.repo) : !item.repo;
  return (
    (input.pr ? live.find((item) => item.pr === input.pr && sameWork(item)) : undefined) ??
    (namesWork(input.branch)
      ? live.find((item) => item.branch === input.branch && sameWork(item))
      : undefined) ??
    (input.source === 'session' && input.session
      ? live.find((item) => item.source === 'session' && item.session === input.session)
      : undefined)
  );
}

/**
 * The card for this work: the one found (given the facts it lacked) or a new one. `made` says which. A branch that is not a
 * feature branch is not stored on a new card either (it would join every card on main).
 */
export function ensureCard(
  store: BacklogStore,
  input: EnsureInput,
): { item: BacklogItem; made: boolean } {
  return withLock(store.file, () => {
    const found = findCard(store.items(), input);
    if (found) {
      return {
        item: store.link(found.id, {
          repo: found.repo ? null : input.repo,
          branch: found.branch || !namesWork(input.branch) ? null : input.branch,
          worktree: found.worktree ? null : input.worktree,
          pr: found.pr ? null : input.pr,
          story: found.story ? null : input.story,
          session: found.session ? null : input.session,
          by: input.by,
        }),
        made: false,
      };
    }
    return {
      item: store.add({ ...input, branch: namesWork(input.branch) ? input.branch : null }),
      made: true,
    };
  });
}
