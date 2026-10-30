import type { BoardData } from '/assets/types.ts';
import { html } from '/assets/util/html.ts';
import { sizeText } from '/assets/util/worktree-text.ts';
import { worktreeHtml } from '/assets/board/shared.ts';

/** The Worktrees lane: every worktree tied to no card, by repo, the ones Clean up is offered for first. */
export function worktreesHtml(
  trees: NonNullable<BoardData['worktrees']>,
  now: number,
  treesOpen: boolean,
) {
  if (!trees.total && !trees.prunable.length) {
    return trees.scanning
      ? html`<section class="ou-board-idle ou-board-trees-lane" aria-label="Worktrees"><h2 class="ou-board-head">Worktrees <span class="ou-local-muted">scanning…</span></h2></section>`
      : '';
  }
  const summary = [
    `${trees.total} on this Mac`,
    ...(trees.removable ? [`${trees.removable} can be cleaned up`] : []),
    ...(trees.size_kb ? [sizeText(trees.size_kb)] : []),
    ...(trees.scanning ? ['scanning…'] : []),
  ].join(' · ');
  return html`<section class="ou-board-idle ou-board-trees-lane" aria-label="Worktrees">
    <h2 class="ou-board-head">Worktrees <span class="ou-local-muted">${trees.items.length}</span> <span class="ou-local-muted ou-board-head-note">${summary}</span> <button type="button" data-trees-toggle aria-expanded="${String(treesOpen)}">${treesOpen ? 'Hide' : 'Show'}</button></h2>
    ${treesOpen && html`<ul class="ou-board-trees ou-board-trees-grid">${trees.items.map((tree) => worktreeHtml(tree, now, true))}</ul>`}
    ${treesOpen && trees.prunable.length > 0 && html`<div class="ou-local-muted ou-board-tree-keep">The folder is gone for ${trees.prunable.length === 1 ? 'one worktree' : `${trees.prunable.length} worktrees`}; clear ${trees.prunable.length === 1 ? 'it' : 'them'} by hand: ${[...new Set(trees.prunable.map((item) => item.line))].map((line) => html`<code>${line}</code> `)}</div>`}
  </section>`;
}
