/** The chips on a started backlog card: where the work is, from what the bridge linked to it (bridge/src/services/backlog/backlog-links.ts). */
import type { BoardStartedLinks } from '@once-upon-a-diff/protocol/types';

/** What a linked ledger agent is doing, in a few words: its beat while it runs, "tried" when it failed or stopped. */
export function agentChip(agent: NonNullable<BoardStartedLinks['agent']>): string {
  const beat = agent.beat;
  const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
  if (agent.state === 'running') {
    return beat ? `${agent.name} ${beat.n}/${beat.of} ${beat.step}` : `${agent.name} running`;
  }
  if (agent.state === 'waiting') {
    return `${agent.name} waiting on you`;
  }
  if (open) {
    return `${agent.name} ${agent.state === 'plan' ? 'plan ready' : 'fixing'}`;
  }
  return agent.state === 'done' ? `${agent.name} done` : `tried by ${agent.name} (${agent.state})`;
}

/** The chips on an open backlog card a ledger agent names: the agent, and a note when it is back in Backlog. */
export function agentOnlyChips(agent: { links: BoardStartedLinks; tried: boolean }): string[] {
  return agent.links.agent ? [agentChip(agent.links.agent)] : [];
}

/** The chip on a card whose claimed agent has no ledger line yet. */
export const pendingClaimChip = (agent: string): string => `claimed by ${agent}, not started yet`;

/** Plain-text chips, in the order they read: the branch, then what is working it or that it merged. */
export function startedChips(started: {
  branch: string | null;
  on: string | null;
  links?: BoardStartedLinks | null;
}): string[] {
  const chips = [`started on ${started.branch}`];
  const links = started.links;
  if (links?.merged) {
    chips.push('merged');
  }
  const agent = links?.agent;
  if (agent) {
    chips.push(agentChip(agent));
  }
  for (const tree of links?.worktrees ?? []) {
    chips.push(`worktree ${tree.name}`);
  }
  const titles = [
    ...(started.on ? [started.on] : []),
    ...(links?.sessions ?? []).map((session) => session.title),
  ];
  for (const title of [...new Set(titles)]) {
    chips.push(`session ${title}`);
  }
  if (!agent && !(links?.worktrees.length ?? 0) && !titles.length && !links?.merged) {
    chips.push('no session yet');
  }
  return chips;
}
