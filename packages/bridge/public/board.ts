/*
 * The agent board page: the Claude Code sessions running now, one card each, in a column for where they stand
 * (working, waiting, done; idle and error when there are any) and a lane for their repo, with the background agents
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
  BoardCard,
  BoardColumn,
  BoardData,
  BoardListenerRepo,
  BoardSession,
  BoardVoice,
  PrInfo,
} from '/assets/types.ts';

const POLL_MS = 3000;
const app = document.getElementById('ou-board-app') as HTMLElement;
const KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board/inbox-link');

/**
 * The columns in the order the work moves through them, in two groups: what is still on this Mac and what is on GitHub.
 * Error appears only when a card is in it; idle cards are a lane along the bottom.
 */
const COLUMNS: { id: BoardColumn; label: string; group: 'local' | 'github'; always: boolean }[] = [
  { id: 'working', label: 'Working', group: 'local', always: true },
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

const AGENT_MARK: Record<BoardAgent['state'], string> = {
  running: '●',
  waiting: '?',
  done: '✓',
  failed: '✕',
  stopped: '■',
};

function agentHtml(agent: BoardAgent, now: number) {
  const beat = agent.beat;
  const note =
    beat && agent.state === 'running' ? `${beat.n}/${beat.of} ${beat.step}` : agent.state;
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

function sessionHtml(session: BoardSession, now: number) {
  const time = age(session.since, now);
  return html`<li class="ou-board-session ou-board-s-${session.status}" title="${session.cwd}">
    <span class="ou-board-mark" aria-hidden="true">●</span> <strong>${session.title}</strong> <span class="ou-local-muted">${session.status}${time && ` · ${time}`}</span>
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

function cardHtml(card: BoardCard, now: number) {
  const classes = `${card.can_focus ? ' ou-board-clickable' : ''}`;
  const pr = card.pr;
  const time = age(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? card.repo.split('/')[1] : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink =
    pr && html`<a href="${pr.url}" target="_blank" rel="noopener">PR #${pr.number}</a>`;
  const merged = pr?.state === 'merged' && time ? `merged ${time} ago` : '';
  const chips = pr ? prChips(pr) : [];
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
    ${chips.length > 0 && html`<div class="ou-board-chips">${chips.map((chip) => html`<span class="ou-board-chip">${CHIP_MARK[chip.tone]}${chip.text}</span>`)}</div>`}
    ${card.kind === 'session' && card.sessions[0] && html`<div class="ou-local-muted">${card.sessions[0].status}${card.sessions[0].branch ? ` on ${card.sessions[0].branch}` : ''}</div>`}
    ${list}
    ${card.agents.length > 0 && html`<ul class="ou-board-agents">${card.agents.map((agent) => agentHtml(agent, now))}</ul>`}
    <div class="ou-board-actions">
      ${card.build && buildHtml(card)}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus="${card.focus_session}"${!card.can_focus && html` disabled`} title="${focusTitle}">Open in iTerm</button>`}
      ${card.column === 'ready' && card.story && html`<a class="ou-board-open" href="${card.story.url}" target="_blank" rel="noopener">Open story</a>`}
      ${card.inbox && html`<button type="button" data-inbox data-repo="${card.inbox.repo}" title="${inboxTitle(card.inbox)}">${card.inbox.stories} to review</button>`}
    </div>
  </li>`;
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
    <span class="ou-local-muted">${agents ? `agents: ${agents}` : 'no agents running'}</span>
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

function render(data: BoardData) {
  board = data;
  const now = Date.now();
  const cards = data.lanes.flatMap((lane) => lane.cards);
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
  const count = (id: BoardColumn) => cards.filter((card) => card.column === id).length;
  // a column lists its cards by lane, the lane's label right above its cards (so the two are never far apart)
  const bodyOf = new Map<string, ReturnType<typeof html>>();
  columns.forEach((column) => {
    const groups = data.lanes
      .map((lane) => ({
        name: lane.name,
        cards: lane.cards
          .filter((card) => card.column === column.id)
          .sort((first, second) => String(first.since).localeCompare(String(second.since))),
      }))
      .filter((group) => group.cards.length);
    bodyOf.set(
      column.id,
      html`<section class="ou-board-col ou-board-c-${column.id}${count(column.id) ? '' : ' ou-board-empty'}" aria-label="${column.label}">
      <h2 class="ou-board-head">${column.label} <span class="ou-local-muted">${count(column.id)}</span></h2>
      ${groups.map((group) => html`<div class="ou-board-lane"><h3 class="ou-board-lane-label">${group.name}</h3><ul class="ou-board-cards">${group.cards.map((card) => cardHtml(card, now))}</ul></div>`)}
    </section>`,
    );
  });
  // what is on you: a question, a story to review, comments to answer
  const onYou = count('waiting') + count('ready') + count('back');
  document.title = onYou ? `(${onYou}) Agent board` : 'Agent board';
  const summary = [
    `${count('working')} working`,
    `${count('waiting')} waiting`,
    `${count('ready')} ready for your review`,
    `${count('back')} back to you`,
    `status from ${data.status_source}`,
  ].join(' · ');
  const markup = html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Agent board</h1><div class="ou-local-muted">${summary}</div></div>
      <button type="button" data-inbox="">Review inbox</button>
    </header>
    ${data.warning && html`<p class="ou-board-warning">${data.warning}</p>`}
    ${data.voice && voiceHtml(data.voice)}
    <main class="ou-board">
      ${
        cards.length
          ? html`<div class="ou-board-groups">${GROUPS.map((group) =>
              groupHtml(
                group,
                inGroup(group.id).map((column) => bodyOf.get(column.id)),
              ),
            )}</div>`
          : html`<p class="ou-local-muted">No Claude Code sessions are running, and no PRs are waiting.</p>`
      }
      ${
        idle.length > 0 &&
        html`<section class="ou-board-idle ou-board-c-idle" aria-label="Idle">
        <h2 class="ou-board-head">Idle <span class="ou-local-muted">${idle.length}</span> <button type="button" data-idle-toggle aria-expanded="${String(idleOpen)}">${idleOpen ? 'Hide' : 'Show'}</button></h2>
        ${idleOpen && html`<ul class="ou-board-idle-row">${idle.map((item) => html`<li class="ou-board-idle-cell"><h3 class="ou-board-lane-label">${item.lane}</h3><ul class="ou-board-cards">${cardHtml(item.card, now)}</ul></li>`)}</ul>`}
      </section>`
      }
      ${listenersHtml(data.listeners, now)}
    </main>`;
  // ages tick on every poll, but the page is only redrawn when its markup changed (a redraw loses a focused button)
  const next = String(markup);
  if (next !== last) {
    last = next;
    setHtml(app, markup);
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

app.addEventListener('click', async (event) => {
  const clicked = event.target as Element;
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
