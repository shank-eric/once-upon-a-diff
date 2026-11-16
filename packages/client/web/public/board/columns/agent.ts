/** An agent's line on a card (its mark, where it stands, its notes path), and the marks the Editors strip shares. */
import { html, useState } from '/assets/preact.mjs';
import { compactAge } from '/assets/terms/time.ts';
import type { BoardAgent } from '/assets/types.ts';
import { SessionLink, type Api } from '/assets/board/shared.ts';
import { CopyButton } from '/assets/ui-kit/components/copy-button.ts';
import { Disclosure } from '/assets/ui-kit/components/disclosure.ts';

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
      ${agent.model && html`<span class="ou-local-muted" data-agent-model>${agent.model}</span>${' '}`}
      <span class="ou-local-muted">${note}${agent.stale && ' (no done line yet)'}${time && ` · ${time}`}</span></div>
    ${byEditor && agent.editor && html`<div class="ou-local-muted ou-board-agent-editor">by <${SessionLink} bridge=${api.bridge} session=${agent.editor.session} canFocus=${agent.editor.can_focus} name=${`Editor · ${agent.editor.label}`} title="The editor that launched this builder: bring its iTerm tab to the front" /></div>`}
    ${beat && agent.state === 'running' && html`<div class="ou-board-bar" aria-hidden="true"><span style=${`width:${percent}%`}></span></div>`}
    ${detail && html`<div class="ou-board-agent-note ou-local-muted" data-agent-detail>${detail}</div>`}
    ${agent.notes && html`<${AgentNotes} path=${agent.notes} api=${api} />`}
  </li>`;
}

const isFinished = (agent: BoardAgent) => ['done', 'failed', 'stopped'].includes(agent.state);
const endedAt = (agent: BoardAgent) => Date.parse(agent.ended_at || agent.started_at || '') || 0;

/**
 * A card's runs: the open ones, with the finished ones folded behind "N finished" (collapsed until opened). A card whose
 * runs are all finished shows the latest one, and the fold holds the earlier ones.
 */
export function AgentList(props: {
  agents: BoardAgent[];
  now: number;
  api: Api;
  byEditor: boolean;
}) {
  const { agents, now, api, byEditor } = props;
  const [open, setOpen] = useState(false);
  const finished = agents.filter(isFinished);
  const live = agents.filter((agent) => !isFinished(agent));
  const latest =
    live.length === 0
      ? finished.reduce((best, one) => (endedAt(one) > endedAt(best) ? one : best))
      : null;
  const folded = latest ? finished.length - 1 : finished.length;
  const shown =
    open || folded === 0
      ? agents
      : agents.filter((agent) => (latest ? agent === latest : !isFinished(agent)));
  const label = `${folded} ${latest ? 'earlier finished' : 'finished'}`;
  return html`<ul class="ou-board-agents">${shown.map((agent) => html`<${Agent} key=${agent.key} agent=${agent} now=${now} api=${api} byEditor=${byEditor} />`)}</ul>
    ${folded > 0 && html`<${Disclosure} open=${open} onToggle=${() => setOpen(!open)} class="ou-board-fold ou-local-muted" attrs=${{ 'data-finished-toggle': true }} title="Show or hide the finished runs">${' '}${label}</${Disclosure}>`}`;
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
