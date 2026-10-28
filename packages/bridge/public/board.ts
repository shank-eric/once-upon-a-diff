/*
 * The agent board page: the Claude Code sessions running now, one card each, in a column for where they stand
 * (working, agent checks, waiting, done; idle and error when there are any, and sessions with no prompt yet as a Blank strip) and a lane for their repo, with the background agents
 * inside their parent's card or, when the ledger gave them a lane, on a card in that lane. The data is
 * GET /api/board (src/board/board.ts), polled every few seconds. The page's key (the link's #key=, which
 * `once-upon board` prints) reaches the board's routes and nothing else.
 */
import { authHeader, startAuth } from '/assets/local/auth.ts';
import { notConnectedHtml } from '/assets/local/not-connected.ts';
import { openMenu } from '/assets/local/menu.ts';
import { freshestFirst, obviousChoice } from '/assets/util/choice.ts';
import { html, type HtmlValue } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { plural } from '/assets/util/text.ts';
import type {
  BoardAgent,
  BoardBlankSession,
  BoardCard,
  BoardColumn,
  BoardData,
  BoardLimit,
  BoardListenerRepo,
  BoardSession,
  BoardUsage,
  BoardVoice,
  BoardVoiceLine,
  PrInfo,
} from '/assets/types.ts';

const POLL_MS = 3000;
const app = document.getElementById('ou-board-app') as HTMLElement;
const KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board/inbox-link');

/**
 * The columns in the order the work moves through them, from Backlog (kept for later) to Done, in two groups: what is still on this Mac and what is on GitHub.
 * Error appears only when a card is in it; idle cards are a lane along the bottom.
 */
const COLUMNS: { id: BoardColumn; label: string; group: 'local' | 'github'; always: boolean }[] = [
  { id: 'backlog', label: 'Backlog', group: 'local', always: true },
  { id: 'working', label: 'Working', group: 'local', always: true },
  { id: 'checks', label: 'Agent checks', group: 'local', always: false },
  { id: 'waiting', label: 'Waiting', group: 'local', always: true },
  { id: 'ready', label: 'Ready for your review', group: 'local', always: true },
  { id: 'error', label: 'Error', group: 'local', always: false },
  { id: 'pr_open', label: 'PR open', group: 'github', always: true },
  { id: 'back', label: 'Back to you', group: 'github', always: true },
  { id: 'done', label: 'Done', group: 'github', always: true },
];
const GROUPS = [
  { id: 'local', label: 'On this Mac' },
  { id: 'github', label: 'On GitHub' },
] as const;

let last = '';
let board: BoardData | null = null;

/** The Idle lane's state is remembered; localStorage can be missing or blocked, so every use is wrapped. */
const IDLE_KEY = 'ou-board-idle-open';
function readIdleOpen(): boolean {
  try {
    return localStorage.getItem(IDLE_KEY) !== 'false';
  } catch {
    return true;
  }
}
let idleOpen = readIdleOpen();

/**
 * A repo heading's fold in a column is remembered, as "<column>/<heading>"; localStorage can be missing or blocked, so every
 * use is wrapped.
 */
const COLLAPSED_KEY = 'ou-board-collapsed-lanes';
function readCollapsed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
const collapsed = readCollapsed();

/** Others' PRs waiting on their author can be hidden from PR open; remembered, and wrapped like the rest. */
const ON_AUTHOR_KEY = 'ou-board-hide-on-author';
function readHideOnAuthor(): boolean {
  try {
    return localStorage.getItem(ON_AUTHOR_KEY) === 'true';
  } catch {
    return false;
  }
}
let hideOnAuthor = readHideOnAuthor();
/** Someone else's PR with nothing on you and no session of yours on it: the ball is in its author's court. */
const onAuthor = (card: BoardCard) =>
  card.column === 'pr_open' && !!card.pr && !card.pr.mine && !card.sessions.length;
const shownCard = (card: BoardCard) => !(hideOnAuthor && onAuthor(card));

/** The Add panel is closed until asked for (+ Add), and closes after an add or Escape. */
let addOpen = false;
/** The board's repo filter: a lane name, '' for All. Remembered; a lane that is gone shows everything. */
const FILTER_KEY = 'ou-board-filter';
function readFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) || '';
  } catch {
    return '';
  }
}
let laneFilter = readFilter();
/** The repo the Add panel's next item is for ('' for none). It stays between adds. */
let addRepo = '';
/** The Backlog card being dragged, and the card to put the keyboard back on after an Alt+arrow move. */
let dragId = '';
let focusAfter = '';

/** An add is in flight: a second submit waits for it. */
let adding = false;

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  await authed;
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      ...authHeader(KEY),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: T & { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(json.error || `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return json;
}

/** "5m", "3h", "2d" since an ISO time, or '' when there isn't one. */
function age(iso: string | null, now: number): string {
  const elapsed = iso ? now - new Date(iso).getTime() : NaN;
  if (Number.isNaN(elapsed)) {
    return '';
  }
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return minutes < 2880 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

/** "5m ago", or "just now" for the first minute (age() says "now"). */
function ago(iso: string | null, now: number): string {
  const time = age(iso, now);
  return time === 'now' ? 'just now' : time && `${time} ago`;
}

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

/** What an agent at a gate is doing, as a chip: "plan check", "agent review · review-x", "fixing 5 findings". */
function gateText(agent: BoardAgent): string {
  const gate = agent.gate;
  if (gate?.kind === 'plan') {
    return 'plan check';
  }
  if (gate?.kind === 'fixing') {
    return gate.findings === null ? 'fixing' : `fixing ${plural(gate.findings, 'finding')}`;
  }
  return `agent review · ${agent.name}`;
}

function agentHtml(agent: BoardAgent, now: number) {
  const beat = agent.beat;
  const note =
    beat && agent.state === 'running'
      ? `${beat.n}/${beat.of} ${beat.step}`
      : (STATE_NOTE[agent.state] ?? agent.state);
  const percent = beat ? Math.min(100, Math.round((beat.n / Math.max(1, beat.of)) * 100)) : 0;
  const detail = agent.state === 'running' ? beat?.note || agent.task : agent.outcome || agent.task;
  const time = age(agent.ended_at || agent.started_at, now);
  return html`<li class="ou-board-agent ou-board-s-${agent.status}" title="${agent.task || ''}">
    <div class="ou-board-agent-line"><span class="ou-board-mark" aria-hidden="true">${AGENT_MARK[agent.state]}</span> <strong>${agent.name}</strong>
      <span class="ou-local-muted">${note}${agent.stale && ' (no done line yet)'}${time && ` · ${time}`}</span></div>
    ${beat && agent.state === 'running' && html`<div class="ou-board-bar" aria-hidden="true"><span style="width:${percent}%"></span></div>`}
    ${detail && html`<div class="ou-board-agent-note ou-local-muted">${detail}</div>`}
  </li>`;
}

/** What a card's review badge counts: "1 PR story". */
const inboxTitle = (inbox: { stories: number }) => plural(inbox.stories, 'PR story');

const BUILDING_TEXT = {
  build: 'building the story',
  update: 'updating the story',
  rebuild: 'rebuilding the story',
  fix: 'fixing the code',
} as const;

/** Chips are neutral in colour; what they mean is said by a mark in front. */
const CHIP_MARK = { ok: '✓ ', plain: '', warn: '! ', bad: '! ' } as const;

/** The PR's facts as small labels: the one line on merging first, then approvals against required, changes requested, checks, open threads. */
function prChips(pr: PrInfo) {
  const chips: { text: string; tone: 'ok' | 'bad' | 'warn' | 'plain' }[] = [];
  if (pr.state === 'merged') {
    return chips;
  }
  if (pr.merge) {
    chips.push({ text: pr.merge.text, tone: pr.merge.tone });
  }
  const said = (word: string) => !!pr.merge && pr.merge.text.includes(word);
  if (pr.draft && !said('draft')) {
    chips.push({ text: 'Draft', tone: 'plain' });
  }
  if (pr.required !== null || pr.approvals > 0) {
    const text =
      pr.required !== null ? `${pr.approvals}/${pr.required} approved` : `${pr.approvals} approved`;
    chips.push({ text, tone: pr.required !== null && pr.approvals < pr.required ? 'warn' : 'ok' });
  }
  if (pr.review === 'changes_requested' && !said('changes')) {
    chips.push({ text: 'Changes requested', tone: 'bad' });
  }
  const checks = {
    success: ['Checks passing', 'ok'],
    failure: ['Checks failing', 'bad'],
    pending: ['Checks running', 'warn'],
  } as const;
  if (pr.checks && !said('checks')) {
    chips.push({ text: checks[pr.checks][0], tone: checks[pr.checks][1] });
  }
  if (pr.unresolved > 0 && !said('threads')) {
    chips.push({ text: plural(pr.unresolved, 'open thread'), tone: 'warn' });
  }
  return chips;
}

/**
 * How long a session keeps its context cached after its turn ends: the prompt cache's lifetime, an hour on these
 * sessions. Past it, picking the session up re-reads its whole context.
 */
const WARM_MS = 60 * 60 * 1000;

/** Whether a resting card's newest session went quiet within WARM_MS (by Claude Code's registry, not the tab's status). */
function isWarm(card: BoardCard, now: number): boolean {
  const rested = card.sessions
    .map((session) => (session.rested_at ? Date.parse(session.rested_at) : NaN))
    .filter((time) => !Number.isNaN(time));
  return rested.length > 0 && now - Math.max(...rested) < WARM_MS;
}

/** "ctx 45%", yellow from 70% and red from 90% like the status line, or '' when the status line hasn't said. */
function contextHtml(context: number | null | undefined) {
  if (typeof context !== 'number') {
    return '';
  }
  return html` <span class="ou-board-usage${levelOf(context)}" title="How full the session's context window is">ctx ${context}%</span>`;
}

/** The warning class for a percentage: yellow from 70, red from 90. */
function levelOf(value: number) {
  if (value >= 90) {
    return ' ou-board-usage-high';
  }
  return value >= 70 ? ' ou-board-usage-warn' : '';
}

/** The usage strip under the header: the 5-hour and weekly limits with when they reset, as the status line has them. */
function usageHtml(usage: BoardUsage | null, now: number) {
  if (!usage) {
    return '';
  }
  const limit = (label: string, value: BoardLimit | null, options: Intl.DateTimeFormatOptions) =>
    value &&
    html`<span class="ou-board-usage${levelOf(value.percent)}">${label} ${value.percent}%${value.resets_at && html` <span class="ou-local-muted">resets ${new Date(value.resets_at).toLocaleString([], options)}</span>`}</span>`;
  const seen = age(usage.at, now);
  return html`<p class="ou-board-usage-strip" aria-label="Usage">
    ${limit('5h', usage.five_hour, { hour: 'numeric', minute: '2-digit' })}
    ${limit('week', usage.seven_day, { weekday: 'short', hour: 'numeric' })}
    ${seen && html`<span class="ou-local-muted">from a status line ${seen} ago</span>`}
  </p>`;
}

function sessionHtml(session: BoardSession, now: number) {
  const time = age(session.since, now);
  return html`<li class="ou-board-session ou-board-s-${session.status}" title="${session.cwd}">
    <span class="ou-board-mark" aria-hidden="true">●</span> <strong>${session.title}</strong> <span class="ou-local-muted">${session.status}${time && ` · ${time}`}</span>${contextHtml(session.context)}
    ${session.detail && html`<div class="ou-board-agent-note ou-local-muted">${session.detail}</div>`}
  </li>`;
}

/** An agent card's "from <parent session>": a link that brings the parent's iTerm tab forward when it can. */
function fromHtml(card: BoardCard) {
  if (!card.parent) {
    return 'its session has ended';
  }
  return card.can_focus && card.focus_session
    ? html`from <button type="button" class="ou-board-from" data-focus="${card.focus_session}" title="Bring the parent session's iTerm tab to the front">${card.parent}</button>`
    : html`from ${card.parent}`;
}

/** A session's name as a link that brings its iTerm tab forward when the tab is known, else plain text. */
function sessionLink(session: string | null, canFocus: boolean, name: string, title: string) {
  return canFocus && session
    ? html`<button type="button" class="ou-board-from" data-focus="${session}" title="${title}">${name}</button>`
    : name;
}

/** "listening: <session>" on a story's card: its own listener, linked to the session when its tab is known. */
function listeningHtml(listening: NonNullable<BoardCard['listening']>) {
  const who = sessionLink(
    listening.session,
    listening.can_focus,
    listening.title || listening.consumer,
    "Bring the listening session's iTerm tab to the front",
  );
  return html`<div class="ou-local-muted ou-board-listening">listening: ${who}</div>`;
}

/** Build story: types the skill's command into an idle session of the card (the bridge picks it and says why when none is). */
function buildHtml(card: BoardCard) {
  const build = card.build as NonNullable<BoardCard['build']>;
  const label = build.blocked ? `Build story (${build.blocked})` : 'Build story';
  const title = build.blocked || `Types ${build.prompt} into the session`;
  const off = build.blocked ? html` disabled` : '';
  return html`<button type="button" class="ou-board-build" data-build="${build.session}" data-prompt="${build.prompt}"${off} title="${title}">${label}</button>`;
}

/** A Backlog card: what was kept, who kept it and when, and the line that starts it (to paste into a session). */
/** The ids of the Backlog cards in a card's lane, in the order the board shows them. */
function backlogLane(card: BoardCard): string[] {
  const lane = board?.lanes.find((one) => one.name === card.lane);
  return (lane?.cards ?? [])
    .filter((one) => one.column === 'backlog' && one.backlog)
    .map((one) => (one.backlog as { id: string }).id);
}

function backlogHtml(card: BoardCard, now: number) {
  const item = card.backlog;
  const meta = [
    card.repo && card.repo.split('/')[1],
    card.branch,
    ago(card.since, now) && `added ${ago(card.since, now)}`,
    item && item.added_by !== 'board' && item.added_by !== 'you' && `by ${item.added_by}`,
  ].filter(Boolean);
  return html`<li class="ou-board-card ou-board-c-backlog" data-card="${card.id}" data-backlog-card="${item?.id ?? ''}" data-lane="${card.lane}" draggable="true" tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
    <div class="ou-board-title" title="${card.title}">${card.title}</div>
    <div class="ou-local-muted ou-board-meta">${meta.join(' · ')}</div>
    ${card.detail && html`<div class="ou-board-detail ou-board-note" title="${card.detail}">${card.detail}</div>`}
    ${item?.started && html`<div class="ou-board-chips"><span class="ou-board-chip">started on ${item.started.branch}, ${item.started.on ? `in ${item.started.on}` : 'no session on it yet'}</span></div>`}
    ${item && !item.started && html`<div class="ou-board-startline"><code>${item.start_line}</code></div>`}
    <div class="ou-board-actions">
      ${item && !item.started && html`<button type="button" data-backlog-copy="${item.start_line}" title="Copy the line that starts it">Copy start line</button>`}
      ${item && html`<button type="button" data-backlog-drop="${item.id}" title="Drop it from the backlog (the line stays in the file)">Drop</button>`}
    </div>
  </li>`;
}

function cardHtml(card: BoardCard, now: number) {
  if (card.kind === 'backlog') {
    return backlogHtml(card, now);
  }
  const classes = `${card.can_focus ? ' ou-board-clickable' : ''}`;
  const pr = card.pr;
  const time = age(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? card.repo.split('/')[1] : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink =
    pr && html`<a href="${pr.url}" target="_blank" rel="noopener">PR #${pr.number}</a>`;
  const merged = pr?.state === 'merged' && time ? `merged ${ago(card.since, now)}` : '';
  const chips = pr ? prChips(pr) : [];
  if (card.story?.approved_at && card.column === 'done') {
    chips.push({ text: 'Approved, ready to ship', tone: 'ok' });
  }
  const gates = card.agents.filter((agent) => agent.gate).map(gateText);
  // Open story: on a card ready for review, or an approved local story in Done (a local story is never in Back to you)
  const approved = !!card.story?.approved_at && card.column === 'done';
  const openable = card.column === 'ready' || approved;
  // Mark reviewed: a local story's card in Ready (a PR story is marked in the inbox or by reviewing it on GitHub)
  const markable = card.column === 'ready' && card.story?.kind === 'local';
  const focusTitle = card.can_focus
    ? "Bring this session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';
  // what is going on that the column alone doesn't say
  const notes: string[] = [];
  if (card.building) {
    const since = age(card.building.since, now);
    notes.push(
      `${BUILDING_TEXT[card.building.kind]}${card.building.by ? ` (${card.building.by})` : ''}${since && ` · ${since}`}`,
    );
  }
  if (card.from_backlog?.length) {
    notes.push(`from backlog: ${card.from_backlog.map((item) => item.title).join(', ')}`);
  }
  if (card.story?.unread) {
    notes.push('the story has a new version since you last opened it');
  }
  if (pr && !pr.mine && pr.author) {
    notes.push(`${pr.author}'s PR${pr.review_requested ? ', your review is requested' : ''}`);
  }
  const list =
    card.kind === 'work' && card.sessions.length
      ? html`<ul class="ou-board-sessions">${card.sessions.map((session) => sessionHtml(session, now))}</ul>`
      : '';
  return html`<li class="ou-board-card ou-board-c-${card.column}${classes}" data-card="${card.id}" data-focus-card="${card.can_focus ? card.focus_session : ''}">
    <div class="ou-board-title" title="${card.title}">${card.title}</div>
    ${card.kind === 'agent' && html`<div class="ou-local-muted ou-board-meta">${fromHtml(card)}</div>`}
    <div class="ou-local-muted ou-board-meta">${prLink}${prLink && where && ' · '}${where}${(prLink || where) && (merged || time) && ' · '}${merged || time}</div>
    ${notes.map((note) => html`<div class="ou-board-detail">${note}</div>`)}
    ${card.listening && listeningHtml(card.listening)}
    ${card.kind === 'session' && card.detail && html`<div class="ou-board-detail">${card.detail}</div>`}
    ${gates.length > 0 && html`<div class="ou-board-chips ou-board-gates">${gates.map((text) => html`<span class="ou-board-chip">${text}</span>`)}</div>`}
    ${chips.length > 0 && html`<div class="ou-board-chips">${chips.map((chip) => html`<span class="ou-board-chip">${CHIP_MARK[chip.tone]}${chip.text}</span>`)}</div>`}
    ${card.kind === 'session' && card.sessions[0] && html`<div class="ou-local-muted">${card.sessions[0].status}${card.sessions[0].branch ? ` on ${card.sessions[0].branch}` : ''}</div>`}
    ${list}
    ${card.agents.length > 0 && html`<ul class="ou-board-agents">${card.agents.map((agent) => agentHtml(agent, now))}</ul>`}
    <div class="ou-board-actions">
      ${card.build && buildHtml(card)}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus="${card.focus_session}"${!card.can_focus && html` disabled`} title="${focusTitle}">Open in iTerm</button>`}
      ${openable && card.story?.url && html`<a class="ou-board-open" href="${card.story.url}" target="_blank" rel="noopener">Open story</a>`}
      ${openable && card.story && !card.story.url && html`<button type="button" class="ou-board-open" data-open-local="${card.story.id}" title="Opens the local story's page">Open story</button>`}
      ${markable && card.story && html`<button type="button" data-mark-local="${card.story.id}" title="Done with this story: it leaves Ready for your review">Mark reviewed</button>`}
      ${card.inbox && html`<button type="button" data-inbox data-repo="${card.inbox.repo}" title="${inboxTitle(card.inbox)}">${card.inbox.stories} to review</button>`}
    </div>
  </li>`;
}

/** One place's chip in the Blank strip: a session's tab to the front, or for several in one place a menu of them. */
function blankChip(group: { name: string; sessions: BoardBlankSession[] }) {
  const tabs = group.sessions.filter((session) => session.can_focus);
  const many = group.sessions.length > 1;
  const label = many ? `${group.name} ×${group.sessions.length}` : group.name;
  if (!tabs.length) {
    return html`<span class="ou-board-chip ou-board-blank-chip" title="No iTerm tab is known for ${many ? 'these sessions' : 'this session'}">${label}</span>`;
  }
  return many
    ? html`<button type="button" class="ou-board-chip ou-board-blank-chip" data-blank-group="${group.name}" aria-haspopup="menu" aria-expanded="false" title="Choose a blank session in ${group.name}">${label}</button>`
    : html`<button type="button" class="ou-board-chip ou-board-blank-chip" data-focus="${tabs[0].id}" title="Bring this blank session's iTerm tab to the front">${label}</button>`;
}

/** The Blank strip at the bottom of the Idle lane: sessions that have had no prompt yet, one chip per place. */
function blankHtml(blank: BoardData['blank']) {
  const count = blank.reduce((sum, group) => sum + group.sessions.length, 0);
  return html`<div class="ou-board-blank" role="group" aria-label="Blank sessions"><strong>Blank</strong> <span class="ou-local-muted">${count}</span>${blank.map((group) => blankChip(group))}<span class="ou-local-muted">no prompt yet</span></div>`;
}

/** One of the two groups of columns, headed by where its work is. */
function groupHtml(group: (typeof GROUPS)[number], columns: unknown[]) {
  return html`<div class="ou-board-group" style="--cols:${columns.length}">
    <h2 class="ou-board-group-label">${group.label}</h2>
    <div class="ou-board-cols">${columns as HtmlValue[]}</div>
  </div>`;
}

const VOICE_STATUS: Record<BoardVoice['status'], string> = {
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Working',
  paused: 'Paused',
  away: 'Away on the phone',
};

/** The voice session, pinned above the columns: its repo beside the label, its name in the tooltip, status, its agents. */
/** One line of the voice conversation, who said it first. */
const voiceLineHtml = (line: BoardVoiceLine) =>
  html`<li class="ou-board-voice-${line.who}"><span class="ou-local-muted">${line.who === 'you' ? 'You' : 'Voice'}</span> ${line.text}</li>`;

function voiceHtml(voice: BoardVoice) {
  const agents = [
    voice.agents.running && `${voice.agents.running} running`,
    voice.agents.waiting && `${voice.agents.waiting} waiting`,
  ]
    .filter(Boolean)
    .join(', ');
  const focusTitle = voice.can_focus
    ? "Bring the voice session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';
  return html`<section class="ou-board-voice ou-board-voice-${voice.status}" aria-label="Voice session" title="${voice.name}">
    <strong>Voice session</strong>
    ${voice.repo && html`<span class="ou-local-muted">${voice.repo.split('/')[1]}${voice.branch ? ` · ${voice.branch}` : ''}</span>`}
    <span class="ou-board-voice-status">${VOICE_STATUS[voice.status]}</span>
    <span class="ou-local-muted">${agents ? `agents: ${agents}` : 'no agents running'}</span>${contextHtml(voice.context)}
    ${voice.lines.length > 0 && html`<ol class="ou-board-voice-lines" aria-label="Last lines">${voice.lines.map(voiceLineHtml)}</ol>`}
    <button type="button" class="ou-board-focus" data-focus="${voice.session}"${!voice.can_focus && html` disabled`} title="${focusTitle}">Open in iTerm</button>
  </section>`;
}

/** "3h", "5m" since an ISO time, for the Listeners lane. */
const since = (iso: string | null, now: number) => (iso ? age(iso, now) : '');

/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
function listenersHtml(repos: BoardListenerRepo[], now: number) {
  if (!repos.length) {
    return '';
  }
  const rows = repos.map((entry) => {
    const active = entry.active;
    if (active) {
      const who = sessionLink(
        active.session,
        active.can_focus,
        active.title || active.consumer,
        'Bring the listening session to the front',
      );
      const parts = [
        active.since && `for ${since(active.since, now)}`,
        active.last_handled_at
          ? `last request ${since(active.last_handled_at, now)} ago`
          : 'no request yet',
        active.state === 'handling' && 'handling one now',
      ].filter(Boolean);
      return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-board-voice-status">Listening</span> <span class="ou-local-muted">${who} · ${parts.join(' · ')}</span>
        <button type="button" data-stop-listening="${entry.repo}">Stop listening</button></li>`;
    }
    const seen = entry.last_seen ? ` · last listened ${since(entry.last_seen, now)} ago` : '';
    const off = entry.candidates.length ? '' : html` disabled`;
    // several idle sessions and no obvious one: the button opens a menu to pick from
    const choosing =
      entry.candidates.length > 1 && !obviousChoice(entry.candidates)
        ? html` aria-haspopup="menu" aria-expanded="false"`
        : '';
    let title = 'No idle session in this repo has an iTerm tab';
    if (entry.candidates.length) {
      title = choosing
        ? 'Choose an idle session in the repo to type /once-upon-listen into'
        : `Types /once-upon-listen ${entry.repo} into an idle session in the repo`;
    }
    return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-local-muted">not listening${seen}</span>
      <button type="button" data-start-listening="${entry.repo}"${off}${choosing} title="${title}">Start listening${choosing && ' ▾'}</button></li>`;
  });
  return html`<section class="ou-board-listeners" aria-label="Listeners"><h2 class="ou-board-head">Listeners <span class="ou-local-muted">${repos.filter((entry) => entry.active).length}</span></h2><ul>${rows}</ul></section>`;
}

/** A column's header: its name, how many cards it has, and + Add on Backlog. */
function columnHead(column: { id: BoardColumn; label: string }, total: number, onAuthorCount = 0) {
  const add =
    column.id === 'backlog' &&
    !addOpen &&
    html` <button type="button" data-backlog-add-open title="Keep something for later">+ Add</button>`;
  const authors =
    column.id === 'pr_open' &&
    onAuthorCount > 0 &&
    html` <button type="button" data-on-author-toggle aria-pressed="${String(hideOnAuthor)}" title="Others' PRs with nothing on you: the ball is in the author's court">${hideOnAuthor ? 'Show' : 'Hide'} ${onAuthorCount} on their author</button>`;
  return html`<h2 class="ou-board-head">${column.label} <span class="ou-local-muted">${total}</span>${add}${authors}</h2>`;
}

/** A repo heading in a column, with the toggle that folds its cards (and the count shown while they are folded). */
function laneHead(
  column: { id: BoardColumn; label: string },
  name: string,
  total: number,
  folded: boolean,
) {
  const verb = folded ? 'Show' : 'Hide';
  const count = folded && html` <span class="ou-board-lane-count">${total}</span>`;
  return html`<h3 class="ou-board-lane-label">
    <button type="button" class="ou-board-lane-toggle" data-lane-toggle="${column.id}/${name}" aria-expanded="${String(!folded)}"
      aria-label="${verb} ${name} cards in ${column.label}" title="${verb} the ${name} cards"><span aria-hidden="true">${folded ? '▸' : '▾'}</span> ${name}${count}</button></h3>`;
}

/** The Backlog column's Add panel: a title, the repo the item is for (a menu in the page's style) and a note. */
function addFormHtml() {
  const repo = addRepo ? addRepo.split('/')[1] : 'none';
  return html`<form class="ou-board-add" data-backlog-add>
    <input type="text" name="title" data-backlog-title placeholder="Keep something for later" maxlength="200" required aria-label="Backlog item title">
    <button type="button" class="ou-board-add-repo" data-backlog-repo aria-haspopup="menu" title="The repo the new item is for: its card goes in that repo's lane">Repo: ${repo} ▾</button>
    <input type="text" name="note" placeholder="Note (optional)" maxlength="1000" aria-label="Note">
    <div class="ou-board-add-actions"><button type="submit">Add</button> <button type="button" data-backlog-cancel>Cancel</button></div>
  </form>`;
}

/** The board narrowed to the filter's lane: its lanes, blank sessions and listeners (a gone lane means All). */
function filtered(data: BoardData): BoardData {
  if (!laneFilter || !data.lanes.some((lane) => lane.name === laneFilter)) {
    return data;
  }
  return {
    ...data,
    lanes: data.lanes.filter((lane) => lane.name === laneFilter),
    blank: data.blank.filter((group) => group.name === laneFilter),
    listeners: data.listeners.filter((entry) => entry.repo.split('/')[1] === laneFilter),
  };
}

function render(full: BoardData) {
  board = full;
  // a card is being dragged: a redraw would drop it, so the drop (or its end) redraws
  if (dragId) {
    return;
  }
  const data = filtered(full);
  const filterOn = data !== full;
  const now = Date.now();
  const onAuthorCount = data.lanes.flatMap((lane) => lane.cards).filter(onAuthor).length;
  const cards = data.lanes.flatMap((lane) => lane.cards).filter(shownCard);
  const columns = COLUMNS.filter(
    (column) => column.always || cards.some((card) => card.column === column.id),
  );
  const inGroup = (group: string) => columns.filter((column) => column.group === group);
  const idle = data.lanes
    .flatMap((lane) =>
      lane.cards
        .filter((card) => card.column === 'idle')
        .map((card) => ({ lane: lane.name, card })),
    )
    .sort(
      (first, second) =>
        first.lane.localeCompare(second.lane) ||
        String(first.card.since).localeCompare(String(second.card.since)),
    );
  // Done: finished lately, its context still cached, so picking it up is cheap; Idle: it would re-read everything
  const done = idle.filter((item) => isWarm(item.card, now));
  const cold = idle.filter((item) => !isWarm(item.card, now));
  const count = (id: BoardColumn) => cards.filter((card) => card.column === id).length;
  const blankCount = data.blank.reduce((sum, group) => sum + group.sessions.length, 0);
  // a column lists its cards by lane, the lane's label right above its cards (so the two are never far apart)
  const bodyOf = new Map<string, ReturnType<typeof html>>();
  columns.forEach((column) => {
    const groups = data.lanes
      .map((lane) => ({
        name: lane.name,
        cards: lane.cards
          .filter((card) => card.column === column.id && shownCard(card))
          // Backlog keeps the order you gave it; the others go by how long they have been there
          .sort((first, second) =>
            column.id === 'backlog' ? 0 : String(first.since).localeCompare(String(second.since)),
          ),
      }))
      .filter((group) => group.cards.length);
    bodyOf.set(
      column.id,
      html`<section class="ou-board-col ou-board-c-${column.id}${count(column.id) ? '' : ' ou-board-empty'}" aria-label="${column.label}">
      ${columnHead(column, count(column.id), onAuthorCount)}
      ${column.id === 'backlog' && addOpen && addFormHtml()}
      ${groups.map((group) => {
        const folded = collapsed.has(`${column.id}/${group.name}`);
        return html`<div class="ou-board-lane">${laneHead(column, group.name, group.cards.length, folded)}${!folded && html`<ul class="ou-board-cards">${group.cards.map((card) => cardHtml(card, now))}</ul>`}</div>`;
      })}
    </section>`,
    );
  });
  // what is on you: a question, a story to review, comments to answer
  const onYou = count('waiting') + count('ready') + count('back');
  document.title = onYou ? `(${onYou}) Agent board` : 'Agent board';
  const summary = [
    ...(count('backlog') ? [`${count('backlog')} in backlog`] : []),
    `${count('working')} working`,
    `${count('waiting')} waiting`,
    ...(count('checks') ? [`${count('checks')} in agent checks`] : []),
    `${count('ready')} ready for your review`,
    `${count('back')} back to you`,
    `status from ${data.status_source}`,
  ].join(' · ');
  const nothing =
    blankCount > 0
      ? ''
      : html`<p class="ou-local-muted">No Claude Code sessions are running, and no PRs are waiting.</p>`;
  const idleRow = (items: typeof idle) =>
    html`<ul class="ou-board-idle-row">${items.map((item) => html`<li class="ou-board-idle-cell"><h3 class="ou-board-lane-label">${item.lane}</h3><ul class="ou-board-cards">${cardHtml(item.card, now)}</ul></li>`)}</ul>`;
  const toggle =
    idle.length > 0
      ? html`<button type="button" data-idle-toggle aria-expanded="${String(idleOpen)}">${idleOpen ? 'Hide' : 'Show'}</button>`
      : '';
  const markup = html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Agent board</h1><div class="ou-local-muted">${summary}</div></div>
      <button type="button" data-board-filter aria-haspopup="menu" title="Narrow the whole board to one repo's lane">Repo: ${filterOn ? laneFilter : 'All'} ▾</button>
      <button type="button" data-inbox="">Review inbox</button>
    </header>
    ${usageHtml(data.usage, now)}
    ${data.warning && html`<p class="ou-board-warning">${data.warning}</p>`}
    ${data.voice && voiceHtml(data.voice)}
    <main class="ou-board">
      <div class="ou-board-groups">${GROUPS.map((group) =>
        groupHtml(
          group,
          inGroup(group.id).map((column) => bodyOf.get(column.id)),
        ),
      )}</div>
      ${!cards.length && nothing}
      ${
        done.length > 0 &&
        html`<section class="ou-board-idle ou-board-c-done-idle" aria-label="Done">
        <h2 class="ou-board-head">Done <span class="ou-local-muted">${done.length}</span> <span class="ou-local-muted ou-board-head-note">context still cached</span></h2>
        ${idleRow(done)}
      </section>`
      }
      ${
        (cold.length > 0 || blankCount > 0) &&
        html`<section class="ou-board-idle ou-board-c-idle" aria-label="Idle">
        <h2 class="ou-board-head">Idle <span class="ou-local-muted">${cold.length + blankCount}</span> ${cold.length > 0 && toggle}</h2>
        ${idleOpen && cold.length > 0 && idleRow(cold)}
        ${blankCount > 0 && blankHtml(data.blank)}
      </section>`
      }
      ${listenersHtml(data.listeners, now)}
    </main>`;
  // ages tick on every poll, but the page is only redrawn when its markup changed (a redraw loses a focused button)
  const next = String(markup);
  if (next !== last) {
    last = next;
    // a redraw would empty the Add row while you type in it: keep what is typed, and the focus
    const typed = [...app.querySelectorAll<HTMLInputElement>('[data-backlog-add] [name]')].map(
      (field) => [field.name, field.value] as const,
    );
    const focused = (document.activeElement as HTMLElement | null)?.closest('[data-backlog-add]')
      ? (document.activeElement as HTMLInputElement).name
      : null;
    setHtml(app, markup);
    for (const [name, value] of typed) {
      const field = app.querySelector<HTMLInputElement>(`[data-backlog-add] [name="${name}"]`);
      if (field && value) {
        field.value = value;
      }
    }
    if (focused) {
      app.querySelector<HTMLInputElement>(`[data-backlog-add] [name="${focused}"]`)?.focus();
    }
    // a card moved with Alt+arrow: keep the keyboard on it
    if (focusAfter) {
      app.querySelector<HTMLElement>(`[data-backlog-card="${focusAfter}"]`)?.focus();
      focusAfter = '';
    }
  }
}

async function refresh() {
  try {
    render(await api<BoardData>('/api/board'));
  } catch (err) {
    last = '';
    // refused for want of a key: say how to connect (the poll fills the board in once there is a cookie)
    const refused = [401, 403].includes((err as { status?: number }).status ?? 0);
    setHtml(
      app,
      refused
        ? notConnectedHtml('board')
        : html`<p class="ou-local-error">Couldn't load the board: ${(err as Error).message}</p>`,
    );
  }
}

const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');

/** Brings a session's iTerm tab to the front; the bridge finds the tab itself. */
async function focusSession(session: string, button: Element | null) {
  // the bridge looks the tab up and raises it, which takes most of a second: say so meanwhile
  const control = button as HTMLButtonElement | null;
  const label = control?.textContent ?? '';
  if (control) {
    control.textContent = 'Switching…';
    control.disabled = true;
  }
  document.body.style.cursor = 'progress';
  try {
    await api('/api/board/focus', { session });
  } catch (err) {
    alert(`Couldn't bring the iTerm tab forward: ${(err as Error).message}`);
  } finally {
    document.body.style.cursor = '';
    if (control?.isConnected) {
      control.textContent = label;
      control.disabled = false;
    }
  }
}

/** A session's title from the last data, for the confirmation boxes. */
const titleOf = (session: string): string => {
  const view = board?.lanes
    .flatMap((lane) => lane.cards.flatMap((card) => card.sessions))
    .find((one) => one.id === session);
  return (
    view?.title ??
    board?.listeners.flatMap((entry) => entry.candidates).find((one) => one.id === session)
      ?.title ??
    'that session'
  );
};

/** Asks first, then has the bridge type the line into the session's tab (it refuses a session that is busy). */
async function typeInto(
  kind: 'build' | 'listen',
  session: string,
  line: string,
  repo: string | null,
) {
  if (!window.confirm(`Type this into "${titleOf(session)}" and press Enter?\n\n${line}`)) {
    return;
  }
  try {
    await api('/api/board/type', { kind, session, ...(repo ? { repo } : {}) });
    last = '';
    await refresh();
  } catch (err) {
    alert(`Couldn't type into the session: ${(err as Error).message}`);
  }
}

// Alt+Up or Alt+Down on a focused Backlog card moves it within its lane (the keyboard's way to reorder)
app.addEventListener('keydown', async (event) => {
  const card = cardOf(event);
  if (!event.altKey || !card || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
    return;
  }
  event.preventDefault();
  const id = card.dataset.backlogCard || '';
  const first = board?.lanes.flatMap((lane) => lane.cards).find((one) => one.backlog?.id === id);
  const ids = first ? backlogLane(first) : [];
  const goingUp = event.key === 'ArrowUp';
  const neighbour = ids[ids.indexOf(id) + (goingUp ? -1 : 1)];
  const where = neighbour ? placeAmong(ids, id, neighbour, !goingUp) : null;
  if (where) {
    focusAfter = id;
    await moveBacklog(id, where);
  }
});

document.addEventListener('keydown', (event) => {
  // (Escape in the repo menu is the menu's: it handles the key first and marks it, so the panel stays open with its text)
  if (event.key === 'Escape' && !event.defaultPrevented && addOpen && board) {
    addOpen = false;
    last = '';
    render(board);
  }
});

/** Where `dragged` goes in its lane's ids if put before (or after) `target`: before the item now there, or the bottom. */
function placeAmong(ids: string[], dragged: string, target: string, after: boolean) {
  const rest = ids.filter((one) => one !== dragged);
  const slot = rest.indexOf(target) + (after ? 1 : 0);
  if (rest.indexOf(target) < 0 || slot === ids.indexOf(dragged)) {
    return null;
  }
  return slot >= rest.length ? { edge: 'bottom' } : { before: rest[slot] };
}

async function moveBacklog(id: string, where: { before: string } | { edge: string }) {
  try {
    await api('/api/board/backlog/move', { id, ...where });
  } catch (err) {
    alert(`Couldn't move it: ${(err as Error).message}`);
  }
  last = '';
  await refresh();
}

const cardOf = (event: Event) =>
  (event.target as Element).closest<HTMLElement>('[data-backlog-card]');
const clearDrops = () =>
  app
    .querySelectorAll('.ou-board-drop-before, .ou-board-drop-after')
    .forEach((one) => one.classList.remove('ou-board-drop-before', 'ou-board-drop-after'));
/**
 * Where a drop would put the dragged card: anywhere over its lane's list (the gaps between cards too), the slot is
 * before the first card whose middle is below the pointer, else after the last. Null outside the lane, or for a slot
 * that leaves the order as it is.
 */
function dropTarget(
  event: DragEvent,
): { card: HTMLElement; after: boolean; where: { before: string } | { edge: string } } | null {
  const from = dragId ? app.querySelector<HTMLElement>(`[data-backlog-card="${dragId}"]`) : null;
  const list = (event.target as Element).closest('.ou-board-cards');
  if (!from || !list) {
    return null;
  }
  const cards = [...list.querySelectorAll<HTMLElement>(':scope > [data-backlog-card]')].filter(
    (card) => card.dataset.lane === from.dataset.lane,
  );
  if (!cards.length) {
    return null;
  }
  const below = cards.find((card) => {
    const box = card.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  });
  const card = below || cards[cards.length - 1];
  const after = !below;
  const first = board?.lanes
    .flatMap((lane) => lane.cards)
    .find((one) => one.backlog?.id === dragId);
  const where = first
    ? placeAmong(backlogLane(first), dragId, card.dataset.backlogCard || '', after)
    : null;
  return where ? { card, after, where } : null;
}

app.addEventListener('dragstart', (event) => {
  const card = cardOf(event);
  if (!card) {
    return;
  }
  dragId = card.dataset.backlogCard || '';
  card.classList.add('ou-board-dragging');
  event.dataTransfer?.setData('text/plain', dragId);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
});
app.addEventListener('dragover', (event) => {
  const over = dropTarget(event);
  const mark = over && (over.after ? 'ou-board-drop-after' : 'ou-board-drop-before');
  // a pointer still over the same slot keeps its line (clearing and re-adding it on every move flickers)
  if (over && over.card.classList.contains(mark as string)) {
    event.preventDefault();
    return;
  }
  clearDrops();
  if (over) {
    event.preventDefault();
    over.card.classList.add(mark as string);
  }
});
app.addEventListener('dragend', () => {
  dragId = '';
  clearDrops();
  if (board) {
    last = '';
    render(board);
  }
});
app.addEventListener('drop', async (event) => {
  const over = dropTarget(event);
  const dragged = dragId;
  clearDrops();
  if (!over || !dragged) {
    return;
  }
  event.preventDefault();
  dragId = '';
  await moveBacklog(dragged, over.where);
});

app.addEventListener('submit', async (event) => {
  const form = (event.target as Element).closest('[data-backlog-add]') as HTMLFormElement | null;
  if (!form) {
    return;
  }
  event.preventDefault();
  if (adding) {
    return;
  }
  const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  const item = {
    title: field('title'),
    repo: addRepo || undefined,
    note: field('note') || undefined,
  };
  // cleared before the request goes out, so a redraw while it is out can't bring the text back and invite a second add
  adding = true;
  form.reset();
  try {
    await api('/api/board/backlog', item);
    addOpen = false;
  } catch (err) {
    const again = (name: string) =>
      document.querySelector<HTMLInputElement>(`[data-backlog-add] [name="${name}"]`);
    const title = again('title');
    const note = again('note');
    if (title && !title.value) {
      title.value = item.title;
    }
    if (note && !note.value) {
      note.value = item.note ?? '';
    }
    alert(`Couldn't add it: ${(err as Error).message}`);
  } finally {
    adding = false;
  }
  last = '';
  await refresh();
});

app.addEventListener('click', async (event) => {
  const clicked = event.target as Element;
  const fold = clicked.closest('[data-lane-toggle]');
  if (fold) {
    const id = fold.getAttribute('data-lane-toggle') || '';
    if (!collapsed.delete(id)) {
      collapsed.add(id);
    }
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* the choice just isn't remembered */
    }
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
  if (clicked.closest('[data-backlog-add-open], [data-backlog-cancel]')) {
    addOpen = !!clicked.closest('[data-backlog-add-open]');
    if (board) {
      last = '';
      render(board);
      app.querySelector<HTMLInputElement>('[data-backlog-title]')?.focus();
    }
    return;
  }
  const filterButton = clicked.closest('[data-board-filter]');
  if (filterButton) {
    const lanes = board?.lanes ?? [];
    openMenu(
      filterButton as HTMLElement,
      [
        { value: '', label: 'All', detail: plural(lanes.length, 'lane'), checked: !laneFilter },
        ...lanes.map((lane) => ({
          value: lane.name,
          label: lane.name,
          detail: plural(lane.cards.length, 'card'),
          checked: lane.name === laneFilter,
        })),
      ],
      (value) => {
        laneFilter = value;
        try {
          localStorage.setItem(FILTER_KEY, value);
        } catch {
          /* the choice just isn't remembered */
        }
        if (board) {
          last = '';
          render(board);
        }
      },
      { label: 'Show one repo' },
    );
    return;
  }
  const repoButton = clicked.closest('[data-backlog-repo]');
  if (repoButton) {
    const repos = [
      ...new Set(
        (board?.lanes ?? [])
          .flatMap((lane) => lane.cards)
          .map((card) => card.repo)
          .filter((repo): repo is string => !!repo),
      ),
    ].sort();
    openMenu(
      repoButton as HTMLElement,
      [
        { value: '', label: 'No repo', detail: 'in the General lane', checked: !addRepo },
        ...repos.map((repo) => ({
          value: repo,
          label: repo.split('/')[1],
          detail: repo,
          checked: repo === addRepo,
        })),
      ],
      (value) => {
        addRepo = value;
        if (board) {
          last = '';
          render(board);
        }
      },
      { label: 'Repo for the new item' },
    );
    return;
  }
  const drop = clicked.closest('[data-backlog-drop]');
  if (drop) {
    try {
      await api('/api/board/backlog/drop', { id: drop.getAttribute('data-backlog-drop') });
      last = '';
      await refresh();
    } catch (err) {
      alert(`Couldn't drop it: ${(err as Error).message}`);
    }
    return;
  }
  const copy = clicked.closest('[data-backlog-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.getAttribute('data-backlog-copy') || '');
    } catch {
      alert('Copying was blocked: select the line on the card and copy it.');
    }
    return;
  }
  const build = clicked.closest('[data-build]');
  if (build && !build.hasAttribute('disabled')) {
    await typeInto(
      'build',
      build.getAttribute('data-build') || '',
      build.getAttribute('data-prompt') || '',
      null,
    );
    return;
  }
  const start = clicked.closest('[data-start-listening]');
  if (start && !start.hasAttribute('disabled')) {
    const repo = start.getAttribute('data-start-listening') || '';
    const entry = board?.listeners.find((one) => one.repo === repo);
    const candidates = entry?.candidates ?? [];
    // one obvious session (the only one, or clearly the freshest): use it; else a menu of them, freshest first
    const obvious = obviousChoice(candidates);
    const line = `/once-upon-listen ${repo}`;
    if (obvious || candidates.length === 1) {
      await typeInto('listen', (obvious ?? candidates[0]).id, line, repo);
    } else if (candidates.length) {
      openMenu(
        start as HTMLElement,
        freshestFirst(candidates).map((one) => ({
          value: one.id,
          label: one.title,
          detail: `${one.status}${one.since ? ` ${age(one.since, Date.now())}` : ''} · ${repo}`,
        })),
        (id) => void typeInto('listen', id, line, repo),
        { label: `Sessions in ${repo}` },
      );
    }
    return;
  }
  const stop = clicked.closest('[data-stop-listening]');
  if (stop) {
    const repo = stop.getAttribute('data-stop-listening') || '';
    if (
      window.confirm(
        `Stop listening for ${repo}? Its session's wait ends within a couple of seconds.`,
      )
    ) {
      try {
        await api('/api/board/stop-listening', { repo });
        last = '';
        await refresh();
      } catch (err) {
        alert(`Couldn't stop it: ${(err as Error).message}`);
      }
    }
    return;
  }
  const markLocal = clicked.closest('[data-mark-local]');
  if (markLocal) {
    try {
      await api('/api/board/reviewed', { story: markLocal.getAttribute('data-mark-local') });
      last = '';
      await refresh();
    } catch (err) {
      alert(`Couldn't mark it reviewed: ${(err as Error).message}`);
    }
    return;
  }
  const openLocal = clicked.closest('[data-open-local]');
  if (openLocal) {
    try {
      const { url } = await api<{ url: string }>('/api/board/open-story', {
        story: openLocal.getAttribute('data-open-local'),
      });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      alert(`Couldn't open the story: ${(err as Error).message}`);
    }
    return;
  }
  const blankGroup = clicked.closest('[data-blank-group]');
  if (blankGroup) {
    const name = blankGroup.getAttribute('data-blank-group') || '';
    const group = board?.blank.find((one) => one.name === name);
    openMenu(
      blankGroup as HTMLElement,
      (group?.sessions ?? [])
        .filter((one) => one.can_focus)
        .map((one) => ({
          value: one.id,
          label: one.title,
          detail: `blank${one.since ? ` ${age(one.since, Date.now())}` : ''} · ${name}`,
        })),
      (id) => void focusSession(id, null),
      { label: `Blank sessions in ${name}` },
    );
    return;
  }
  const focus = clicked.closest('[data-focus]');
  const card = clicked.closest('[data-focus-card]');
  // a click on the control, or on the card itself (not on one of its links or buttons), raises the session's tab
  if (focus && !focus.hasAttribute('disabled')) {
    await focusSession(focus.getAttribute('data-focus') || '', focus);
    return;
  }
  // (on a touch screen there is no tab to raise: the control is hidden and a tap on a card does nothing)
  if (
    card &&
    !clicked.closest('a, button') &&
    card.getAttribute('data-focus-card') &&
    !TOUCH.matches
  ) {
    await focusSession(
      card.getAttribute('data-focus-card') || '',
      card.querySelector('.ou-board-focus'),
    );
    return;
  }
  if (clicked.closest('[data-on-author-toggle]')) {
    hideOnAuthor = !hideOnAuthor;
    try {
      localStorage.setItem(ON_AUTHOR_KEY, String(hideOnAuthor));
    } catch {
      /* the choice just isn't remembered */
    }
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
  if (clicked.closest('[data-idle-toggle]')) {
    idleOpen = !idleOpen;
    try {
      localStorage.setItem(IDLE_KEY, String(idleOpen));
    } catch {
      /* the choice just isn't remembered */
    }
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
  const target = (event.target as Element).closest('[data-inbox]');
  if (!target) {
    return;
  }
  try {
    const query = new URLSearchParams();
    const repo = target.getAttribute('data-repo');
    if (repo) {
      query.set('repo', repo);
    }
    const { url } = await api<{ url: string }>(`/api/board/inbox-link?${query}`);
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    alert(`Couldn't open the inbox: ${(err as Error).message}`);
  }
});

refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
window.addEventListener('focus', refresh);
