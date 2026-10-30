/** The chips on a started backlog card: where the work is, from what the bridge linked to it (bridge/src/services/backlog/backlog-links.ts). */
import type { BoardStartedLinks } from '../types.ts';

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
    const beat = agent.beat;
    const open = agent.state === 'running' || agent.state === 'plan' || agent.state === 'fixing';
    if (agent.state === 'running') {
      chips.push(
        beat ? `${agent.name} ${beat.n}/${beat.of} ${beat.step}` : `${agent.name} running`,
      );
    } else if (agent.state === 'waiting') {
      chips.push(`${agent.name} waiting on you`);
    } else if (open) {
      chips.push(`${agent.name} ${agent.state === 'plan' ? 'plan ready' : 'fixing'}`);
    } else {
      chips.push(`${agent.name} ${agent.state}`);
    }
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
