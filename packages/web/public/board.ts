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
import { mountVoice } from '/assets/board/voice/voice-panel.ts';
import { freshestFirst, obviousChoice } from '/assets/util/choice.ts';
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { plural } from '/assets/util/text.ts';
import { compactAge } from '/assets/util/time.ts';
import { cleanupConfirm } from '/assets/util/worktree-text.ts';
import type {
  BoardCard,
  BoardColumn,
  BoardData,
  BoardVoice,
  BoardWorktree,
} from '/assets/types.ts';

import {
  COLUMNS,
  GROUPS,
  blankHtml,
  cardHtml,
  columnHead,
  groupHtml,
  isWarm,
  laneHead,
  listenersHtml,
} from '/assets/board/columns/columns.ts';
import {
  addFormHtml,
  assignObvious,
  backlogHtml,
  backlogLane,
  placeAmong,
} from '/assets/board/backlog/backlog.ts';
import { usageHtml, voiceHeaderHtml } from '/assets/board/header/header.ts';
import { worktreesHtml } from '/assets/board/worktrees/worktrees.ts';

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

/** A card as its column draws it: a Backlog item has its own view, the others share the session card's. */
const cardView = (card: BoardCard, now: number) =>
  card.kind === 'backlog' ? backlogHtml(card, now) : cardHtml(card, now);

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
      ${columnHead(column, count(column.id), { addOpen, hideOnAuthor }, onAuthorCount)}
      ${column.id === 'backlog' && addOpen && addFormHtml(addRepo)}
      ${groups.map((group) => {
        const folded = collapsed.has(`${column.id}/${group.name}`);
        return html`<div class="ou-board-lane">${laneHead(column, group.name, group.cards.length, folded)}${!folded && html`<ul class="ou-board-cards">${group.cards.map((card) => cardView(card, now))}</ul>`}</div>`;
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
    html`<ul class="ou-board-idle-row">${items.map((item) => html`<li class="ou-board-idle-cell"><h3 class="ou-board-lane-label">${item.lane}</h3><ul class="ou-board-cards">${cardView(item.card, now)}</ul></li>`)}</ul>`;
  const toggle =
    idle.length > 0
      ? html`<button type="button" data-idle-toggle aria-expanded="${String(idleOpen)}">${idleOpen ? 'Hide' : 'Show'}</button>`
      : '';
  const markup = html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Agent board</h1><div class="ou-local-muted">${summary}</div></div>
      ${usageHtml(data.usage, now)}
      <button type="button" data-board-filter aria-haspopup="menu" title="Narrow the whole board to one repo's lane">Repo: ${filterOn ? laneFilter : 'All'} ▾</button>
      ${voiceHeaderHtml(data.voice, data.phone, phoneBusy)}
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
      ${data.worktrees && worktreesHtml(data.worktrees, now, treesOpen)}
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
  const ids = first ? backlogLane(first, board) : [];
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
    ? placeAmong(backlogLane(first, board), dragId, card.dataset.backlogCard || '', after)
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
