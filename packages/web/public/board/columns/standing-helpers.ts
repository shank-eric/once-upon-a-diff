/** The standing helpers' row, under the Listeners. */
import { html } from '/assets/preact.mjs';
import type { BoardHelper } from '/assets/types.ts';
import { SessionLink, type Api } from '/assets/board/shared.ts';
import { since } from '/assets/domain/time.ts';

/** The standing helpers' row, under the Listeners: each helper, the session you reach it through, and when it was last asked. */
export function Helpers(props: { helpers: BoardHelper[]; now: number; api: Api }) {
  const { helpers, now, api } = props;
  if (!helpers.length) {
    return null;
  }
  return html`<section class="ou-board-listeners" aria-label="Standing helpers"><h2 class="ou-board-head">Helpers <span class="ou-local-muted">${helpers.length}</span></h2><ul>${helpers.map(
    (one) =>
      html`<li key=${`${one.session}:${one.name}`} class="ou-board-listener" data-helper=${one.name}><strong>${one.name}</strong> <span class="ou-board-voice-status">${one.state === 'handling' ? 'Handling' : 'Standing by'}</span> <span class="ou-local-muted"><${SessionLink} bridge=${api.bridge} session=${one.session} canFocus=${one.can_focus} name=${one.title || one.session.slice(0, 8)} title="Bring the session that launched it to the front" /> · last request ${since(one.last_request_at, now)} ago</span></li>`,
  )}</ul></section>`;
}
