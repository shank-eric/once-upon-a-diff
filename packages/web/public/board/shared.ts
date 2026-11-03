/*
 * What the board's regions share, drawn by Preact (ADR-14): small components and hooks that more than one region uses (the
 * usage and context meters, the worktree row, a link that brings an iTerm tab forward), the helpers they read, and the
 * `Api` the board root hands every region: the bridge's typed client, the latest board and a way to poll again. A region
 * imports this file and never another region.
 */
import { html, useState } from '/assets/preact.mjs';
import type { Client } from '/assets/protocol/client.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { remember, stored } from '/assets/local/stored.ts';
import { compactAge } from '/assets/protocol/domain/time.ts';
import { cleanupConfirm, worktreeChips } from '/assets/board/worktree-text.ts';
import type { BoardCard, BoardData, BoardWorktree } from '/assets/types.ts';

/** What every region needs to talk to the bridge: the typed client, the board as last polled, and a poll now. */
export type Api = {
  bridge: Client;
  board: BoardData;
  refresh: () => Promise<void>;
};

/** "5m ago", or "just now" for the first minute (compactAge says "now"). */
export function ago(iso: string | null, now: number): string {
  const time = compactAge(iso, now);
  return time === 'now' ? 'just now' : time && `${time} ago`;
}

/** "3h", "5m" since an ISO time, for the Listeners lane. */
export const since = (iso: string | null, now: number) => (iso ? compactAge(iso, now) : '');

/** A setting the board remembers in localStorage: its value and a setter that saves it (a choice that cannot be saved is just not remembered). */
export function useSetting<T>(
  key: string,
  fallback: T,
  parse: (text: string) => T,
  format: (value: T) => string,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => stored(key, fallback, parse));
  return [
    value,
    (next: T) => {
      setValue(next);
      remember(key, format(next));
    },
  ];
}

/** Whether this is a touch screen, where a tap on a card raises nothing (there is no tab to raise). */
export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

/** A session's title from the board, for the confirmation boxes. */
export function titleOf(board: BoardData, session: string): string {
  const view = board.lanes
    .flatMap((lane) => lane.cards.flatMap((card) => card.sessions))
    .find((one) => one.id === session);
  return (
    view?.title ??
    board.listeners.flatMap((entry) => entry.candidates).find((one) => one.id === session)?.title ??
    'that session'
  );
}

/** The warning class for a percentage: yellow from 70, red from 90. */
function levelOf(value: number) {
  if (value >= 90) {
    return ' ou-board-usage-high';
  }
  return value >= 70 ? ' ou-board-usage-warn' : '';
}

/** A label, a thin bar filled to a percentage and the number, yellow from 70% and red from 90% like the status line. */
export function Meter(props: {
  label: string;
  percent: number;
  title: string;
  children?: unknown;
}) {
  const { label, percent, title, children } = props;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<span class=${`ou-board-meter${levelOf(percent)}`} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${clamped} aria-label=${label} title=${title}>
    <span class="ou-board-meter-label">${label}</span>
    <span class="ou-board-meter-bar" aria-hidden="true"><span style=${`width:${clamped}%`}></span></span>
    <span class="ou-board-meter-num">${clamped}%</span>${children}
  </span>`;
}

/** Brings a session's iTerm tab to the front; the bridge finds the tab itself, which takes most of a second, so the cursor shows progress. */
export async function focusSession(bridge: Client, session: string) {
  document.body.style.cursor = 'progress';
  try {
    await bridge.ask(ROUTES.boardFocus, { body: { session } });
  } catch (err) {
    alert(`Couldn't bring the iTerm tab forward: ${(err as Error).message}`);
  } finally {
    document.body.style.cursor = '';
  }
}

/** `focus` brings a session's tab forward, and `switching` says so meanwhile (a button reads "Switching…"). */
export function useFocus(bridge: Client) {
  const [switching, setSwitching] = useState(false);
  const focus = async (session: string) => {
    setSwitching(true);
    await focusSession(bridge, session);
    setSwitching(false);
  };
  return { switching, focus };
}

/** A button that brings a session's iTerm tab forward, and says "Switching…" while the bridge does it. */
export function FocusButton(props: {
  bridge: Client;
  session: string;
  class: string;
  title: string;
  children?: unknown;
}) {
  const { switching, focus } = useFocus(props.bridge);
  return html`<button type="button" class=${props.class} data-focus=${props.session} disabled=${switching} onClick=${() => focus(props.session)} title=${props.title}>${switching ? 'Switching…' : props.children}</button>`;
}

/** A session's name as a link that brings its iTerm tab forward when the tab is known, else plain text. */
export function SessionLink(props: {
  bridge: Client;
  session: string | null;
  canFocus: boolean;
  name: string;
  title: string;
}) {
  const { bridge, session, canFocus, name, title } = props;
  return canFocus && session
    ? html`<${FocusButton} bridge=${bridge} session=${session} class="ou-board-from" title=${title}>${name}</${FocusButton}>`
    : name;
}

/** Clean up: asks first (what goes and what stays), then has the bridge remove the worktree; the bridge looks again itself. */
function CleanUp(props: { tree: BoardWorktree; api: Api }) {
  const { tree, api } = props;
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!window.confirm(cleanupConfirm(tree))) {
      return;
    }
    setBusy(true);
    document.body.style.cursor = 'progress';
    try {
      const done = await api.bridge.ask(ROUTES.boardWorktreeClean, {
        body: {
          path: tree.path,
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
      await api.refresh();
      setBusy(false);
    }
  };
  return html`<button type="button" data-worktree-clean=${tree.path} disabled=${busy} onClick=${run} title=${tree.deletes_branch ? 'Removes the folder and deletes the merged branch' : 'Removes the folder and keeps the branch'}>${busy ? 'Removing…' : 'Clean up'}</button>`;
}

/** One worktree: its name, where, the chips, why it is kept, and Clean up when the bridge offers it. */
export function Worktree(props: { tree: BoardWorktree; now: number; api: Api; lane?: boolean }) {
  const { tree, now, api, lane = false } = props;
  const chips = worktreeChips(tree, compactAge(tree.last_commit_at, now));
  const where = [lane && tree.lane, tree.branch ?? 'detached HEAD'].filter(Boolean).join(' · ');
  return html`<li class=${`ou-board-tree${tree.removable ? ' ou-board-tree-removable' : ''}`} data-worktree=${tree.path}>
    <div class="ou-board-tree-name" title=${tree.path}><code>${tree.name}</code> <span class="ou-local-muted">${where}</span></div>
    <div class="ou-board-chips">${chips.map((chip) => html`<span class="ou-board-chip">${chip}</span>`)}</div>
    ${!tree.removable && tree.keep.length > 0 && html`<div class="ou-local-muted ou-board-tree-keep">kept: ${tree.keep.join(', ')}</div>`}
    ${tree.removable && html`<div class="ou-board-actions"><${CleanUp} tree=${tree} api=${api} /></div>`}
  </li>`;
}

/** A card's worktrees, under its own chips. */
export function CardTrees(props: { card: BoardCard; now: number; api: Api }) {
  const { card, now, api } = props;
  return card.worktrees?.length
    ? html`<ul class="ou-board-trees">${card.worktrees.map((tree) => html`<${Worktree} key=${tree.path} tree=${tree} now=${now} api=${api} />`)}</ul>`
    : null;
}
