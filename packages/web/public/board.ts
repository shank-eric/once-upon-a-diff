/*
 * The agent board page: the Claude Code sessions running now, one card each, in a column for where they stand
 * (working, agent checks, waiting, done; idle and error when there are any, and sessions with no prompt yet as a Blank strip) and a lane for their repo, with the background agents
 * inside their parent's card or, when the ledger gave them a lane, on a card in that lane. The data is
 * GET /api/board (src/services/board/board.ts), polled every few seconds. The page's key (the link's #key=, which
 * `once-upon board` prints) reaches the board's routes and nothing else.
 *
 * The page is one Preact tree (ADR-14) drawn into the app element. Its root polls (usePoll) and Preact redraws
 * with keys, so focus, scroll and half-typed text stay. The regions (public/board/<region>) are its components; the page
 * holds what they share: the remembered settings, the bridge and the choice of which view draws a card.
 */
import { html, render, useEffect } from '/assets/preact.mjs';
import { createClient, type Transport } from '/assets/api-client/client.ts';
import { usePoll } from '/assets/api-client/use-poll.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { authHeader, startAuth } from '/assets/local/auth.ts';
import { notConnectedHtml } from '/assets/local/not-connected.ts';
import { focusSession, useSetting, type Api } from '/assets/board/shared.ts';
import { VoicePanel } from '/assets/board/voice/voice-panel.ts';
import type { BoardCard, BoardData } from '/assets/types.ts';

import {
  arrange,
  Card,
  Columns,
  Helpers,
  Listeners,
  type ColumnsView,
} from '/assets/board/columns/columns.ts';
import { BacklogCard, useAddPanel, useBacklogDnd } from '/assets/board/backlog/backlog.ts';
import { sameLaneKey } from '/assets/protocol/domain/lane-key.ts';
import { Header, useVoiceBusy } from '/assets/board/header/header.ts';
import { Worktrees } from '/assets/board/worktrees/worktrees.ts';

const POLL_MS = 3000;
const app = document.getElementById('ou-board-app') as HTMLElement;
const KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board');

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

/** Remembered settings: the Idle and Worktrees lanes' folds, the repo headings' folds, whether PRs waiting on their author are hidden, and the repo filter. */
const isOpen = (text: string) => text !== 'false';
const asText = (value: unknown) => String(value);

/** The worktrees section as the lane filter leaves it: its listed ones, those on its cards, and the counts of both. */
function narrowed(
  trees: NonNullable<BoardData['worktrees']>,
  lanes: BoardData['lanes'],
  laneFilter: string,
): NonNullable<BoardData['worktrees']> {
  const items = trees.items.filter((tree) => sameLaneKey(tree.lane, laneFilter));
  const onCards = lanes
    .filter((lane) => sameLaneKey(lane.key, laneFilter))
    .reduce(
      (sum, lane) =>
        sum + lane.cards.reduce((count, one) => count + (one.worktrees?.length ?? 0), 0),
      0,
    );
  return {
    ...trees,
    items,
    on_cards: onCards,
    removable: items.filter((tree) => tree.removable).length,
    size_kb: items.reduce((sum, tree) => sum + (tree.size_kb ?? 0), 0),
  };
}

/** The board narrowed to the filter's lane: its lanes, blank sessions and listeners (a gone lane means All). */
function filtered(data: BoardData, laneFilter: string): BoardData {
  if (!laneFilter || !data.lanes.some((lane) => sameLaneKey(lane.key, laneFilter))) {
    return data;
  }
  return {
    ...data,
    lanes: data.lanes.filter((lane) => sameLaneKey(lane.key, laneFilter)),
    blank: data.blank.filter((group) => sameLaneKey(group.key, laneFilter)),
    editors: data.editors.filter((editor) => sameLaneKey(editor.lane, laneFilter)),
    listeners: data.listeners.filter((entry) => sameLaneKey(entry.repo, laneFilter)),
    worktrees: data.worktrees && narrowed(data.worktrees, data.lanes, laneFilter),
  };
}

const EMPTY: BoardData = {
  at: '',
  status_source: 'registry',
  warning: null,
  voice: null,
  phone: null,
  voice_start: null,
  editors: [],
  voice_paused: false,
  listeners: [],
  helpers: [],
  blank: [],
  lanes: [],
  worktrees: null,
  usage: null,
};

/** The page: the board as last polled, and what went wrong with the polls since (none when the last one worked). */
function BoardApp() {
  const view = usePoll(() => bridge.ask(ROUTES.board), { everyMs: POLL_MS });
  const { refresh } = view;
  const full = view.data ?? EMPTY;
  const api: Api = { bridge, board: full, refresh };
  const [laneFilter, setLaneFilter] = useSetting('ou-board-filter', '', String, asText);
  const [idleOpen, setIdleOpen] = useSetting('ou-board-idle-open', true, isOpen, asText);
  const [treesOpen, setTreesOpen] = useSetting('ou-board-worktrees-open', true, isOpen, asText);
  const [hideOnAuthor, setHideOnAuthor] = useSetting(
    'ou-board-hide-on-author',
    false,
    (text) => text === 'true',
    asText,
  );
  const [tabs, setTabs] = useSetting('ou-board-tabs', false, (text) => text === 'true', asText);
  /** A repo heading's fold in a column is remembered, as "<column>/<heading>". */
  const [collapsed, setCollapsed] = useSetting(
    'ou-board-collapsed-lanes',
    new Set<string>(),
    (text) => {
      const saved = JSON.parse(text);
      return new Set<string>(
        Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [],
      );
    },
    (ids) => JSON.stringify([...ids]),
  );
  const add = useAddPanel(api);
  const dnd = useBacklogDnd(api);
  const voiceBusy = useVoiceBusy();

  const data = filtered(full, laneFilter);
  const now = Date.now();
  const layout = arrange(data, hideOnAuthor, now);
  const { count } = layout;
  // what is on you: a question, a story to review, comments to answer
  const onYou = count('waiting') + count('ready') + count('back');
  useEffect(() => {
    document.title = onYou ? `(${onYou}) Agent board` : 'Agent board';
  }, [onYou]);

  const columns: ColumnsView = {
    layout,
    now,
    api,
    blank: data.blank,
    editors: data.editors,
    collapsed,
    onFold: (id) => {
      const next = new Set(collapsed);
      if (!next.delete(id)) {
        next.add(id);
      }
      setCollapsed(next);
    },
    hideOnAuthor,
    tabs,
    onToggleAuthors: () => setHideOnAuthor(!hideOnAuthor),
    idleOpen,
    onToggleIdle: () => setIdleOpen(!idleOpen),
    // a Backlog item has its own view, the others share the session card's
    renderCard: (card: BoardCard) =>
      card.kind === 'backlog'
        ? html`<${BacklogCard} key=${card.id} card=${card} now=${now} api=${api} dnd=${dnd.cardDnd(card)} />`
        : html`<${Card} key=${card.id} card=${card} now=${now} api=${api} />`,
    slots: { backlog: { head: add.head, form: add.form, listProps: dnd.listProps } },
  };
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

  // the first poll is still on its way: the line the server put in the page
  if (!view.data && !view.error) {
    return html`<p class="ou-local-muted ou-local-loading">Loading the board…</p>`;
  }
  // refused for want of a key: say how to connect (the poll fills the board in once there is a cookie)
  const refused = [401, 403].includes((view.error as { status?: number } | null)?.status ?? 0);
  const notConnected = html`<div dangerouslySetInnerHTML=${{ __html: String(notConnectedHtml()) }}></div>`;
  const loadFailed = html`<p class="ou-local-error">Couldn't load the board: ${view.error?.message}</p>`;
  // one failed poll keeps the last board on screen (the next one is likely fine); a second in a row, or none yet to keep, shows it
  let failure = null;
  if (view.error && (view.failed >= 2 || !view.data)) {
    failure = refused ? notConnected : loadFailed;
  }
  return html`${
    failure ||
    html`<${Header} summary=${summary} data=${data} now=${now} filter=${laneFilter} filterOn=${data !== full} onFilter=${setLaneFilter} tabs=${tabs} onToggleTabs=${() => setTabs(!tabs)} api=${api} busy=${voiceBusy} />
    ${data.warning && html`<p class="ou-board-warning">${data.warning}</p>`}
    <main class="ou-board">
      <${Columns} view=${columns} />
      ${data.worktrees && html`<${Worktrees} trees=${data.worktrees} now=${now} open=${treesOpen} onToggle=${() => setTreesOpen(!treesOpen)} api=${api} />`}
      <${Listeners} repos=${data.listeners} now=${now} api=${api} />
      <${Helpers} helpers=${data.helpers} now=${now} api=${api} />
    </main>`
  }
  <${VoicePanel}
    voice=${view.failed >= 2 ? null : full.voice}
    root=${app}
    pause=${(paused: boolean) => bridge.ask(ROUTES.boardVoicePause, { body: { paused } })}
    onChanged=${refresh}
    onFocus=${(session: string) => focusSession(bridge, session)}
  />`;
}

// the "Loading the board…" line the server put there
app.textContent = '';
render(html`<${BoardApp} />`, app);
