/*
 * The Worktrees lane, drawn by Preact (ADR-14): every worktree tied to no card, by repo, the ones Clean up is offered for
 * first. The lane's fold is the page root's (remembered), handed in with a way to flip it.
 */
import { html } from '/assets/preact.mjs';
import type { BoardData } from '/assets/types.ts';
import { sizeText } from '/assets/board/worktree-text.ts';
import { Worktree, type Api } from '/assets/board/shared.ts';

export function Worktrees(props: {
  trees: NonNullable<BoardData['worktrees']>;
  now: number;
  open: boolean;
  onToggle: () => void;
  api: Api;
}) {
  const { trees, now, open, onToggle, api } = props;
  if (!trees.total && !trees.prunable.length) {
    return trees.scanning
      ? html`<section class="ou-board-idle ou-board-trees-lane" aria-label="Worktrees"><h2 class="ou-board-head">Worktrees <span class="ou-local-muted">scanning…</span></h2></section>`
      : null;
  }
  const summary = [
    ...(trees.removable ? [`${trees.removable} can be cleaned up`] : []),
    ...(trees.on_cards ? [`${trees.on_cards} more on cards`] : []),
    ...(trees.size_kb ? [sizeText(trees.size_kb)] : []),
    ...(trees.scanning ? ['scanning…'] : []),
  ].join(' · ');
  const gone = trees.prunable.length;
  return html`<section class="ou-board-idle ou-board-trees-lane" aria-label="Worktrees">
    <h2 class="ou-board-head">Worktrees <span class="ou-local-muted">${trees.items.length}</span> <span class="ou-local-muted ou-board-head-note">${summary}</span> <button type="button" data-trees-toggle aria-expanded=${String(open)} onClick=${onToggle}>${open ? 'Hide' : 'Show'}</button></h2>
    ${open && html`<ul class="ou-board-trees ou-board-trees-grid">${trees.items.map((tree) => html`<${Worktree} key=${tree.path} tree=${tree} now=${now} api=${api} lane />`)}</ul>`}
    ${open && gone > 0 && html`<div class="ou-local-muted ou-board-tree-keep">The folder is gone for ${gone === 1 ? 'one worktree' : `${gone} worktrees`}; clear ${gone === 1 ? 'it' : 'them'} by hand: ${[...new Set(trees.prunable.map((item) => item.line))].map((line) => html`<code key=${line}>${line}</code>${' '}`)}</div>`}
  </section>`;
}
