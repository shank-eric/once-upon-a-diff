/*
 * The agent board page: the Claude Code sessions running now, one card each, in a column for where they stand
 * (working, agent checks, waiting, done; idle and error when there are any, and sessions with no prompt yet as a Blank strip) and a lane for their repo, with the background agents
 * inside their parent's card or, when the ledger gave them a lane, on a card in that lane. The data is
 * GET /api/board (src/services/board/board.ts), polled every few seconds. The page's key (the link's #key=, which
 * `once-upon board` prints) reaches the board's routes and nothing else.
 */
import { createClient, type Transport } from '/assets/protocol/client.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { authHeader, startAuth } from '/assets/local/auth.ts';
import { notConnectedHtml } from '/assets/local/not-connected.ts';
import { openMenu } from '/assets/local/menu.ts';
import { remember, stored } from '/assets/local/stored.ts';
import { mountVoice } from '/assets/local/voice-panel.ts';
import { freshestFirst, obviousChoice } from '/assets/util/choice.ts';
import { html, type HtmlValue } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { gateText, plural } from '/assets/util/text.ts';
import { compactAge } from '/assets/util/time.ts';
import { startedChips } from '/assets/util/started-chips.ts';
import { cleanupConfirm, sizeText, worktreeChips } from '/assets/util/worktree-text.ts';
import { answerBits } from '/assets/util/story-answers.ts';
import type {
  BoardAgent,
  BoardAssign,
  BoardBlankSession,
  BoardCard,
  BoardColumn,
  BoardData,
  BoardLimit,
  BoardListenerRepo,
  BoardSession,
  BoardUsage,
  BoardVoice,
  BoardWorktree,
  PrInfo,
} from '/assets/types.ts';

const POLL_MS = 3000;
const app = document.getElementById('ou-board-app') as HTMLElement;
/**
 * The page has two parts. `main` takes the board's string-rendered markup (setHtml replaces all of it on a redraw), and
 * `voiceHost` is where the voice panel, a Preact component (local/voice-panel.ts), draws itself, so a redraw of the strings
 * never touches it. Both sit inside the app element, which carries the classes and variables the stylesheet keys off.
 */
const main = document.createElement('div');
main.style.display = 'contents';
main.append(...app.childNodes);
const voiceHost = document.createElement('div');
app.append(main, voiceHost);
const KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board');

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
  { id: 'ship', label: 'Ready to ship', group: 'local', always: false },
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

/** The Idle lane's state is remembered. */
const IDLE_KEY = 'ou-board-idle-open';
let idleOpen = stored(IDLE_KEY, true, (text) => text !== 'false');

/** The Worktrees lane's state is remembered too. */
const TREES_KEY = 'ou-board-worktrees-open';
let treesOpen = stored(TREES_KEY, true, (text) => text !== 'false');

/** A repo heading's fold in a column is remembered, as "<column>/<heading>". */
const COLLAPSED_KEY = 'ou-board-collapsed-lanes';
const collapsed = stored(COLLAPSED_KEY, new Set<string>(), (text) => {
  const saved = JSON.parse(text);
  return new Set<string>(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
});

/** Others' PRs waiting on their author can be hidden from PR open; remembered. */
const ON_AUTHOR_KEY = 'ou-board-hide-on-author';
let hideOnAuthor = stored(ON_AUTHOR_KEY, false, (text) => text === 'true');
/** Someone else's PR with nothing on you and no session of yours on it: the ball is in its author's court. */
const onAuthor = (card: BoardCard) =>
  card.column === 'pr_open' && !!card.pr && !card.pr.mine && !card.sessions.length;
const shownCard = (card: BoardCard) => !(hideOnAuthor && onAuthor(card));

/** A phone-mode or bridge call is running: the 3 s refresh redraws the buttons disabled, so a second click cannot start another. */
let phoneBusy = false;
/** The Add panel is closed until asked for (+ Add), and closes after an add or Escape. */
let addOpen = false;
/** The board's repo filter: a lane name, '' for All. Remembered; a lane that is gone shows everything. */
const FILTER_KEY = 'ou-board-filter';
let laneFilter = stored(FILTER_KEY, '');
/** The repo the Add panel's next item is for ('' for none). It stays between adds. */
let addRepo = '';
/** The Backlog card being dragged, and the card to put the keyboard back on after an Alt+arrow move. */
let dragId = '';
let focusAfter = '';

/** An add is in flight: a second submit waits for it. */
let adding = false;

/** The board's way to the bridge for the protocol's client: its key (or its cookie), once the host's auth has settled. */
const transport: Transport = async ({ method, path, body }) => {
  await authed;
  try {
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: {
        ...authHeader(KEY),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (json as { error?: string }).error;
      return {
        ok: false,
        status: response.status,
        body: json,
        error: message || `HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
};

/** The typed calls to the bridge: `bridge.ask(ROUTES.name, {body})` answers, or throws a BridgeError with the bridge's message and status. */
const bridge = createClient(transport);

/** "5m ago", or "just now" for the first minute (compactAge says "now"). */
function ago(iso: string | null, now: number): string {
  const time = compactAge(iso, now);
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

/** A `[review]` agent is not asking a question: it has a story up for you. */
const agentMark = (agent: BoardAgent) => (agent.review ? '◉' : AGENT_MARK[agent.state]);

const stateNote = (agent: BoardAgent) =>
  agent.review ? 'ready for review' : (STATE_NOTE[agent.state] ?? agent.state);

function agentHtml(agent: BoardAgent, now: number) {
  const beat = agent.beat;
  const note =
    beat && agent.state === 'running' ? `${beat.n}/${beat.of} ${beat.step}` : stateNote(agent);
  const percent = beat ? Math.min(100, Math.round((beat.n / Math.max(1, beat.of)) * 100)) : 0;
  const detail = agent.state === 'running' ? beat?.note || agent.task : agent.outcome || agent.task;
  const time = compactAge(agent.ended_at || agent.started_at, now);
  return html`<li class="ou-board-agent ou-board-s-${agent.status}" title="${agent.task || ''}">
    <div class="ou-board-agent-line"><span class="ou-board-mark" aria-hidden="true">${agentMark(agent)}</span> <strong>${agent.name}</strong>
      <span class="ou-local-muted">${note}${agent.stale && ' (no done line yet)'}${time && ` · ${time}`}</span></div>
    ${beat && agent.state === 'running' && html`<div class="ou-board-bar" aria-hidden="true"><span style="width:${percent}%"></span></div>`}
    ${detail && html`<div class="ou-board-agent-note ou-local-muted">${detail}</div>`}
  </li>`;
}

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

/** The warning class for a percentage: yellow from 70, red from 90. */
function levelOf(value: number) {
  if (value >= 90) {
    return ' ou-board-usage-high';
  }
  return value >= 70 ? ' ou-board-usage-warn' : '';
}

/** A label, a thin bar filled to a percentage and the number, yellow from 70% and red from 90% like the status line. */
function meterHtml(label: string, percent: number, title: string, extra: HtmlValue = '') {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<span class="ou-board-meter${levelOf(percent)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped}" aria-label="${label}" title="${title}">
    <span class="ou-board-meter-label">${label}</span>
    <span class="ou-board-meter-bar" aria-hidden="true"><span style="width:${clamped}%"></span></span>
    <span class="ou-board-meter-num">${clamped}%</span>${extra}
  </span>`;
}

/** A session's context meter, or '' when the status line hasn't said. */
function contextHtml(context: number | null | undefined) {
  if (typeof context !== 'number') {
    return '';
  }
  return html` ${meterHtml('ctx', context, `The session's context window is ${Math.round(context)}% full`)}`;
}

/** When a limit resets: the time today, else the weekday and hour. */
function resetText(iso: string | null, now: number): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString(
    [],
    sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric' },
  );
}

/**
 * The usage meters in the header's right side: the 5-hour and weekly limits as thin bars. The reset time and how old the
 * status line's reading is go in the tooltip, and the reset shows beside the bar once a limit is at 70%.
 */
function usageHtml(usage: BoardUsage | null, now: number) {
  if (!usage) {
    return '';
  }
  const seen = compactAge(usage.at, now);
  const limit = (label: string, name: string, value: BoardLimit | null) => {
    if (!value) {
      return '';
    }
    const resets = resetText(value.resets_at, now);
    const title = `${name}: ${Math.round(value.percent)}% used${resets ? `, resets ${resets}` : ''}${seen ? ` (status line read ${seen} ago)` : ''}`;
    const note =
      value.percent >= 70 && resets
        ? html`<span class="ou-board-meter-reset">resets ${resets}</span>`
        : '';
    return meterHtml(label, value.percent, title, note);
  };
  const five = limit('5h', '5-hour limit', usage.five_hour);
  const week = limit('week', 'Weekly limit', usage.seven_day);
  return five || week
    ? html`<div class="ou-board-meters" aria-label="Usage">${five}${week}</div>`
    : '';
}

function sessionHtml(session: BoardSession, now: number) {
  const time = compactAge(session.since, now);
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

/** The session Assign uses without asking: the only one, the only blank one, else (no blank ones) the clearly freshest. */
function assignObvious(candidates: BoardAssign['candidates']) {
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

/** One worktree: its name, where, the chips, why it is kept, and Clean up when the bridge offers it. */
function worktreeHtml(tree: BoardWorktree, now: number, lane = false) {
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
const cardTrees = (card: BoardCard, now: number) =>
  card.worktrees?.length
    ? html`<ul class="ou-board-trees">${card.worktrees.map((tree) => worktreeHtml(tree, now))}</ul>`
    : '';

function backlogHtml(card: BoardCard, now: number) {
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

function cardHtml(card: BoardCard, now: number) {
  if (card.kind === 'backlog') {
    return backlogHtml(card, now);
  }
  const classes = `${card.can_focus ? ' ou-board-clickable' : ''}`;
  const pr = card.pr;
  const time = compactAge(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? card.repo.split('/')[1] : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink =
    pr && html`<a href="${pr.url}" target="_blank" rel="noopener">PR #${pr.number}</a>`;
  const merged = pr?.state === 'merged' && time ? `merged ${ago(card.since, now)}` : '';
  const chips = pr ? prChips(pr) : [];
  if (card.story?.approved_at && card.column === 'ship') {
    chips.push({ text: 'Approved, ready to ship', tone: 'ok' });
  }
  if (card.ahead) {
    chips.push({ text: `${card.ahead.count} ahead`, tone: 'warn' });
  }
  const gates = card.agents.filter((agent) => agent.gate).map(gateText);
  // Open story: on a card ready for review, or an approved local story in Ready to ship (a local story is never in Back to you)
  const bits = answerBits(card);
  const { openable, markable } = bits; // Mark reviewed: a local story's card in Ready (a PR story is marked by reviewing it on GitHub)
  if (bits.chip) {
    chips.push({ text: bits.chip, tone: 'warn' });
  }
  const focusTitle = card.can_focus
    ? "Bring this session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';
  // what is going on that the column alone doesn't say
  const notes: string[] = [];
  if (card.building) {
    const since = compactAge(card.building.since, now);
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
  if (bits.note) {
    notes.push(bits.note);
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
    ${cardTrees(card, now)}
    <div class="ou-board-actions">
      ${card.build && buildHtml(card)}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus="${card.focus_session}"${!card.can_focus && html` disabled`} title="${focusTitle}">Open in iTerm</button>`}
      ${card.column === 'ship' && card.story?.ship === 'push' && html`<button type="button" class="ou-board-push" data-push-local="${card.story.id}" title="Opens the story's Push box, which checks GitHub first">Push</button>`}
      ${card.ahead && html`<button type="button" class="ou-board-push" data-push-local="${card.ahead.story}" title="Opens the story's Push box: the branch is ${card.ahead.count} ahead of GitHub, where this PR is open">Push</button>`}
      ${openable && card.story?.url && html`<a class="ou-board-open" href="${card.story.url}${bits.hash}" target="_blank" rel="noopener">Open story</a>`}
      ${openable && card.story && !card.story.url && html`<button type="button" class="ou-board-open" data-open-local="${card.story.id}" title="Opens the local story's page">Open story</button>`}
      ${markable && card.story && html`<button type="button" data-mark-local="${card.story.id}" title="Done with this story: it leaves Ready for your review">Mark reviewed</button>`}
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

/**
 * The voice controls in the board's top header, the rightmost items (past the repo dropdown): Resume while voice is paused,
 * the phone-mode toggle whenever the Larmor checkout can run it, voice on or not (Larmor's away mode, which starts the phone
 * bridge), and Stop phone bridge while the bridge runs. Nothing when none applies.
 */
function voiceHeaderHtml(voice: BoardVoice | null, phone: BoardData['phone']) {
  const phoneModeTitle = phone?.on
    ? 'Phone mode is on: lines go to your phone. Turn it off to play them on the Mac again'
    : "Send voice lines to your phone and release the Mac's mic (starts the phone bridge)";
  const buttons = [
    voice?.status === 'paused' &&
      html`<button type="button" data-voice-pause="resume" title="Resume voice (removes ~/.larmor/paused, as the menu bar does)">Resume</button>`,
    phone &&
      html`<button type="button"${phoneBusy && html` disabled`} data-voice-phone="${phone.on ? 'off' : 'on'}" title="${phoneModeTitle}">${phone.on ? 'Turn off phone mode' : 'Turn on phone mode'}</button>`,
    phone &&
      phone.bridge &&
      html`<button type="button"${phoneBusy && html` disabled`} data-voice-phone="bridge-stop" title="Stop the phone bridge (also turns phone mode off)">Stop phone bridge</button>`,
  ].filter(Boolean);
  return buttons.length > 0
    ? html`<div class="ou-local-top-voice ou-board-voice-phone" role="group" aria-label="Voice controls">${buttons}</div>`
    : '';
}

/** "3h", "5m" since an ISO time, for the Listeners lane. */
const since = (iso: string | null, now: number) => (iso ? compactAge(iso, now) : '');

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
    worktrees: data.worktrees && {
      ...data.worktrees,
      items: data.worktrees.items.filter((tree) => tree.lane === laneFilter),
    },
  };
}

/** The Worktrees lane: every worktree tied to no card, by repo, the ones Clean up is offered for first. */
function worktreesHtml(trees: NonNullable<BoardData['worktrees']>, now: number) {
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

/** Hands the voice panel (a Preact component) the poll's voice session; Preact works out what changed. */
function showVoice(voice: BoardVoice | null) {
  mountVoice(voiceHost, {
    voice,
    root: app,
    pause: (paused) => bridge.ask(ROUTES.boardVoicePause, { body: { paused } }),
    onChanged: refresh,
    onFocus: (session) => focusSession(session, null),
  });
}

function render(full: BoardData) {
  board = full;
  showVoice(full.voice);
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
    ...(count('ship') ? [`${count('ship')} ready to ship`] : []),
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
      ${usageHtml(data.usage, now)}
      <button type="button" data-board-filter aria-haspopup="menu" title="Narrow the whole board to one repo's lane">Repo: ${filterOn ? laneFilter : 'All'} ▾</button>
      ${voiceHeaderHtml(data.voice, data.phone)}
    </header>
    ${data.warning && html`<p class="ou-board-warning">${data.warning}</p>`}
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
      ${data.worktrees && worktreesHtml(data.worktrees, now)}
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
    setHtml(main, markup);
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

/** Polls that failed in a row: the voice panel keeps its place (a peek, a drag) through one blip and goes after a second. */
let failedPolls = 0;

async function refresh() {
  try {
    render(await bridge.ask(ROUTES.board));
    failedPolls = 0;
  } catch (err) {
    last = '';
    failedPolls++;
    // refused for want of a key: say how to connect (the poll fills the board in once there is a cookie)
    const refused = [401, 403].includes((err as { status?: number }).status ?? 0);
    if (failedPolls >= 2) {
      showVoice(null);
    }
    setHtml(
      main,
      refused
        ? notConnectedHtml()
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
    await bridge.ask(ROUTES.boardFocus, { body: { session } });
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
    board?.lanes
      .flatMap((lane) => lane.cards.flatMap((card) => card.backlog?.assign?.candidates ?? []))
      .find((one) => one.id === session)?.title ??
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
    await bridge.ask(ROUTES.boardType, {
      body: { kind, session, ...(repo ? { repo } : {}) },
    });
    last = '';
    await refresh();
  } catch (err) {
    alert(`Couldn't type into the session: ${(err as Error).message}`);
  }
}

/** Asks first, then has the bridge type the item's start line into the session (the bridge builds it; the page sends two ids). */
async function assignInto(id: string, session: string, line: string) {
  if (!window.confirm(`Type this into "${titleOf(session)}" and press Enter?\n\n${line}`)) {
    return;
  }
  try {
    await bridge.ask(ROUTES.boardBacklogAssign, { body: { id, session } });
    last = '';
    await refresh();
  } catch (err) {
    alert(`Couldn't assign it: ${(err as Error).message}`);
  }
}

/** The worktree with this path, from the last data: on a card or in the lane. */
const worktreeAt = (dir: string): BoardWorktree | undefined =>
  [
    ...(board?.lanes.flatMap((lane) => lane.cards.flatMap((card) => card.worktrees ?? [])) ?? []),
    ...(board?.worktrees?.items ?? []),
  ].find((tree) => tree.path === dir);

/**
 * Clean up: asks first (the confirm says what goes and what stays, and that the work is only superseded when it is), then
 * has the bridge remove it. The bridge looks again itself and refuses what it should not remove; the page sends the
 * path, and "superseded" and "ignored-files" (with the names) when its confirm said so.
 */
async function cleanUp(button: HTMLButtonElement) {
  const dir = button.getAttribute('data-worktree-clean') || '';
  const tree = worktreeAt(dir);
  if (!tree || !window.confirm(cleanupConfirm(tree))) {
    return;
  }
  button.disabled = true;
  button.textContent = 'Removing…';
  document.body.style.cursor = 'progress';
  try {
    const done = await bridge.ask(ROUTES.boardWorktreeClean, {
      body: {
        path: dir,
        ack: [
          ...(tree.verdict === 'superseded' ? ['superseded'] : []),
          ...(tree.ignored.length ? ['ignored-files'] : []),
        ],
        ignored: tree.ignored,
      },
    });
    if (done.branch || done.note) {
      alert(
        done.branch
          ? `Removed. The branch ${done.branch.name} was deleted. To bring it back:\n${done.branch.restore}`
          : `Removed. ${done.note}`,
      );
    }
  } catch (err) {
    alert(`Not cleaned up: ${(err as Error).message}`);
  } finally {
    document.body.style.cursor = '';
    last = '';
    await refresh();
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
function placeAmong(
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

async function moveBacklog(id: string, where: { before: string } | { edge: 'top' | 'bottom' }) {
  try {
    await bridge.ask(ROUTES.boardBacklogMove, { body: { id, ...where } });
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
function dropTarget(event: DragEvent): {
  card: HTMLElement;
  after: boolean;
  where: { before: string } | { edge: 'top' | 'bottom' };
} | null {
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
    await bridge.ask(ROUTES.boardBacklogAdd, { body: item });
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
    remember(COLLAPSED_KEY, JSON.stringify([...collapsed]));
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
        remember(FILTER_KEY, value);
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
  const treesToggle = clicked.closest('[data-trees-toggle]');
  if (treesToggle) {
    treesOpen = !treesOpen;
    remember(TREES_KEY, String(treesOpen));
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
  const clean = clicked.closest<HTMLButtonElement>('[data-worktree-clean]');
  if (clean && !clean.disabled) {
    await cleanUp(clean);
    return;
  }
  const drop = clicked.closest('[data-backlog-drop]');
  if (drop) {
    try {
      await bridge.ask(ROUTES.boardBacklogDrop, {
        body: { id: drop.getAttribute('data-backlog-drop') ?? '' },
      });
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
  const assign = clicked.closest('[data-backlog-assign]');
  if (assign && !assign.hasAttribute('disabled')) {
    const id = assign.getAttribute('data-backlog-assign') || '';
    const offer = board?.lanes.flatMap((lane) => lane.cards).find((one) => one.backlog?.id === id)
      ?.backlog?.assign;
    const candidates = offer?.candidates ?? [];
    // one obvious session (the only one, a blank one, or clearly the freshest): use it; else a menu, blank ones first
    const obvious = assignObvious(candidates);
    if (offer && (obvious || candidates.length === 1)) {
      await assignInto(id, (obvious ?? candidates[0]).id, offer.prompt);
    } else if (offer && candidates.length) {
      openMenu(
        assign as HTMLElement,
        candidates.map((one) => ({
          value: one.id,
          label: one.title,
          detail: `${one.blank ? 'new' : one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''}${one.branch ? ` · ${one.branch}` : ''}${one.repo ? ` · ${one.repo}` : ''}`,
        })),
        (session) => void assignInto(id, session, offer.prompt),
        { label: 'Sessions to hand it to' },
      );
    }
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
          detail: `${one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${repo}`,
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
        await bridge.ask(ROUTES.boardStopListening, { body: { repo } });
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
      await bridge.ask(ROUTES.boardReviewed, {
        body: { story: markLocal.getAttribute('data-mark-local') ?? '' },
      });
      last = '';
      await refresh();
    } catch (err) {
      alert(`Couldn't mark it reviewed: ${(err as Error).message}`);
    }
    return;
  }
  const pushLocal = clicked.closest('[data-push-local]');
  if (pushLocal) {
    try {
      const { url } = await bridge.ask(ROUTES.boardOpenStory, {
        body: { story: pushLocal.getAttribute('data-push-local') ?? '' },
      });
      window.open(`${url}&push=1`, '_blank', 'noopener'); // the story's page opens its Push box
    } catch (err) {
      alert(`Couldn't open the story: ${(err as Error).message}`);
    }
    return;
  }
  const openLocal = clicked.closest('[data-open-local]');
  if (openLocal) {
    try {
      const { url } = await bridge.ask(ROUTES.boardOpenStory, {
        body: { story: openLocal.getAttribute('data-open-local') ?? '' },
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
          detail: `blank${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${name}`,
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
    remember(ON_AUTHOR_KEY, String(hideOnAuthor));
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
  const voicePause = clicked.closest<HTMLElement>('[data-voice-pause]');
  if (voicePause) {
    const pause = voicePause.getAttribute('data-voice-pause') === 'pause';
    voicePause.setAttribute('disabled', '');
    try {
      await bridge.ask(ROUTES.boardVoicePause, { body: { paused: pause } });
    } catch (err) {
      alert(`Couldn't ${pause ? 'pause' : 'resume'} voice: ${(err as Error).message}`);
    }
    last = '';
    await refresh();
    return;
  }
  const voicePhone = clicked.closest<HTMLElement>('[data-voice-phone]');
  if (voicePhone) {
    const action = voicePhone.getAttribute('data-voice-phone');
    if (phoneBusy) {
      return;
    }
    phoneBusy = true;
    // the row's buttons all wait while Larmor works: turning on can take several seconds (it waits for the bridge)
    voicePhone
      .closest('.ou-board-voice-phone')
      ?.querySelectorAll('button')
      .forEach((one) => one.setAttribute('disabled', ''));
    try {
      if (action === 'bridge-stop') {
        await bridge.ask(ROUTES.boardVoiceBridgeStop);
      } else {
        await bridge.ask(ROUTES.boardVoicePhone, { body: { on: action === 'on' } });
      }
    } catch (err) {
      alert(
        `Couldn't ${action === 'bridge-stop' ? 'stop the phone bridge' : `turn phone mode ${action}`}: ${(err as Error).message}`,
      );
    } finally {
      phoneBusy = false;
    }
    last = '';
    await refresh();
    return;
  }
  if (clicked.closest('[data-idle-toggle]')) {
    idleOpen = !idleOpen;
    remember(IDLE_KEY, String(idleOpen));
    if (board) {
      last = '';
      render(board);
    }
    return;
  }
});

refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
window.addEventListener('focus', refresh);
