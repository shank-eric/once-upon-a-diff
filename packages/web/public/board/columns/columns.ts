/*
 * The board's columns, drawn by Preact (ADR-14): the two groups of columns, each column's heading and its lanes of cards, the
 * Done and Idle lanes, the Blank strip and the Listeners lane. A card's clicks are on the card's own buttons. The Backlog
 * column's cards, its + Add button and its drag and drop belong to the backlog region, which the board root hands in as
 * `renderCard` and `slots`, since a region imports no other region.
 */
import { html } from '/assets/preact.mjs';
import { ROUTES } from '/assets/protocol/routes.ts';
import { openMenu } from '/assets/local/menu.ts';
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
import { gateText, plural } from '/assets/util/text.ts';
import {
  ago,
  CardTrees,
  FocusButton,
  isTouch,
  Meter,
  SessionLink,
  since,
  titleOf,
  useFocus,
  type Api,
} from '/assets/board/shared.ts';
import { answerBits } from '/assets/util/story-answers.ts';
import { freshestFirst, obviousChoice } from '/assets/util/choice.ts';

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

/** Someone else's PR with nothing on you and no session of yours on it: the ball is in its author's court. */
export const isOnAuthor = (card: BoardCard) =>
  card.column === 'pr_open' && !!card.pr && !card.pr.mine && !card.sessions.length;

/**
 * Sorts the board's data into what the page shows: the cards that are not hidden, the columns that have a reason to appear
 * (the always-on ones and those with a card), each column's lanes of cards, and the Done and Idle lanes. Pure, so it is
 * the one place the page's counts come from.
 */
export function arrange(data: BoardData, hideOnAuthor: boolean, now: number) {
  const shown = (card: BoardCard) => !(hideOnAuthor && isOnAuthor(card));
  const all = data.lanes.flatMap((lane) => lane.cards);
  const cards = all.filter(shown);
  const columns = COLUMNS.filter(
    (column) => column.always || cards.some((card) => card.column === column.id),
  );
  const count = (id: BoardColumn) => cards.filter((card) => card.column === id).length;
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
  return {
    cards,
    columns,
    count,
    onAuthorCount: all.filter(isOnAuthor).length,
    // a column lists its cards by lane, the lane's label right above its cards (so the two are never far apart)
    lanesOf: (column: BoardColumn) =>
      data.lanes
        .map((lane) => ({
          name: lane.name,
          cards: lane.cards
            .filter((card) => card.column === column && shown(card))
            // Backlog keeps the order you gave it; the others go by how long they have been there
            .sort((first, second) =>
              column === 'backlog' ? 0 : String(first.since).localeCompare(String(second.since)),
            ),
        }))
        .filter((group) => group.cards.length),
    // Done: finished lately, its context still cached, so picking it up is cheap; Idle: it would re-read everything
    done: idle.filter((item) => isWarm(item.card, now)),
    cold: idle.filter((item) => !isWarm(item.card, now)),
    blankCount: data.blank.reduce((sum, group) => sum + group.sessions.length, 0),
  };
}

export type Layout = ReturnType<typeof arrange>;

/** A session's context meter. */
function Context(props: { context: number | null | undefined }) {
  const { context } = props;
  return typeof context === 'number'
    ? html` <${Meter} label="ctx" percent=${context} title=${`The session's context window is ${Math.round(context)}% full`} />`
    : null;
}

function Agent(props: { agent: BoardAgent; now: number }) {
  const { agent, now } = props;
  const beat = agent.beat;
  const note =
    beat && agent.state === 'running' ? `${beat.n}/${beat.of} ${beat.step}` : stateNote(agent);
  const percent = beat ? Math.min(100, Math.round((beat.n / Math.max(1, beat.of)) * 100)) : 0;
  const detail = agent.state === 'running' ? beat?.note || agent.task : agent.outcome || agent.task;
  const time = compactAge(agent.ended_at || agent.started_at, now);
  return html`<li class=${`ou-board-agent ou-board-s-${agent.status}`} title=${agent.task || ''}>
    <div class="ou-board-agent-line"><span class="ou-board-mark" aria-hidden="true">${agentMark(agent)}</span> <strong>${agent.name}</strong>${' '}
      <span class="ou-local-muted">${note}${agent.stale && ' (no done line yet)'}${time && ` · ${time}`}</span></div>
    ${beat && agent.state === 'running' && html`<div class="ou-board-bar" aria-hidden="true"><span style=${`width:${percent}%`}></span></div>`}
    ${detail && html`<div class="ou-board-agent-note ou-local-muted">${detail}</div>`}
  </li>`;
}

function Session(props: { session: BoardSession; now: number }) {
  const { session, now } = props;
  const time = compactAge(session.since, now);
  return html`<li class=${`ou-board-session ou-board-s-${session.status}`} title=${session.cwd}>
    <span class="ou-board-mark" aria-hidden="true">●</span> <strong>${session.title}</strong> <span class="ou-local-muted">${session.status}${time && ` · ${time}`}</span><${Context} context=${session.context} />
    ${session.detail && html`<div class="ou-board-agent-note ou-local-muted">${session.detail}</div>`}
  </li>`;
}

/** An agent card's "from <parent session>": a link that brings the parent's iTerm tab forward when it can. */
function From(props: { card: BoardCard; api: Api }) {
  const { card, api } = props;
  if (!card.parent) {
    return 'its session has ended';
  }
  return card.can_focus && card.focus_session
    ? html`from <${FocusButton} bridge=${api.bridge} session=${card.focus_session} class="ou-board-from" title="Bring the parent session's iTerm tab to the front">${card.parent}</${FocusButton}>`
    : html`from ${card.parent}`;
}

/** "listening: <session>" on a story's card: its own listener, linked to the session when its tab is known. */
function Listening(props: { listening: NonNullable<BoardCard['listening']>; api: Api }) {
  const { listening, api } = props;
  return html`<div class="ou-local-muted ou-board-listening">listening: <${SessionLink} bridge=${api.bridge} session=${listening.session} canFocus=${listening.can_focus} name=${listening.title || listening.consumer} title="Bring the listening session's iTerm tab to the front" /></div>`;
}

/** Asks first, then has the bridge type the line into the session's tab (it refuses a session that is busy). */
async function typeInto(
  api: Api,
  kind: 'build' | 'listen',
  session: string,
  line: string,
  repo: string | null,
) {
  if (
    !window.confirm(`Type this into "${titleOf(api.board, session)}" and press Enter?\n\n${line}`)
  ) {
    return;
  }
  try {
    await api.bridge.ask(ROUTES.boardType, {
      body: { kind, session, ...(repo ? { repo } : {}) },
    });
    await api.refresh();
  } catch (err) {
    alert(`Couldn't type into the session: ${(err as Error).message}`);
  }
}

/** Runs a bridge call for a card's button, says why when it fails, and polls again when it worked. */
async function act(what: string, call: () => Promise<unknown>, api?: Api) {
  try {
    await call();
    await api?.refresh();
  } catch (err) {
    alert(`Couldn't ${what}: ${(err as Error).message}`);
  }
}

/** Opens a local story's page in a tab (the bridge makes the link), with the Push box open when `push`. */
const openStory = (api: Api, story: string, push: boolean) =>
  act('open the story', async () => {
    const { url } = await api.bridge.ask(ROUTES.boardOpenStory, { body: { story } });
    window.open(push ? `${url}&push=1` : url, '_blank', 'noopener');
  });

/** Build story: types the skill's command into an idle session of the card (the bridge picks it and says why when none is). */
function Build(props: { card: BoardCard; api: Api }) {
  const { card, api } = props;
  const build = card.build as NonNullable<BoardCard['build']>;
  const label = build.blocked ? `Build story (${build.blocked})` : 'Build story';
  const title = build.blocked || `Types ${build.prompt} into the session`;
  const run = () => {
    if (build.session) {
      void typeInto(api, 'build', build.session, build.prompt, null);
    }
  };
  return html`<button type="button" class="ou-board-build" data-build=${build.session} data-prompt=${build.prompt} disabled=${!!build.blocked} onClick=${run} title=${title}>${label}</button>`;
}

/** A card other than a Backlog item: its title, where it is, what is going on, its sessions and agents, and its buttons. */
export function Card(props: { card: BoardCard; now: number; api: Api }) {
  const { card, now, api } = props;
  const { switching, focus } = useFocus(api.bridge);
  const pr = card.pr;
  const time = compactAge(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? card.repo.split('/')[1] : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink = pr && html`<a href=${pr.url} target="_blank" rel="noopener">PR #${pr.number}</a>`;
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
    const building = compactAge(card.building.since, now);
    notes.push(
      `${BUILDING_TEXT[card.building.kind]}${card.building.by ? ` (${card.building.by})` : ''}${building && ` · ${building}`}`,
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
  // a click on the card itself (not on one of its links or buttons) raises the session's tab; on a touch screen there is no tab to raise
  const onCard = (event: MouseEvent) => {
    if (
      card.can_focus &&
      card.focus_session &&
      !(event.target as Element).closest('a, button') &&
      !isTouch()
    ) {
      void focus(card.focus_session);
    }
  };
  const story = card.story;
  return html`<li class=${`ou-board-card ou-board-c-${card.column}${card.can_focus ? ' ou-board-clickable' : ''}`} data-card=${card.id} data-focus-card=${card.can_focus ? card.focus_session : ''} onClick=${onCard}>
    <div class="ou-board-title" title=${card.title}>${card.title}</div>
    ${card.kind === 'agent' && html`<div class="ou-local-muted ou-board-meta"><${From} card=${card} api=${api} /></div>`}
    <div class="ou-local-muted ou-board-meta">${prLink}${prLink && where && ' · '}${where}${(prLink || where) && (merged || time) && ' · '}${merged || time}</div>
    ${notes.map((note) => html`<div class="ou-board-detail">${note}</div>`)}
    ${card.listening && html`<${Listening} listening=${card.listening} api=${api} />`}
    ${card.kind === 'session' && card.detail && html`<div class="ou-board-detail">${card.detail}</div>`}
    ${gates.length > 0 && html`<div class="ou-board-chips ou-board-gates">${gates.map((text) => html`<span class="ou-board-chip">${text}</span>`)}</div>`}
    ${chips.length > 0 && html`<div class="ou-board-chips">${chips.map((chip) => html`<span class="ou-board-chip">${CHIP_MARK[chip.tone]}${chip.text}</span>`)}</div>`}
    ${card.kind === 'session' && card.sessions[0] && html`<div class="ou-local-muted">${card.sessions[0].status}${card.sessions[0].branch ? ` on ${card.sessions[0].branch}` : ''}</div>`}
    ${card.kind === 'work' && card.sessions.length > 0 && html`<ul class="ou-board-sessions">${card.sessions.map((session) => html`<${Session} key=${session.id} session=${session} now=${now} />`)}</ul>`}
    ${card.agents.length > 0 && html`<ul class="ou-board-agents">${card.agents.map((agent) => html`<${Agent} key=${agent.name} agent=${agent} now=${now} />`)}</ul>`}
    <${CardTrees} card=${card} now=${now} api=${api} />
    <div class="ou-board-actions">
      ${card.build && html`<${Build} card=${card} api=${api} />`}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus=${card.focus_session} disabled=${!card.can_focus || switching} onClick=${() => focus(card.focus_session as string)} title=${focusTitle}>${switching ? 'Switching…' : 'Open in iTerm'}</button>`}
      ${card.column === 'ship' && story?.ship === 'push' && html`<button type="button" class="ou-board-push" data-push-local=${story.id} onClick=${() => openStory(api, story.id, true)} title="Opens the story's Push box, which checks GitHub first">Push</button>`}
      ${card.ahead && html`<button type="button" class="ou-board-push" data-push-local=${card.ahead.story} onClick=${() => openStory(api, (card.ahead as { story: string }).story, true)} title=${`Opens the story's Push box: the branch is ${card.ahead.count} ahead of GitHub, where this PR is open`}>Push</button>`}
      ${openable && story?.url && html`<a class="ou-board-open" href=${`${story.url}${bits.hash}`} target="_blank" rel="noopener">Open story</a>`}
      ${openable && story && !story.url && html`<button type="button" class="ou-board-open" data-open-local=${story.id} onClick=${() => openStory(api, story.id, false)} title="Opens the local story's page">Open story</button>`}
      ${markable && story && html`<button type="button" data-mark-local=${story.id} onClick=${() => act('mark it reviewed', () => api.bridge.ask(ROUTES.boardReviewed, { body: { story: story.id } }), api)} title="Done with this story: it leaves Ready for your review">Mark reviewed</button>`}
    </div>
  </li>`;
}

/** One place's chip in the Blank strip: a session's tab to the front, or for several in one place a menu of them. */
function BlankChip(props: { group: { name: string; sessions: BoardBlankSession[] }; api: Api }) {
  const { group, api } = props;
  const { focus } = useFocus(api.bridge);
  const tabs = group.sessions.filter((session) => session.can_focus);
  const many = group.sessions.length > 1;
  const label = many ? `${group.name} ×${group.sessions.length}` : group.name;
  if (!tabs.length) {
    return html`<span class="ou-board-chip ou-board-blank-chip" title=${`No iTerm tab is known for ${many ? 'these sessions' : 'this session'}`}>${label}</span>`;
  }
  if (!many) {
    return html`<${FocusButton} bridge=${api.bridge} session=${tabs[0].id} class="ou-board-chip ou-board-blank-chip" title="Bring this blank session's iTerm tab to the front">${label}</${FocusButton}>`;
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
  return html`<button type="button" class="ou-board-chip ou-board-blank-chip" data-blank-group=${group.name} aria-haspopup="menu" aria-expanded="false" onClick=${choose} title=${`Choose a blank session in ${group.name}`}>${label}</button>`;
}

/** The Blank strip at the bottom of the Idle lane: sessions that have had no prompt yet, one chip per place. */
function Blank(props: { blank: BoardData['blank']; count: number; api: Api }) {
  const { blank, count, api } = props;
  return html`<div class="ou-board-blank" role="group" aria-label="Blank sessions"><strong>Blank</strong> <span class="ou-local-muted">${count}</span>${blank.map((group) => html`<${BlankChip} key=${group.name} group=${group} api=${api} />`)}<span class="ou-local-muted">no prompt yet</span></div>`;
}

/** One listener row: who listens (with Stop), or when it last did (with Start). */
function Listener(props: { entry: BoardListenerRepo; now: number; api: Api }) {
  const { entry, now, api } = props;
  const active = entry.active;
  if (active) {
    const parts = [
      active.since && `for ${since(active.since, now)}`,
      active.last_handled_at
        ? `last request ${since(active.last_handled_at, now)} ago`
        : 'no request yet',
      active.state === 'handling' && 'handling one now',
    ].filter(Boolean);
    const stop = async () => {
      if (
        window.confirm(
          `Stop listening for ${entry.repo}? Its session's wait ends within a couple of seconds.`,
        )
      ) {
        await act(
          'stop it',
          () => api.bridge.ask(ROUTES.boardStopListening, { body: { repo: entry.repo } }),
          api,
        );
      }
    };
    return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-board-voice-status">Listening</span> <span class="ou-local-muted"><${SessionLink} bridge=${api.bridge} session=${active.session} canFocus=${active.can_focus} name=${active.title || active.consumer} title="Bring the listening session to the front" /> · ${parts.join(' · ')}</span>${' '}
      <button type="button" data-stop-listening=${entry.repo} onClick=${stop}>Stop listening</button></li>`;
  }
  const seen = entry.last_seen ? ` · last listened ${since(entry.last_seen, now)} ago` : '';
  // several idle sessions and no obvious one: the button opens a menu to pick from
  const choosing = entry.candidates.length > 1 && !obviousChoice(entry.candidates);
  let title = 'No idle session in this repo has an iTerm tab';
  if (entry.candidates.length) {
    title = choosing
      ? 'Choose an idle session in the repo to type /once-upon-listen into'
      : `Types /once-upon-listen ${entry.repo} into an idle session in the repo`;
  }
  const start = (event: MouseEvent) => {
    const candidates = entry.candidates;
    // one obvious session (the only one, or clearly the freshest): use it; else a menu of them, freshest first
    const obvious = obviousChoice(candidates);
    const line = `/once-upon-listen ${entry.repo}`;
    if (obvious || candidates.length === 1) {
      void typeInto(api, 'listen', (obvious ?? candidates[0]).id, line, entry.repo);
    } else if (candidates.length) {
      openMenu(
        event.currentTarget as HTMLElement,
        freshestFirst(candidates).map((one) => ({
          value: one.id,
          label: one.title,
          detail: `${one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${entry.repo}`,
        })),
        (id) => void typeInto(api, 'listen', id, line, entry.repo),
        { label: `Sessions in ${entry.repo}` },
      );
    }
  };
  return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-local-muted">not listening${seen}</span>${' '}
    <button type="button" data-start-listening=${entry.repo} disabled=${!entry.candidates.length} ...${choosing ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}} onClick=${start} title=${title}>Start listening${choosing && ' ▾'}</button></li>`;
}

/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
export function Listeners(props: { repos: BoardListenerRepo[]; now: number; api: Api }) {
  const { repos, now, api } = props;
  if (!repos.length) {
    return null;
  }
  return html`<section class="ou-board-listeners" aria-label="Listeners"><h2 class="ou-board-head">Listeners <span class="ou-local-muted">${repos.filter((entry) => entry.active).length}</span></h2><ul>${repos.map((entry) => html`<${Listener} key=${entry.repo} entry=${entry} now=${now} api=${api} />`)}</ul></section>`;
}

/** What the Backlog column gets from the backlog region: its + Add button and Add panel, and the drag handlers for its lanes' lists. */
export type ColumnSlots = {
  head?: unknown;
  form?: unknown;
  listProps?: Record<string, unknown>;
};

export type ColumnsView = {
  layout: Layout;
  now: number;
  api: Api;
  /** The folds of repo headings, as "<column>/<heading>", and a way to flip one. */
  collapsed: ReadonlySet<string>;
  onFold: (id: string) => void;
  hideOnAuthor: boolean;
  onToggleAuthors: () => void;
  idleOpen: boolean;
  onToggleIdle: () => void;
  /** The Blank strip's sessions, by repo (narrowed to the repo filter's lane). */
  blank: BoardData['blank'];
  /** Draws a card, with its key (the page picks the backlog region's view for a Backlog item). */
  renderCard: (card: BoardCard) => unknown;
  slots: Partial<Record<BoardColumn, ColumnSlots>>;
};

/** A repo heading in a column, with the toggle that folds its cards (and the count shown while they are folded). */
function LaneHead(props: {
  column: { id: BoardColumn; label: string };
  name: string;
  total: number;
  folded: boolean;
  onFold: (id: string) => void;
}) {
  const { column, name, total, folded, onFold } = props;
  const verb = folded ? 'Show' : 'Hide';
  const id = `${column.id}/${name}`;
  return html`<h3 class="ou-board-lane-label">
    <button type="button" class="ou-board-lane-toggle" data-lane-toggle=${id} aria-expanded=${String(!folded)} onClick=${() => onFold(id)}
      aria-label=${`${verb} ${name} cards in ${column.label}`} title=${`${verb} the ${name} cards`}><span aria-hidden="true">${folded ? '▸' : '▾'}</span> ${name}${folded && html` <span class="ou-board-lane-count">${total}</span>`}</button></h3>`;
}

function Column(props: { column: (typeof COLUMNS)[number]; view: ColumnsView }) {
  const { column, view } = props;
  const { layout, collapsed, hideOnAuthor } = view;
  const total = layout.count(column.id);
  const slot = view.slots[column.id] ?? {};
  const authors = column.id === 'pr_open' && layout.onAuthorCount > 0;
  return html`<section class=${`ou-board-col ou-board-c-${column.id}${total ? '' : ' ou-board-empty'}`} aria-label=${column.label}>
    <h2 class="ou-board-head">${column.label} <span class="ou-local-muted">${total}</span>${slot.head}${authors && html` <button type="button" data-on-author-toggle aria-pressed=${String(hideOnAuthor)} onClick=${view.onToggleAuthors} title="Others' PRs with nothing on you: the ball is in the author's court">${hideOnAuthor ? 'Show' : 'Hide'} ${layout.onAuthorCount} on their author</button>`}</h2>
    ${slot.form}
    ${layout.lanesOf(column.id).map((group) => {
      const folded = collapsed.has(`${column.id}/${group.name}`);
      return html`<div class="ou-board-lane" key=${group.name}><${LaneHead} column=${column} name=${group.name} total=${group.cards.length} folded=${folded} onFold=${view.onFold} />${!folded && html`<ul class="ou-board-cards" ...${slot.listProps ?? {}}>${group.cards.map((card) => view.renderCard(card))}</ul>`}</div>`;
    })}
  </section>`;
}

/** One of the two groups of columns, headed by where its work is. */
function Group(props: { group: (typeof GROUPS)[number]; view: ColumnsView }) {
  const { group, view } = props;
  const columns = view.layout.columns.filter((column) => column.group === group.id);
  return html`<div class="ou-board-group" style=${`--cols:${columns.length}`}>
    <h2 class="ou-board-group-label">${group.label}</h2>
    <div class="ou-board-cols">${columns.map((column) => html`<${Column} key=${column.id} column=${column} view=${view} />`)}</div>
  </div>`;
}

function IdleRow(props: { items: { lane: string; card: BoardCard }[]; view: ColumnsView }) {
  return html`<ul class="ou-board-idle-row">${props.items.map((item) => html`<li class="ou-board-idle-cell" key=${item.card.id}><h3 class="ou-board-lane-label">${item.lane}</h3><ul class="ou-board-cards">${props.view.renderCard(item.card)}</ul></li>`)}</ul>`;
}

/** The columns in their two groups, then the Done and Idle lanes (with the Blank strip). */
export function Columns(props: { view: ColumnsView }) {
  const { view } = props;
  const { layout, api, idleOpen } = view;
  const { cards, done, cold, blankCount } = layout;
  const toggle =
    cold.length > 0
      ? html`<button type="button" data-idle-toggle aria-expanded=${String(idleOpen)} onClick=${view.onToggleIdle}>${idleOpen ? 'Hide' : 'Show'}</button>`
      : null;
  return html`<div class="ou-board-groups">${GROUPS.map((group) => html`<${Group} key=${group.id} group=${group} view=${view} />`)}</div>
    ${!cards.length && blankCount === 0 && html`<p class="ou-local-muted">No Claude Code sessions are running, and no PRs are waiting.</p>`}
    ${
      done.length > 0 &&
      html`<section class="ou-board-idle ou-board-c-done-idle" aria-label="Done">
      <h2 class="ou-board-head">Done <span class="ou-local-muted">${done.length}</span> <span class="ou-local-muted ou-board-head-note">context still cached</span></h2>
      <${IdleRow} items=${done} view=${view} />
    </section>`
    }
    ${
      (cold.length > 0 || blankCount > 0) &&
      html`<section class="ou-board-idle ou-board-c-idle" aria-label="Idle">
      <h2 class="ou-board-head">Idle <span class="ou-local-muted">${cold.length + blankCount}</span> ${toggle}</h2>
      ${idleOpen && cold.length > 0 && html`<${IdleRow} items=${cold} view=${view} />`}
      ${blankCount > 0 && html`<${Blank} blank=${view.blank} count=${blankCount} api=${api} />`}
    </section>`
    }`;
}
