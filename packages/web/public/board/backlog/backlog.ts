/*
 * The Backlog column's parts, drawn by Preact (ADR-14): a Backlog card (Assign, Edit, Drop), the + Add button and
 * Add panel, and drag and drop (and Alt+Up/Down) to reorder a lane. The page root calls the two hooks, so the Backlog
 * column (the columns region) gets its button, its panel and its drag handlers handed in and imports none of this.
 */
import { html, useEffect, useLayoutEffect, useRef, useState } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import { sameLaneKey } from '/assets/domain/lane-key.ts';
import { MenuButton } from '/assets/ui-kit/components/menu.ts';
import type { BoardCard, BoardData } from '/assets/types.ts';
import { CardTrees, type Api } from '/assets/board/shared.ts';
import { Chips } from '/assets/ui-kit/components/chip.ts';
import { ActionButton, useBusy } from '/assets/ui-kit/components/action-button.ts';
import { ago } from '/assets/domain/time.ts';
import {
  agentOnlyChips,
  pendingClaimChip,
  startedChips,
} from '/assets/board/backlog/started-chips.ts';
import { BACKLOG_NOTE_MAX, repoName } from '/assets/domain/text.ts';

/** The ids of the Backlog cards in a card's lane, in the order the board shows them. */
export function backlogLane(card: BoardCard, board: BoardData | null): string[] {
  const lane = board?.lanes.find((one) => sameLaneKey(one.key, card.lane));
  return (lane?.cards ?? [])
    .filter((one) => one.column === 'backlog' && one.backlog && !one.backlog.someday)
    .map((one) => (one.backlog as { id: string }).id);
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

/**
 * Assign: asks the bridge to tell the voice session to start the item ("Start backlog card <id>: <title>", typed into its
 * tab; the page sends only the id). Always on. The answer, or the reason it was refused, shows beside the button for a few
 * seconds. The board refreshes whether it was sent or refused, and the button is off until it has.
 */
function Assign(props: { id: string; again: boolean; api: Api }) {
  const { id, again, api } = props;
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => {
    if (!note) {
      return;
    }
    const timer = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(timer);
  }, [note]);
  const run = async () => {
    try {
      const sent = await api.bridge.ask(ROUTES.boardBacklogAssign, { body: { id } });
      setNote({ text: `Sent to ${sent.session}`, bad: false });
    } catch (err) {
      setNote({ text: `Not sent: ${(err as Error).message}`, bad: true });
    }
    await api.refresh();
  };
  return html`<${ActionButton} attrs=${{ 'data-backlog-assign': id }} onClick=${run} title="Tell the voice session to start this card">${again ? 'Send again' : 'Assign'}</${ActionButton}>${note && html`<span class="ou-local-muted ou-board-assign-note" data-backlog-assign-note=${note.bad ? 'refused' : 'sent'} role="status">${note.text}</span>`}`;
}

/**
 * Edit: a form on the card with its title, note and repo (empty for none). Save sends only the fields that changed, and
 * closes the form (nothing changed: nothing sent). The inputs keep what is typed through every redraw, like the Add panel's.
 */
function EditForm(props: { card: BoardCard; id: string; api: Api; close: () => void }) {
  const { card, id, api, close } = props;
  const { busy, run } = useBusy();
  const formRef = useRef<HTMLFormElement | null>(null);
  // filled once, as it opens: setting the value on each draw would put back what a poll's redraw found, over what is typed
  useLayoutEffect(() => {
    const fields = { title: card.title, note: card.detail ?? '', repo: card.repo ?? '' };
    for (const [name, text] of Object.entries(fields)) {
      (
        formRef.current?.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement
      ).value = text;
    }
    (formRef.current?.querySelector('[name="title"]') as HTMLInputElement).focus();
  }, []);
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLElement;
    const value = (name: string) =>
      (
        form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement
      ).value.trim();
    const was = { title: card.title, note: card.detail ?? '', repo: card.repo ?? '' };
    const changes: Record<string, string> = {};
    for (const field of ['title', 'note', 'repo'] as const) {
      if (value(field) !== was[field]) {
        changes[field] = value(field);
      }
    }
    if (!Object.keys(changes).length) {
      return close();
    }
    return run('save', async () => {
      try {
        await api.bridge.ask(ROUTES.boardBacklogEdit, { body: { id, ...changes } });
        close();
      } catch (err) {
        alert(`Couldn't save it: ${(err as Error).message}`);
      }
      await api.refresh();
    });
  };
  return html`<form class="ou-board-add" data-backlog-edit-form ref=${formRef} onSubmit=${submit}>
    <input type="text" name="title" placeholder="Title" maxlength="200" required aria-label="Backlog item title" />
    <textarea name="note" rows="3" placeholder="Note (optional)" maxlength=${BACKLOG_NOTE_MAX} aria-label="Note"></textarea>
    <input type="text" name="repo" placeholder="owner/name (empty for no repo)" aria-label="Repo" />
    <div class="ou-board-add-actions"><button type="submit" disabled=${busy !== null}>Save</button> <button type="button" data-backlog-edit-cancel onClick=${close}>Cancel</button></div>
  </form>`;
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
  const [editing, setEditing] = useState(false);
  const meta = [
    repoName(card.repo),
    card.branch,
    ago(card.since, now) && `added ${ago(card.since, now)}`,
    item && item.added_by !== 'board' && item.added_by !== 'you' && `by ${item.added_by}`,
  ].filter(Boolean);
  const classes = [
    `ou-board-card ou-board-c-${card.column}`,
    dnd.dragging && 'ou-board-dragging',
    dnd.mark && `ou-board-drop-${dnd.mark}`,
  ]
    .filter(Boolean)
    .join(' ');
  const drop = async (id: string) => {
    try {
      await api.bridge.ask(ROUTES.boardBacklogDrop, { body: { id } });
    } catch (err) {
      alert(`Couldn't drop it: ${(err as Error).message}`);
    }
    await api.refresh();
  };
  const someday = async (id: string, aside: boolean) => {
    try {
      await api.bridge.ask(ROUTES.boardBacklogSomeday, { body: { id, on: aside } });
    } catch (err) {
      alert(`Couldn't ${aside ? 'set it aside' : 'bring it back'}: ${(err as Error).message}`);
    }
    await api.refresh();
  };
  return html`<li class=${classes} data-card=${card.id} data-backlog-card=${item?.id ?? ''} data-lane=${card.lane} draggable=${!item?.started && !item?.someday && !editing} tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragStart=${dnd.onDragStart} onDragEnd=${dnd.onDragEnd} onKeyDown=${dnd.onKeyDown}>
    <div class="ou-board-title" title=${card.title}>${card.title}</div>
    <div class="ou-local-muted ou-board-meta">${meta.join(' · ')}</div>
    ${editing && item && html`<${EditForm} card=${card} id=${item.id} api=${api} close=${() => setEditing(false)} />`}
    ${card.detail && html`<div class="ou-board-detail ou-board-note" title=${card.detail}>${card.detail}</div>`}
    ${item?.started && html`<${Chips} items=${startedChips(item.started)} />`}
    ${item?.agent && !item.started && html`<${Chips} items=${agentOnlyChips(item.agent)} />`}
    ${item?.claim?.pending && html`<${Chips} items=${[pendingClaimChip(item.claim.agent)]} />`}
    ${item?.assigned && !item.started && html`<${Chips} items=${[`assigned to ${item.assigned.session_title ?? 'a session that has ended'} ${ago(item.assigned.at, now)}, not started yet`]} />`}
    ${item && !item.started && !(item.claim && !item.agent?.tried) && html`<div class="ou-board-startline"><code>${item.start_line}</code></div>`}
    <${CardTrees} card=${card} now=${now} api=${api} />
    <div class="ou-board-actions">
      ${item?.assign && !item.started && !item.someday && html`<${Assign} id=${item.id} again=${!!item.assigned} api=${api} />`}
      ${item && !item.started && !editing && html`<button type="button" data-backlog-edit=${item.id} onClick=${() => setEditing(true)} title="Change its title, note or repo">Edit</button>`}
      ${item && card.column === 'backlog' && !item.started && !item.claim?.pending && html`<${ActionButton} attrs=${{ 'data-backlog-someday': item.id }} onClick=${() => someday(item.id, !item.someday)} title=${item.someday ? 'Back in the main Backlog, in its old place' : 'Maybe someday: out of the main Backlog, into the Someday section'}>${item.someday ? 'Back to backlog' : 'Someday'}</${ActionButton}>`}
      ${item && html`<${ActionButton} attrs=${{ 'data-backlog-drop': item.id }} onClick=${() => drop(item.id)} title="Drop it from the backlog (the line stays in the file)">Drop</${ActionButton}>`}
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
  /** An add is in flight (its refresh too): a second submit waits for it. */
  const { busy: adding, run } = useBusy();
  /** The panel was just opened: its title takes the focus once, when it first appears (not again when the board comes back after an error). */
  const justOpened = useRef(false);
  const focusIt = (element: HTMLElement | null) => {
    if (element && justOpened.current) {
      justOpened.current = false;
      element.focus();
    }
  };
  const openPanel = () => {
    api.count('board.backlog.addOpen');
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

  const repoItems = () => {
    const repos = [
      ...new Set(
        api.board.lanes
          .flatMap((lane) => lane.cards)
          .map((card) => card.repo)
          .filter((one): one is string => !!one),
      ),
    ].sort();
    return [
      { value: '', label: 'No repo', detail: 'in the General lane', checked: !repo },
      ...repos.map((one) => ({
        value: one,
        label: repoName(one),
        detail: one,
        checked: one === repo,
      })),
    ];
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLElement;
    const input = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement;
    const item = {
      title: input('title').value.trim(),
      repo: repo || undefined,
      note: input('note').value.trim() || undefined,
    };
    return run('add', async () => {
      // cleared before the request goes out, so a redraw while it is out can't bring the text back and invite a second add
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
      }
      await api.refresh();
    });
  };

  const repoLabel = repo ? repoName(repo) : 'none';
  return {
    head: open
      ? null
      : html` <button type="button" data-backlog-add-open onClick=${openPanel} title="Keep something for later">+ Add</button>`,
    form: open
      ? html`<form class="ou-board-add" data-backlog-add onSubmit=${submit}>
    <input type="text" name="title" data-backlog-title placeholder="Keep something for later" maxlength="200" required aria-label="Backlog item title" ref=${focusIt} />
    <${MenuButton} class="ou-board-add-repo" data-backlog-repo items=${repoItems} onPick=${setRepo} label="Repo for the new item" title="The repo the new item is for: its card goes in that repo's lane">Repo: ${repoLabel} ▾</${MenuButton}>
    <input type="text" name="note" placeholder="Note (optional)" maxlength=${BACKLOG_NOTE_MAX} aria-label="Note" />
    <div class="ou-board-add-actions"><button type="submit" disabled=${adding !== null}>Add</button> <button type="button" data-backlog-cancel onClick=${() => setOpen(false)}>Cancel</button></div>
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
          // (a someday card is not in the lane's order: moving it would lose its old place)
          if (card.backlog?.someday) {
            return;
          }
          // (typing in the card's edit form is not a reorder)
          if ((event.target as HTMLElement | null)?.closest?.('form, input, textarea')) {
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
