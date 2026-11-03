/** The words the board puts on a worktree (bridge/src/services/worktrees/worktrees.ts has the facts): its chips and Clean up's confirm. */
import type { BoardWorktree } from '@once-upon-a-diff/protocol/types';

/** "1.2G", "340M", "12K" for a size in kilobytes. */
export function sizeText(kilobytes: number): string {
  if (kilobytes >= 1048576) {
    return `${(kilobytes / 1048576).toFixed(1)}G`;
  }
  if (kilobytes >= 1024) {
    return `${Math.round(kilobytes / 1024)}M`;
  }
  return `${kilobytes}K`;
}

const VERDICT: Record<BoardWorktree['verdict'], string> = {
  merged: 'merged',
  superseded: 'superseded',
  pr_merged: 'PR merged',
  pushed: 'on origin, nothing local',
  new: 'no commits yet',
  unmerged: 'not merged',
  unknown: 'merge state unknown',
};

/** Plain-text chips in reading order: age (given), clean or dirty, merged or not, unpushed, PR, size, who is in it. */
export function worktreeChips(tree: BoardWorktree, age: string): string[] {
  const chips: string[] = [];
  if (age) {
    chips.push(`last commit ${age}`);
  }
  if (tree.state === 'dirty') {
    chips.push(`dirty (${tree.modified}M ${tree.untracked}?)`);
  } else {
    chips.push(tree.state === 'clean' ? 'clean' : 'clean or dirty not known');
  }
  chips.push(VERDICT[tree.verdict]);
  if (tree.unpushed) {
    chips.push(`${tree.unpushed} unpushed`);
  }
  if (tree.pr.state === 'open' || tree.pr.state === 'merged') {
    chips.push(`PR #${tree.pr.number} ${tree.pr.state}`);
  }
  if (tree.size_kb !== null) {
    chips.push(sizeText(tree.size_kb));
  }
  if (tree.locked) {
    chips.push('locked');
  }
  if (tree.ignored.length) {
    chips.push(
      `${tree.ignored.length} ignored ${tree.ignored.length === 1 ? 'file' : 'files'} to lose`,
    );
  }
  if (tree.attention) {
    chips.push('needs attention');
  }
  for (const who of tree.in_use) {
    chips.push(`in use by ${who.label}`);
  }
  if (tree.stale) {
    chips.push('scanning');
  }
  return chips;
}

/** What the page asks before it cleans a worktree up: what goes, what stays, and for a superseded one, that it is only superseded. */
export function cleanupConfirm(tree: BoardWorktree): string {
  const lines = [`Remove the folder ${tree.path}?`];
  if (tree.verdict === 'superseded') {
    lines.push(
      '',
      'SUPERSEDED, not merged: this branch is not in live or main. Each of its commits has a copy there (the same patch, or the same subject and file counts).',
      'That is what makes it safe to remove, but the bridge cannot be sure the copies are the same work.',
    );
  }
  let branchLine = 'It is on a detached HEAD, so there is no branch.';
  if (tree.deletes_branch) {
    branchLine = `The branch ${tree.branch} is merged, so it is deleted too (git branch -d).`;
  } else if (tree.branch) {
    branchLine = `The branch ${tree.branch} is kept.`;
  }
  if (tree.ignored.length) {
    lines.push(
      '',
      'IGNORED FILES that git does not track will be deleted with the folder (they cannot be rebuilt from the repo):',
      ...tree.ignored.map((name) => `  ${name}`),
    );
  }
  lines.push(
    '',
    branchLine,
    'It has no uncommitted changes to tracked or untracked files, and git is told not to force anything.',
  );
  return lines.join('\n');
}
