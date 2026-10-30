/*
 * The Backlog column's parts, drawn by Preact (ADR-14): a Backlog card (Assign, Copy start line, Drop), the + Add button and
 * Add panel, and drag and drop (and Alt+Up/Down) to reorder a lane. The page root calls the two hooks, so the Backlog
 * column (the columns region) gets its button, its panel and its drag handlers handed in and imports none of this.
 */
import { html, useEffect, useRef, useState } from '/assets/preact.mjs';
import { ROUTES } from '/assets/protocol/routes.ts';
import { openMenu } from '/assets/local/menu.ts';
import type { BoardAssign, BoardCard, BoardData } from '/assets/types.ts';
import { obviousChoice } from '/assets/util/choice.ts';
import { compactAge } from '/assets/util/time.ts';
import { ago, CardTrees, titleOf, type Api } from '/assets/board/shared.ts';
import { startedChips } from '/assets/util/started-chips.ts';

/** The ids of the Backlog cards in a card's lane, in the order the board shows them. */
export function backlogLane(card: BoardCard, board: BoardData | null): string[] {
  const lane = board?.lanes.find((one) => one.name === card.lane);
  return (lane?.cards ?? [])
    .filter((one) => one.column === 'backlog' && one.backlog)
    .map((one) => (one.backlog as { id: string }).id);
}

/** The session Assign uses without asking: the only one, the only blank one, else (no blank ones) the clearly freshest. */
export function assignObvious(candidates: BoardAssign['candidates']) {
  const blanks = candidates.filter((one) => one.blank);
  if (blanks.length) {
    return blanks.length === 1 ? blanks[0] : null;
  }
  return obviousChoice(candidates);
}

/** Where `dragged` goes in its lane's ids if put before (or after) `target`: before the item now there, or the bottom. */
export function placeAmong(
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

type Where = { before: string } | { edge: 'top' | 'bottom' };
const findItem = (board: BoardData, id: string) =>
  board.lanes.flatMap((lane) => lane.cards).find((one) => one.backlog?.id === id);

/** Asks first, then has the bridge type the item's start line into the session (the bridge builds it; the page sends two ids). */
async function assignInto(api: Api, id: string, session: string, line: string) {
  if (
    !window.confirm(`Type this into "${titleOf(api.board, session)}" and press Enter?\n\n${line}`)
  ) {
    return;
  }
  try {
    await api.bridge.ask(ROUTES.boardBacklogAssign, { body: { id, session } });
    await api.refresh();
  } catch (err) {
    alert(`Couldn't assign it: ${(err as Error).message}`);
  }
}

/** Assign: types the item's start line into an idle session in its repo. Several with no obvious one: a menu. */
function Assign(props: { id: string; assign: BoardAssign; again: boolean; api: Api }) {
  const { id, assign, again, api } = props;
  const { candidates, prompt } = assign;
  const choosing = candidates.length > 1 && !assignObvious(candidates);
  let title = 'No idle session with an iTerm tab is free for this item';
  if (candidates.length) {
    title = choosing
      ? 'Choose an idle session to hand this item to'
      : 'Types the start line into an idle session';
  }
  const run = (event: MouseEvent) => {
    // one obvious session (the only one, a blank one, or clearly the freshest): use it; else a menu, blank ones first
    const obvious = assignObvious(candidates);
    if (obvious || candidates.length === 1) {
      void assignInto(api, id, (obvious ?? candidates[0]).id, prompt);
    } else if (candidates.length) {
      openMenu(
        event.currentTarget as HTMLElement,
        candidates.map((one) => ({
          value: one.id,
          label: one.title,
          detail: `${one.blank ? 'new' : one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''}${one.branch ? ` · ${one.branch}` : ''}${one.repo ? ` · ${one.repo}` : ''}`,
        })),
        (session) => void assignInto(api, id, session, prompt),
        { label: 'Sessions to hand it to' },
      );
    }
  };
  return html`<button type="button" data-backlog-assign=${id} disabled=${!candidates.length} ...${choosing ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}} onClick=${run} title=${title}>${again ? 'Send again' : 'Assign'}${choosing && ' ▾'}</button>`;
}

/** What a Backlog card needs for drag and drop (from useBacklogDnd): its marks and its handlers. */
export type CardDnd = {
  dragging: boolean;
  mark: 'before' | 'after' | null;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

/** A Backlog card: what was kept, who kept it and when, and the line that starts it (to paste into a session). */
export function BacklogCard(props: { card: BoardCard; now: number; api: Api; dnd: CardDnd }) {
  const { card, now, api, dnd } = props;
  const item = card.backlog;
  const meta = [
    card.repo && card.repo.split('/')[1],
    card.branch,
    ago(card.since, now) && `added ${ago(card.since, now)}`,
    item && item.added_by !== 'board' && item.added_by !== 'you' && `by ${item.added_by}`,
  ].filter(Boolean);
  const classes = [
    'ou-board-card ou-board-c-backlog',
    dnd.dragging && 'ou-board-dragging',
    dnd.mark && `ou-board-drop-${dnd.mark}`,
  ]
    .filter(Boolean)
    .join(' ');
  const copy = async (line: string) => {
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      alert('Copying was blocked: select the line on the card and copy it.');
    }
  };
  const drop = async (id: string) => {
    try {
      await api.bridge.ask(ROUTES.boardBacklogDrop, { body: { id } });
      await api.refresh();
    } catch (err) {
      alert(`Couldn't drop it: ${(err as Error).message}`);
    }
  };
  return html`<li class=${classes} data-card=${card.id} data-backlog-card=${item?.id ?? ''} data-lane=${card.lane} draggable=${!item?.started} tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragStart=${dnd.onDragStart} onDragEnd=${dnd.onDragEnd} onKeyDown=${dnd.onKeyDown}>
    <div class="ou-board-title" title=${card.title}>${card.title}</div>
    <div class="ou-local-muted ou-board-meta">${meta.join(' · ')}</div>
    ${card.detail && html`<div class="ou-board-detail ou-board-note" title=${card.detail}>${card.detail}</div>`}
    ${item?.started && html`<div class="ou-board-chips">${startedChips(item.started).map((chip) => html`<span class="ou-board-chip">${chip}</span>`)}</div>`}
    ${item?.assigned && !item.started && html`<div class="ou-board-chips"><span class="ou-board-chip">assigned to ${item.assigned.session_title ?? 'a session that has ended'} ${ago(item.assigned.at, now)}, not started yet</span></div>`}
    ${item && !item.started && html`<div class="ou-board-startline"><code>${item.start_line}</code></div>`}
    <${CardTrees} card=${card} now=${now} api=${api} />
    <div class="ou-board-actions">
      ${item?.assign && !item.started && html`<${Assign} id=${item.id} assign=${item.assign} again=${!!item.assigned} api=${api} />`}
      ${item && !item.started && html`<button type="button" data-backlog-copy=${item.start_line} onClick=${() => copy(item.start_line)} title="Copy the line that starts it">Copy start line</button>`}
      ${item && html`<button type="button" data-backlog-drop=${item.id} onClick=${() => drop(item.id)} title="Drop it from the backlog (the line stays in the file)">Drop</button>`}
    </div>
  </li>`;
}

/**
 * The + Add button (for the Backlog column's heading) and the Add panel (a title, the repo the item is for and a note), which
 * is closed until asked for, and closes after an add or Escape. The repo stays between adds. What is typed stays through
 * every redraw, since Preact keeps the inputs.
 */
export function useAddPanel(api: Api) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  /** An add is in flight: a second submit waits for it. */
  const adding = useRef(false);
  /** The panel was just opened: its title takes the focus once, when it first appears (not again when the board comes back after an error). */
  const justOpened = useRef(false);
  const focusIt = (element: HTMLElement | null) => {
    if (element && justOpened.current) {
      justOpened.current = false;
      element.focus();
    }
  };
  const openPanel = () => {
    justOpened.current = true;
    setOpen(true);
  };
  useEffect(() => {
    if (!open) {
      return;
    }
    // (Escape in the repo menu is the menu's: it handles the key first and marks it, so the panel stays open with its text)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const chooseRepo = (event: MouseEvent) => {
    const repos = [
      ...new Set(
        api.board.lanes
          .flatMap((lane) => lane.cards)
          .map((card) => card.repo)
          .filter((one): one is string => !!one),
      ),
    ].sort();
    openMenu(
      event.currentTarget as HTMLElement,
      [
        { value: '', label: 'No repo', detail: 'in the General lane', checked: !repo },
        ...repos.map((one) => ({
          value: one,
          label: one.split('/')[1],
          detail: one,
          checked: one === repo,
        })),
      ],
      (value) => setRepo(value),
      { label: 'Repo for the new item' },
    );
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    if (adding.current) {
      return;
    }
    const form = event.currentTarget as HTMLElement;
    const input = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement;
    const item = {
      title: input('title').value.trim(),
      repo: repo || undefined,
      note: input('note').value.trim() || undefined,
    };
    // cleared before the request goes out, so a redraw while it is out can't bring the text back and invite a second add
    adding.current = true;
    input('title').value = '';
    input('note').value = '';
    try {
      await api.bridge.ask(ROUTES.boardBacklogAdd, { body: item });
      setOpen(false);
    } catch (err) {
      const title = input('title');
      const note = input('note');
      if (title && !title.value) {
        title.value = item.title;
      }
      if (note && !note.value) {
        note.value = item.note ?? '';
      }
      alert(`Couldn't add it: ${(err as Error).message}`);
    } finally {
      adding.current = false;
    }
    await api.refresh();
  };

  const repoName = repo ? repo.split('/')[1] : 'none';
  return {
    head: open
      ? null
      : html` <button type="button" data-backlog-add-open onClick=${openPanel} title="Keep something for later">+ Add</button>`,
    form: open
      ? html`<form class="ou-board-add" data-backlog-add onSubmit=${submit}>
    <input type="text" name="title" data-backlog-title placeholder="Keep something for later" maxlength="200" required aria-label="Backlog item title" ref=${focusIt} />
    <button type="button" class="ou-board-add-repo" data-backlog-repo aria-haspopup="menu" onClick=${chooseRepo} title="The repo the new item is for: its card goes in that repo's lane">Repo: ${repoName} ▾</button>
    <input type="text" name="note" placeholder="Note (optional)" maxlength="1000" aria-label="Note" />
    <div class="ou-board-add-actions"><button type="submit">Add</button> <button type="button" data-backlog-cancel onClick=${() => setOpen(false)}>Cancel</button></div>
  </form>`
      : null,
  };
}

/**
 * Reordering a Backlog lane: drag a card, or Alt+Up and Alt+Down on a focused one. `cardDnd` is what each card is given and
 * `listProps` goes on the lane's list (the drop target: the gaps between cards count too). The slot is before the first
 * card whose middle is below the pointer, else after the last, and none for a slot that leaves the order as it is.
 */
export function useBacklogDnd(api: Api) {
  const dragged = useRef('');
  const [dragId, setDragId] = useState('');
  /** The card the drop line is on, and which side: "<id>|before" or "<id>|after" ('' for none). */
  const [mark, setMark] = useState('');

  /** Moves a card. `keepFocus` (the keyboard's move) puts the keyboard back on the card once the move's own redraw has placed it. */
  const move = async (id: string, where: Where, keepFocus = false) => {
    try {
      await api.bridge.ask(ROUTES.boardBacklogMove, { body: { id, ...where } });
    } catch (err) {
      alert(`Couldn't move it: ${(err as Error).message}`);
    }
    await api.refresh();
    // the redraw is done (a poll before it left the card where it was, and no redraw after this one has moved it yet)
    if (keepFocus) {
      document.querySelector<HTMLElement>(`[data-backlog-card="${id}"]`)?.focus();
    }
  };

  function dropTarget(event: DragEvent) {
    const first = dragged.current ? findItem(api.board, dragged.current) : null;
    const list = event.currentTarget as Element;
    if (!first) {
      return null;
    }
    const cards = [...list.children].filter(
      (card) =>
        card.hasAttribute('data-backlog-card') && card.getAttribute('data-lane') === first.lane,
    ) as HTMLElement[];
    if (!cards.length) {
      return null;
    }
    const below = cards.find((card) => {
      const box = card.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    const card = below || cards[cards.length - 1];
    const after = !below;
    const id = card.dataset.backlogCard || '';
    const where = placeAmong(backlogLane(first, api.board), dragged.current, id, after);
    return where ? { id, after, where } : null;
  }

  const endDrag = () => {
    dragged.current = '';
    setDragId('');
    setMark('');
  };

  return {
    cardDnd(card: BoardCard): CardDnd {
      const id = card.backlog?.id ?? '';
      const [markId, side] = mark.split('|');
      return {
        dragging: dragId === id,
        mark: markId === id && id ? (side as 'before' | 'after') : null,
        onDragStart(event) {
          dragged.current = id;
          setDragId(id);
          event.dataTransfer?.setData('text/plain', id);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
          }
        },
        onDragEnd: endDrag,
        // Alt+Up or Alt+Down on a focused Backlog card moves it within its lane (the keyboard's way to reorder)
        onKeyDown(event) {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
            return;
          }
          event.preventDefault();
          const ids = backlogLane(card, api.board);
          const goingUp = event.key === 'ArrowUp';
          const neighbour = ids[ids.indexOf(id) + (goingUp ? -1 : 1)];
          const where = neighbour ? placeAmong(ids, id, neighbour, !goingUp) : null;
          if (where) {
            void move(id, where, true);
          }
        },
      };
    },
    listProps: {
      onDragOver(event: DragEvent) {
        const over = dropTarget(event);
        if (over) {
          event.preventDefault();
        }
        // a pointer still over the same slot keeps its line
        setMark(over ? `${over.id}|${over.after ? 'after' : 'before'}` : '');
      },
      // the pointer left the list (onto a heading, the gap between lanes, another column): no drop line there
      onDragLeave(event: DragEvent) {
        const list = event.currentTarget as Element;
        const entered = event.relatedTarget as Node | null;
        if (!entered || !list.contains(entered)) {
          setMark('');
        }
      },
      onDrop(event: DragEvent) {
        const over = dropTarget(event);
        const id = dragged.current;
        setMark('');
        if (!over || !id) {
          return;
        }
        event.preventDefault();
        dragged.current = '';
        setDragId('');
        void move(id, over.where);
      },
    },
  };
}
