/**
 * Approve finishes the card's story run. The storyteller parks at `[review]` (the board's "your story review") and is
 * done once you have approved the story, so approving ends every parked storyteller run of the story's card (waiting on
 * the review or a question; one still running is writing, and is left): the runs that name a backlog card on the story's
 * repo and branch, and a run whose card is not in the backlog (an implicit `ic_` card) or has none, on that repo and branch
 * (started with `--branch` or `--pr`). Run by the page's Approve button and `once-upon approve`, after approveStory says it approved.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { shortSha } from '@once-upon-a-diff/terms/text';

/** Finishes the story's open storyteller runs as done; returns how many. One that will not finish is warned, never fatal. */
export function finishStoryRuns(
  home: string,
  story: { repo: string | null; branch: string | null },
  headOid: string,
  warn: (line: string) => void = () => {},
): number {
  if (!story.branch) {
    return 0;
  }
  const backlog = new BacklogStore(home);
  const { board } = readSettings(home);
  const registry = new AgentRegistry(
    home,
    { ledger: board.ledgerFile, progress: board.progressFile },
    cardLookup(backlog),
  );
  const onStory = (repo: string | null, branch: string | null) =>
    branch === story.branch && (story.repo ? sameRepo(repo, story.repo) : !repo);
  const items = backlog.items();
  const known = new Set(items.map((item) => item.id));
  const cards = new Set(
    items
      .filter((item) => item.state !== 'dropped' && onStory(item.repo, item.branch))
      .map((item) => item.id),
  );
  let finished = 0;
  for (const run of registry.agents()) {
    if (
      run.kind !== 'storyteller' ||
      run.state !== 'waiting' ||
      !(run.card && known.has(run.card)
        ? cards.has(run.card)
        : onStory(run.repo ?? null, run.branch ?? null))
    ) {
      continue;
    }
    try {
      registry.finish(run.name, {
        sid: run.sid,
        run: run.run,
        state: 'done',
        outcome: `story approved at ${shortSha(headOid)}`,
        by: 'approve',
      });
      finished += 1;
    } catch (err) {
      warn(`once-upon: could not finish ${run.name}: ${(err as Error).message}`);
    }
  }
  return finished;
}
