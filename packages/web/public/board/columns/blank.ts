/** The Blank strip: sessions that have had no prompt yet, one chip per place. */
import { html } from '/assets/preact.mjs';
import { openMenu } from '/assets/ui/menu.ts';
import type { BoardBlankSession, BoardData } from '/assets/types.ts';
import { compactAge } from '/assets/protocol/domain/time.ts';
import { FocusButton, useFocus, type Api } from '/assets/board/shared.ts';

/** One place's chip in the Blank strip: a session's tab to the front, or for several in one place a menu of them. */
function BlankChip(props: { group: { name: string; sessions: BoardBlankSession[] }; api: Api }) {
  const { group, api } = props;
  const { focus } = useFocus(api.bridge);
  const tabs = group.sessions.filter((session) => session.can_focus);
  const many = group.sessions.length > 1;
  const label = many ? `${group.name} ×${group.sessions.length}` : group.name;
  if (!tabs.length) {
    return html`<span class="ou-ui-chip ou-board-blank-chip" title=${`No iTerm tab is known for ${many ? 'these sessions' : 'this session'}`}>${label}</span>`;
  }
  if (!many) {
    return html`<${FocusButton} bridge=${api.bridge} session=${tabs[0].id} class="ou-ui-chip ou-board-blank-chip" title="Bring this blank session's iTerm tab to the front">${label}</${FocusButton}>`;
  }
  const choose = (event: MouseEvent) =>
    openMenu(
      event.currentTarget as HTMLElement,
      tabs.map((one) => ({
        value: one.id,
        label: one.title,
        detail: `blank${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${group.name}`,
      })),
      (id) => void focus(id),
      { label: `Blank sessions in ${group.name}` },
    );
  return html`<button type="button" class="ou-ui-chip ou-board-blank-chip" data-blank-group=${group.name} aria-haspopup="menu" aria-expanded="false" onClick=${choose} title=${`Choose a blank session in ${group.name}`}>${label}</button>`;
}

/** The Blank strip at the bottom of the Idle lane: sessions that have had no prompt yet, one chip per place. */
export function Blank(props: { blank: BoardData['blank']; count: number; api: Api }) {
  const { blank, count, api } = props;
  return html`<div class="ou-board-blank" role="group" aria-label="Blank sessions"><strong>Blank</strong> <span class="ou-local-muted">${count}</span>${blank.map((group) => html`<${BlankChip} key=${group.name} group=${group} api=${api} />`)}<span class="ou-local-muted">no prompt yet</span></div>`;
}
