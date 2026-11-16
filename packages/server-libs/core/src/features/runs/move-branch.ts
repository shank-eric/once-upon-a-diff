/*
 * A card's branch changed (`backlog branch`): the card is what the board reads, and each open run of the card keeps its own
 * copy, so both move. The card is written first, then the runs: after a crash, running it again finishes the move.
 */
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

export interface BranchMove {
  id: string;
  from: string | null;
  to: string;
  runsMoved: number;
  /** the card and every open run were on `to` already: nothing was written */
  unchanged: boolean;
}

export function moveBranch(
  home: string,
  card: string,
  branch: string | null | undefined,
  who?: string | null,
): BranchMove {
  const store = new BacklogStore(home);
  const item = store.items().find((one) => one.id === card);
  if (!item) {
    throw new Error(`no backlog item ${card}`);
  }
  if (!branch) {
    throw new Error('a new branch is needed: once-upon backlog branch ID NEW-BRANCH');
  }
  if (item.landed_at) {
    throw new Error(`${item.id} is done: its work landed, so it has no branch to move`);
  }
  const registry = new AgentRegistry(home);
  const open = registry.agents().filter((one) => one.card === item.id && runIsOpen(one));
  let runsMoved = 0;
  if (item.branch !== branch) {
    store.start(item.id, { branch, repo: item.repo, by: who });
  }
  for (const run of open) {
    if (run.branch !== branch) {
      registry.setBranch(run.name, branch, { sid: run.sid, run: run.run, by: who });
      runsMoved++;
    }
  }
  return {
    id: item.id,
    from: item.branch,
    to: branch,
    runsMoved,
    unchanged: item.branch === branch && !runsMoved,
  };
}
