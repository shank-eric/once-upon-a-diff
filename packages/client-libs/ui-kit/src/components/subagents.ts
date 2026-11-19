/*
 * The light rows of a session's subagents that nobody registered (a quick lookup, a web fetch), as the board shows them under a
 * card or a strip entry: a mark, the description (cut by the sheet, whole in the title) and where it stands. Running ones are
 * always shown; finished ones are folded behind "N finished" until opened, and a count says how many older ones are left out.
 */
import { html, useState } from '/assets/preact.mjs';
import type { BoardSubagents } from '@once-upon-a-diff/contracts/types';
import { compactAge } from '@once-upon-a-diff/terms/time';
import { Disclosure } from './disclosure.ts';

export function SubagentList(props: { subagents: BoardSubagents; now: number }) {
  const { subagents, now } = props;
  const [open, setOpen] = useState(false);
  const running = subagents.rows.filter((row) => row.state === 'running');
  const done = subagents.rows.filter((row) => row.state === 'done');
  const shown = open ? subagents.rows : running;
  const label = `${done.length + subagents.older} finished${subagents.older ? ` (${subagents.older} older not shown)` : ''}`;
  return html`<ul class="ou-ui-subagents" data-subagents>${shown.map((row) => {
    const time = compactAge(row.state === 'done' ? row.ended_at : row.started_at, now);
    return html`<li key=${row.key} class=${`ou-ui-subagent ou-ui-subagent-${row.state}`} title=${row.description}>
        <span class="ou-ui-subagent-mark" aria-hidden="true">${row.state === 'running' ? '●' : '✓'}</span>${' '}
        <span class="ou-ui-subagent-text">${row.description}</span>${' '}
        <span class="ou-ui-subagent-note">${row.state}${time && ` · ${time}`}</span>
      </li>`;
  })}</ul>
    ${done.length + subagents.older > 0 && html`<${Disclosure} open=${open} onToggle=${() => setOpen(!open)} class="ou-ui-subagents-fold" attrs=${{ 'data-subagents-toggle': true }} title="Show or hide the finished subagents">${' '}${label}</${Disclosure}>`}`;
}
