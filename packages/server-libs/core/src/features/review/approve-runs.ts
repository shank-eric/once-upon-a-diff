/**
 * Approve finishes the card's story run. The storyteller parks at `[review]` (the board's "your story review") and is
 * done once you have approved the story, so approving ends every parked storyteller run of the story's card (waiting on
 * the review or a question; one still running is writing, and is left): the runs that name a backlog card on the story's
 * repo and branch, and a run whose card is not in the backlog (an implicit `ic_` card) or has none, on that repo and branch
 * (started with `--branch` or `--pr`). Run by the page's Approve button and `once-upon approve`, after approveStory says it approved.
 * A story's open PR finishes only the storyteller its binding names (finishStoryRunsOnPr, run by the page's Create pull
 * request routes), and only when the PR was opened after that run last spoke (its park at `[review]`): a PR that was
 * already open when a re-told story parked is not what the review waits on.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { readBinding } from '@once-upon-a-diff/state/records/listeners/binding';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { shortSha } from '@once-upon-a-diff/terms/text';

type StoryRef = { repo: string | null; branch: string | null };

/** Finishes the story's open storyteller runs as done; returns how many. One that will not finish is warned, never fatal. */
export function finishStoryRuns(
  home: string,
  story: StoryRef,
  headOid: string,
  warn: (line: string) => void = () => {},
): number {
  return finishParkedStorytellers(
    home,
    story,
    `story approved at ${shortSha(headOid)}`,
    'approve',
    warn,
  );
}

/**
 * The story's PR is open: finishes the storyteller its binding names as done, outcome "PR #N opened", when that run is
 * parked and the PR was opened after the run's last event. Returns how many (0 for an unbound story or a PR with no time).
 */
export function finishStoryRunsOnPr(
  home: string,
  story: StoryRef & { id: string },
  pull: { number: number; created_at?: string },
  warn: (line: string) => void = () => {},
): number {
  const bound = readBinding(home, story.id)?.agent;
  const opened = Date.parse(pull.created_at ?? '');
  if (!bound || Number.isNaN(opened)) {
    return 0;
  }
  const parkedBefore = (run: LedgerAgent) =>
    run.name === bound &&
    opened >= Math.max(run.started?.getTime() ?? 0, run.lastEvent?.getTime() ?? 0);
  return finishParkedStorytellers(
    home,
    story,
    `PR #${pull.number} opened`,
    'pull-request',
    warn,
    parkedBefore,
  );
}

function finishParkedStorytellers(
  home: string,
  story: StoryRef,
  outcome: string,
  finishedBy: string,
  warn: (line: string) => void,
  accept: (run: LedgerAgent) => boolean = () => true,
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
  const items = backlog.listed();
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
      !accept(run) ||
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
        outcome,
        by: finishedBy,
      });
      finished += 1;
    } catch (err) {
      warn(`once-upon: could not finish ${run.name}: ${(err as Error).message}`);
    }
  }
  return finished;
}
