import type { BoardAssign, BoardCard, BoardData } from '/assets/types.ts';
import { obviousChoice } from '/assets/util/choice.ts';
import { html } from '/assets/util/html.ts';
import { ago, cardTrees } from '/assets/board/shared.ts';
import { startedChips } from '/assets/util/started-chips.ts';

/** A Backlog card: what was kept, who kept it and when, and the line that starts it (to paste into a session). */
/** The ids of the Backlog cards in a card's lane, in the order the board shows them. */
export function backlogLane(card: BoardCard, board: BoardData | null): string[] {
  const lane = board?.lanes.find((one) => one.name === card.lane);
  return (lane?.cards ?? [])
    .filter((one) => one.column === 'backlog' && one.backlog)
    .map((one) => (one.backlog as { id: string }).id);
}

/** The session Assign uses without asking: the only one, the only blank one, else (no blank ones) the clearly freshest. */
export function assignObvious(candidates: BoardAssign['candidates']) {
  const blanks = candidates.filter((one) => one.blank);
  if (blanks.length) {
    return blanks.length === 1 ? blanks[0] : null;
  }
  return obviousChoice(candidates);
}

/** Assign: types the item's start line into an idle session in its repo. Several with no obvious one: a menu. */
function assignButtonHtml(id: string, candidates: BoardAssign['candidates'], again: boolean) {
  const off = candidates.length ? '' : html` disabled`;
  const choosing =
    candidates.length > 1 && !assignObvious(candidates)
      ? html` aria-haspopup="menu" aria-expanded="false"`
      : '';
  let title = 'No idle session with an iTerm tab is free for this item';
  if (candidates.length) {
    title = choosing
      ? 'Choose an idle session to hand this item to'
      : 'Types the start line into an idle session';
  }
  return html`<button type="button" data-backlog-assign="${id}"${off}${choosing} title="${title}">${again ? 'Send again' : 'Assign'}${choosing && ' ▾'}</button>`;
}

export function backlogHtml(card: BoardCard, now: number) {
  const item = card.backlog;
  const meta = [
    card.repo && card.repo.split('/')[1],
    card.branch,
    ago(card.since, now) && `added ${ago(card.since, now)}`,
    item && item.added_by !== 'board' && item.added_by !== 'you' && `by ${item.added_by}`,
  ].filter(Boolean);
  return html`<li class="ou-board-card ou-board-c-backlog" data-card="${card.id}" data-backlog-card="${item?.id ?? ''}" data-lane="${card.lane}" draggable="${String(!item?.started)}" tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
    <div class="ou-board-title" title="${card.title}">${card.title}</div>
    <div class="ou-local-muted ou-board-meta">${meta.join(' · ')}</div>
    ${card.detail && html`<div class="ou-board-detail ou-board-note" title="${card.detail}">${card.detail}</div>`}
    ${item?.started && html`<div class="ou-board-chips">${startedChips(item.started).map((chip) => html`<span class="ou-board-chip">${chip}</span>`)}</div>`}
    ${item?.assigned && !item.started && html`<div class="ou-board-chips"><span class="ou-board-chip">assigned to ${item.assigned.session_title ?? 'a session that has ended'} ${ago(item.assigned.at, now)}, not started yet</span></div>`}
    ${item && !item.started && html`<div class="ou-board-startline"><code>${item.start_line}</code></div>`}
    ${cardTrees(card, now)}
    <div class="ou-board-actions">
      ${item?.assign && !item.started && assignButtonHtml(item.id, item.assign.candidates, !!item.assigned)}
      ${item && !item.started && html`<button type="button" data-backlog-copy="${item.start_line}" title="Copy the line that starts it">Copy start line</button>`}
      ${item && html`<button type="button" data-backlog-drop="${item.id}" title="Drop it from the backlog (the line stays in the file)">Drop</button>`}
    </div>
  </li>`;
}

/** The Backlog column's Add panel: a title, the repo the item is for (a menu in the page's style) and a note. */
export function addFormHtml(addRepo: string) {
  const repo = addRepo ? addRepo.split('/')[1] : 'none';
  return html`<form class="ou-board-add" data-backlog-add>
    <input type="text" name="title" data-backlog-title placeholder="Keep something for later" maxlength="200" required aria-label="Backlog item title">
    <button type="button" class="ou-board-add-repo" data-backlog-repo aria-haspopup="menu" title="The repo the new item is for: its card goes in that repo's lane">Repo: ${repo} ▾</button>
    <input type="text" name="note" placeholder="Note (optional)" maxlength="1000" aria-label="Note">
    <div class="ou-board-add-actions"><button type="submit">Add</button> <button type="button" data-backlog-cancel>Cancel</button></div>
  </form>`;
}

/** Where `dragged` goes in its lane's ids if put before (or after) `target`: before the item now there, or the bottom. */
export function placeAmong(
  ids: string[],
  dragged: string,
  target: string,
  after: boolean,
): { before: string } | { edge: 'top' | 'bottom' } | null {
  const rest = ids.filter((one) => one !== dragged);
  const slot = rest.indexOf(target) + (after ? 1 : 0);
  if (rest.indexOf(target) < 0 || slot === ids.indexOf(dragged)) {
    return null;
  }
  return slot >= rest.length ? { edge: 'bottom' } : { before: rest[slot] };
}
