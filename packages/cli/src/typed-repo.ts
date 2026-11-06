/*
 * The warning for a repo typed by hand (`--repo owner/name`): it is on none of the repos this machine works in, so it is
 * probably a typo (the 11/5 `esshank/...` and `eshank/...`). Warns now and still writes; ADR-25's flip refuses. A repo the
 * command took from the checkout's origin is not typed and is never asked about.
 */
import { repoOfCheckout, typedRepoNote } from '@once-upon-a-diff/foundation/repos';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';

/** Says on stderr why `typed` looks wrong, when it does. `cwd` is the checkout the command runs for. */
export function warnTypedRepo(home: string, typed: string | null, cwd: string): void {
  if (!typed) {
    return;
  }
  const note = typedRepoNote(home, typed, {
    cardRepos: new BacklogStore(home).items().map((item) => item.repo),
    origin: repoOfCheckout(cwd),
  });
  if (note) {
    process.stderr.write(`once-upon: ${note}\n`);
  }
}
