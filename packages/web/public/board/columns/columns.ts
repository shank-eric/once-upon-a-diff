import type {
  BoardAgent,
  BoardBlankSession,
  BoardCard,
  BoardColumn,
  BoardData,
  BoardListenerRepo,
  BoardSession,
  PrInfo,
} from '/assets/types.ts';
import { compactAge } from '/assets/util/time.ts';
import { html, type HtmlValue } from '/assets/util/html.ts';
import { gateText, plural } from '/assets/util/text.ts';
import { ago, cardTrees, meterHtml, sessionLink, since } from '/assets/board/shared.ts';
import { answerBits } from '/assets/util/story-answers.ts';
import { obviousChoice } from '/assets/util/choice.ts';

/**
 * The columns in the order the work moves through them, from Backlog (kept for later) to Done, in two groups: what is still on this Mac and what is on GitHub.
 * Error appears only when a card is in it; idle cards are a lane along the bottom.
 */
export const COLUMNS: {
  id: BoardColumn;
  label: string;
  group: 'local' | 'github';
  always: boolean;
}[] = [
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

export const GROUPS = [
  { id: 'local', label: 'On this Mac' },
  { id: 'github', label: 'On GitHub' },
] as const;

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
export function isWarm(card: BoardCard, now: number): boolean {
  const rested = card.sessions
    .map((session) => (session.rested_at ? Date.parse(session.rested_at) : NaN))
    .filter((time) => !Number.isNaN(time));
  return rested.length > 0 && now - Math.max(...rested) < WARM_MS;
}

/** A session's context meter, or '' when the status line hasn't said. */
function contextHtml(context: number | null | undefined) {
  if (typeof context !== 'number') {
    return '';
  }
  return html` ${meterHtml('ctx', context, `The session's context window is ${Math.round(context)}% full`)}`;
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

export function cardHtml(card: BoardCard, now: number) {
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
export function blankHtml(blank: BoardData['blank']) {
  const count = blank.reduce((sum, group) => sum + group.sessions.length, 0);
  return html`<div class="ou-board-blank" role="group" aria-label="Blank sessions"><strong>Blank</strong> <span class="ou-local-muted">${count}</span>${blank.map((group) => blankChip(group))}<span class="ou-local-muted">no prompt yet</span></div>`;
}

/** One of the two groups of columns, headed by where its work is. */
export function groupHtml(group: (typeof GROUPS)[number], columns: unknown[]) {
  return html`<div class="ou-board-group" style="--cols:${columns.length}">
    <h2 class="ou-board-group-label">${group.label}</h2>
    <div class="ou-board-cols">${columns as HtmlValue[]}</div>
  </div>`;
}

/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
export function listenersHtml(repos: BoardListenerRepo[], now: number) {
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
export function columnHead(
  column: { id: BoardColumn; label: string },
  total: number,
  view: { addOpen: boolean; hideOnAuthor: boolean },
  onAuthorCount = 0,
) {
  const { addOpen, hideOnAuthor } = view;
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
export function laneHead(
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
