/** An agent's line on a card (its mark, where it stands, its notes path), and the marks the Editors strip shares. */
import { html } from '/assets/preact.mjs';
import { compactAge } from '/assets/protocol/domain/time.ts';
import type { BoardAgent } from '/assets/types.ts';
import { SessionLink, type Api } from '/assets/board/shared.ts';
import { CopyButton } from '/assets/ui/copy-button.ts';

const AGENT_MARK: Record<BoardAgent['state'], string> = {
  running: '●',
  waiting: '?',
  plan: '…',
  fixing: '↻',
  done: '✓',
  failed: '✕',
  stopped: '■',
};

const STATE_NOTE: Partial<Record<BoardAgent['state'], string>> = { plan: 'plan ready' };

/** A `[review]` agent is not asking a question: it has a story up for you. */
export const agentMark = (agent: Pick<BoardAgent, 'state' | 'review'>) =>
  agent.review ? '◉' : AGENT_MARK[agent.state];

export const stateNote = (agent: Pick<BoardAgent, 'state' | 'review'>) =>
  agent.review ? 'ready for review' : (STATE_NOTE[agent.state] ?? agent.state);

/** `byEditor`: say which editor controls it (an agent card's "from" line already does). */
export function Agent(props: { agent: BoardAgent; now: number; api: Api; byEditor: boolean }) {
  const { agent, now, api, byEditor } = props;
  const beat = agent.beat;
  const note =
    beat && agent.state === 'running' ? `${beat.n}/${beat.of} ${beat.step}` : stateNote(agent);
  const percent = beat ? Math.min(100, Math.round((beat.n / Math.max(1, beat.of)) * 100)) : 0;
  const detail = agent.state === 'running' ? beat?.note || agent.task : agent.outcome || agent.task;
  const time = compactAge(agent.ended_at || agent.started_at, now);
  return html`<li class=${`ou-board-agent ou-board-s-${agent.status}`} title=${agent.task || ''}>
    <div class="ou-board-agent-line"><span class="ou-board-mark" aria-hidden="true">${agentMark(agent)}</span> <strong>${agent.name}</strong>${' '}
      <span class="ou-local-muted">${note}${agent.stale && ' (no done line yet)'}${time && ` · ${time}`}</span></div>
    ${byEditor && agent.editor && html`<div class="ou-local-muted ou-board-agent-editor">by <${SessionLink} bridge=${api.bridge} session=${agent.editor.session} canFocus=${agent.editor.can_focus} name=${`Editor · ${agent.editor.label}`} title="The editor that launched this builder: bring its iTerm tab to the front" /></div>`}
    ${beat && agent.state === 'running' && html`<div class="ou-board-bar" aria-hidden="true"><span style=${`width:${percent}%`}></span></div>`}
    ${detail && html`<div class="ou-board-agent-note ou-local-muted" data-agent-detail>${detail}</div>`}
    ${agent.notes && html`<${AgentNotes} path=${agent.notes} api=${api} />`}
  </li>`;
}

/** An agent's notes path, whole and copyable. */
export function AgentNotes(props: { path: string; api: Api }) {
  const { path, api } = props;
  return html`<div class="ou-board-agent-note ou-local-muted" data-agent-notes>notes: <code>${path}</code> <${CopyNotes} path=${path} count=${api.count} /></div>`;
}

/**
 * Copy for an agent's notes path. The page has no way to open a file on this Mac (the bridge serves no local files), so the path is shown whole and copyable.
 */
function CopyNotes(props: { path: string; count: Api['count'] }) {
  return html`<${CopyButton} text=${props.path} class="ou-ui-copy" title="Copy the notes path" attrs=${{ 'data-copy-notes': true }} onCopied=${() => props.count('board.notes.copy')}>Copy</${CopyButton}>`;
}
