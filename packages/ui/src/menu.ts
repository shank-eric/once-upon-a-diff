/*
 * A small popover menu in the pages' own style, used instead of a native <select>, whose dropdown can't be styled. It opens
 * under its button and lists items with a label and a short detail. Keyboard: arrows, Home and End move, Enter or Space
 * picks, Escape or Tab closes and focus goes back to the button. A click elsewhere closes it. It takes its colours from
 * the page's tokens (ui.css, .ou-menu), so both themes are covered.
 */
import { html } from '@once-upon-a-diff/protocol/domain/html';
import { setHtml } from './dom.ts';

export interface MenuItem {
  value: string;
  label: string;
  /** a second, muted line: a status, a count */
  detail?: string;
  /** the current choice, marked with a tick */
  checked?: boolean;
}

let open: { menu: HTMLElement; anchor: HTMLElement; close: (refocus: boolean) => void } | null =
  null;

/** Closes the open menu, if any. */
export function closeMenu(refocus = false): void {
  open?.close(refocus);
}

/** Opens a menu under `anchor` (a button), and calls `onPick` with the chosen item's value. */
export function openMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  onPick: (value: string) => void,
  { label = 'Choose' }: { label?: string } = {},
): void {
  // a second click on the button that opened the menu closes it
  const again = open?.anchor === anchor;
  closeMenu();
  if (again) {
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'ou-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  setHtml(
    menu,
    items.map(
      (item, index) =>
        html`<button type="button" role="menuitem" tabindex="-1" class="ou-menu-item" data-index="${index}">
          <span class="ou-menu-check" aria-hidden="true">${item.checked ? '✓' : ''}</span>
          <span class="ou-menu-text"><span class="ou-menu-label">${item.label}</span>${item.detail && html`<span class="ou-menu-detail">${item.detail}</span>`}</span>
        </button>`,
    ),
  );
  document.body.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');

  // under the button, kept inside the window: flipped above when there is no room below
  const place = () => {
    const box = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    const below = box.bottom + 4;
    const top =
      below + height > window.innerHeight - 8 && box.top - height - 4 > 8
        ? box.top - height - 4
        : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  place();

  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('.ou-menu-item')];
  const focusAt = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();
  const close = (refocus: boolean) => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', away);
    window.removeEventListener('scroll', away, true);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    open = null;
    if (refocus) {
      anchor.focus();
    }
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
      close(false);
    }
  };
  const away = () => close(false);
  const keys = (event: KeyboardEvent) => {
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(current < 0 ? -1 : current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(-1);
    }
  };
  menu.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('.ou-menu-item');
    if (button) {
      const item = items[Number(button.getAttribute('data-index'))];
      close(true);
      onPick(item.value);
    }
  });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', away);
  window.addEventListener('scroll', away, true);
  open = { menu, anchor, close };
  // the first item (or the checked one) has focus, so Enter picks it and the arrows move from there
  focusAt(
    Math.max(
      0,
      items.findIndex((item) => item.checked),
    ),
  );
}
