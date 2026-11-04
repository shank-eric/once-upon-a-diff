/*
 * The board's columns, drawn by Preact (ADR-14): the two groups of columns, each column's heading and its lanes of cards, the
 * Done and Idle lanes, the Blank strip and the Listeners lane. A card's clicks are on the card's own buttons. The Backlog
 * column's cards, its + Add button and its drag and drop belong to the backlog region, which the board root hands in as
 * `renderCard` and `slots`, since a region imports no other region.
 */
import { html, useLayoutEffect, useRef, useState } from '/assets/preact.mjs';
import type { BoardCard, BoardColumn, BoardData } from '/assets/types.ts';
import { useSetting, type Api } from '/assets/board/shared.ts';
import { COLUMNS, GROUPS, type Layout } from '/assets/board/columns/layout.ts';
import { Blank } from '/assets/board/columns/blank.ts';
import { Editors } from '/assets/board/columns/editors.ts';

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
  /** The tab view is wanted at any width (the header's Tabs button); a narrow page has it whatever this says. */
  tabs: boolean;
  idleOpen: boolean;
  onToggleIdle: () => void;
  /** The Blank strip's sessions, by repo (narrowed to the repo filter's lane). */
  blank: BoardData['blank'];
  /** The editors, narrowed to the repo filter's lane: the strip above the columns. */
  editors: BoardData['editors'];
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

/** What a column needs (local.css: 210px and a 12px gap), and what a group adds around its columns (padding, and the border between them). */
const COLUMN_MIN = 210;
const COLUMN_GAP = 12;
const GROUPS_CHROME = 30;

/**
 * Whether the groups of columns, as many as are showing, are too wide for the room they have, so they become two tabs.
 * They are also wanted at any width when `wanted` (the header's Tabs button).
 * The room is the columns area's own width, so the open voice drawer and the optional columns count; it follows a resize.
 */
function useTabs(columns: number, wanted: boolean): [boolean, { current: HTMLElement | null }] {
  const area = useRef<HTMLElement | null>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) {
      return undefined;
    }
    const measure = () => setRoom(element.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') {
      return undefined;
    }
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  const needs = columns * (COLUMN_MIN + COLUMN_GAP) - 2 * COLUMN_GAP + GROUPS_CHROME;
  // no width yet (not laid out) is not a reason for tabs
  return [wanted || (room > 0 && room < needs), area];
}

/** One of the two groups of columns, headed by where its work is (and, as a tab's panel, labelled by its tab). */
function Group(props: {
  group: (typeof GROUPS)[number];
  view: ColumnsView;
  panel?: boolean;
  hidden?: boolean;
}) {
  const { group, view, panel, hidden } = props;
  const columns = view.layout.columns.filter((column) => column.group === group.id);
  const aria = panel
    ? {
        role: 'tabpanel',
        tabindex: 0,
        hidden,
        id: `ou-board-panel-${group.id}`,
        'aria-labelledby': `ou-board-tab-${group.id}`,
      }
    : {};
  return html`<div class="ou-board-group" style=${`--cols:${columns.length}`} ...${aria}>
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
  // too narrow for the groups side by side: a tab for each, the chosen one remembered, and the other group hidden (still drawn, so a half-typed Add stays)
  const [tabbed, area] = useTabs(layout.columns.length, view.tabs);
  const [chosen, choose] = useSetting(
    'ou-board-tab',
    'local',
    (text) => (text === 'github' ? 'github' : 'local'),
    String,
  );
  const onKey = (event: KeyboardEvent) => {
    const index = GROUPS.findIndex((group) => group.id === chosen);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: GROUPS.length - 1 }[
      event.key
    ];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    const next = GROUPS[(target + GROUPS.length) % GROUPS.length];
    choose(next.id);
    (document.getElementById(`ou-board-tab-${next.id}`) as HTMLElement | null)?.focus();
  };
  return html`<div ref=${area}>${
    tabbed &&
    html`<div class="ou-board-tabs" role="tablist" aria-label="Board" onKeyDown=${onKey}>${GROUPS.map(
      (group) =>
        html`<button type="button" role="tab" key=${group.id} id=${`ou-board-tab-${group.id}`} aria-selected=${String(group.id === chosen)} aria-controls=${`ou-board-panel-${group.id}`} tabindex=${group.id === chosen ? 0 : -1} onClick=${() => {
          api.count('board.tab.switch');
          choose(group.id);
        }}>${group.label}</button>`,
    )}</div>`
  }
    <${Editors} editors=${view.editors} now=${view.now} api=${api} />
    <div class=${tabbed ? 'ou-board-groups ou-board-groups-tabbed' : 'ou-board-groups'}>${GROUPS.map((group) => html`<${Group} key=${group.id} group=${group} view=${view} panel=${tabbed} hidden=${tabbed && group.id !== chosen} />`)}</div>
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
    }</div>`;
}
