import { compactAge } from '/assets/util/time.ts';
import { html, type HtmlValue } from '/assets/util/html.ts';
import type { BoardCard, BoardWorktree } from '/assets/types.ts';
import { worktreeChips } from '/assets/util/worktree-text.ts';

/** "5m ago", or "just now" for the first minute (compactAge says "now"). */
export function ago(iso: string | null, now: number): string {
  const time = compactAge(iso, now);
  return time === 'now' ? 'just now' : time && `${time} ago`;
}

/** The warning class for a percentage: yellow from 70, red from 90. */
function levelOf(value: number) {
  if (value >= 90) {
    return ' ou-board-usage-high';
  }
  return value >= 70 ? ' ou-board-usage-warn' : '';
}

/** A label, a thin bar filled to a percentage and the number, yellow from 70% and red from 90% like the status line. */
export function meterHtml(label: string, percent: number, title: string, extra: HtmlValue = '') {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<span class="ou-board-meter${levelOf(percent)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped}" aria-label="${label}" title="${title}">
    <span class="ou-board-meter-label">${label}</span>
    <span class="ou-board-meter-bar" aria-hidden="true"><span style="width:${clamped}%"></span></span>
    <span class="ou-board-meter-num">${clamped}%</span>${extra}
  </span>`;
}

/** A session's name as a link that brings its iTerm tab forward when the tab is known, else plain text. */
export function sessionLink(
  session: string | null,
  canFocus: boolean,
  name: string,
  title: string,
) {
  return canFocus && session
    ? html`<button type="button" class="ou-board-from" data-focus="${session}" title="${title}">${name}</button>`
    : name;
}

/** One worktree: its name, where, the chips, why it is kept, and Clean up when the bridge offers it. */
export function worktreeHtml(tree: BoardWorktree, now: number, lane = false) {
  const chips = worktreeChips(tree, compactAge(tree.last_commit_at, now));
  const where = [lane && tree.lane, tree.branch ?? 'detached HEAD'].filter(Boolean).join(' · ');
  return html`<li class="ou-board-tree${tree.removable ? ' ou-board-tree-removable' : ''}" data-worktree="${tree.path}">
    <div class="ou-board-tree-name" title="${tree.path}"><code>${tree.name}</code> <span class="ou-local-muted">${where}</span></div>
    <div class="ou-board-chips">${chips.map((chip) => html`<span class="ou-board-chip">${chip}</span>`)}</div>
    ${!tree.removable && tree.keep.length > 0 && html`<div class="ou-local-muted ou-board-tree-keep">kept: ${tree.keep.join(', ')}</div>`}
    ${tree.removable && html`<div class="ou-board-actions"><button type="button" data-worktree-clean="${tree.path}" title="${tree.deletes_branch ? 'Removes the folder and deletes the merged branch' : 'Removes the folder and keeps the branch'}">Clean up</button></div>`}
  </li>`;
}

/** A card's worktrees, under its own chips. */
export const cardTrees = (card: BoardCard, now: number) =>
  card.worktrees?.length
    ? html`<ul class="ou-board-trees">${card.worktrees.map((tree) => worktreeHtml(tree, now))}</ul>`
    : '';

/** "3h", "5m" since an ISO time, for the Listeners lane. */
export const since = (iso: string | null, now: number) => (iso ? compactAge(iso, now) : '');
