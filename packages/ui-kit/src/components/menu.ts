/*
 * MenuButton: a button that opens a small popover menu in the pages' own style, used instead of a native <select>, whose dropdown can't
 * be styled. It opens under the button and lists items with a label and a short detail. Keyboard: arrows, Home and End move, Enter or Space
 * picks, Escape or Tab closes and focus goes back to the button. A click elsewhere, the page resizing or scrolling (not the menu's own scrolling) closes it, and so does a
 * second click on the button. Only one menu is open at a time. The button says `aria-haspopup="menu"` and, by `aria-expanded`, whether its
 * menu is open. The menu takes its colours from the page's tokens (ui.css, .ou-menu), so both themes are covered.
 *
 * `items` is the list, or a function that makes it when the menu opens (a list as it is then). `onPick` gets the chosen item's value, after
 * the menu has closed and the button has the focus back. `onOpen` runs first and can refuse to open the menu by answering false (to say why
 * there is nothing to choose). Any other prop (`class`, `title`, `disabled`, `data-*`, `aria-label`) goes on the button, and its children
 * are the button's text. The menu is drawn in a root of its own at the end of <body>, so no ancestor clips or moves it.
 */
import { html, render, useLayoutEffect, useRef, useState } from '/assets/preact.mjs';

export interface MenuItem {
  value: string;
  label: string;
  /** a second, muted line: a status, a count */
  detail?: string;
  /** the current choice, marked with a tick */
  checked?: boolean;
}

/** The one open menu's way of closing, so a menu that opens closes it. */
let closeOpen: (() => void) | null = null;

/** The open menu: placed under its button, its first (or ticked) item focused, and the keys and the clicks elsewhere that close it. */
function MenuList(props: {
  anchor: HTMLElement;
  items: MenuItem[];
  label: string;
  onPick: (value: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { anchor, items, label, onPick, onClose } = props;
  const menu = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = menu.current as HTMLDivElement;
    // under the button, kept inside the window: flipped above when there is no room below
    const box = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const below = box.bottom + 4;
    const above = box.top - height - 4;
    element.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    element.style.top = `${below + height > window.innerHeight - 8 && above > 8 ? above : below}px`;

    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.ou-menu-item')];
    const focusAt = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();
    const outside = (event: Event) => {
      if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
        onClose(false);
      }
    };
    const away = () => onClose(false);
    // a scroll on the page or an ancestor closes it; the menu's own (a list taller than the window, a wheel, or a focus past the fold) does not
    const scrolled = (event: Event) => {
      if (!element.contains(event.target as Node)) {
        onClose(false);
      }
    };
    const keys = (event: KeyboardEvent) => {
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        onClose(true);
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
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', scrolled, true);
    // the first item (or the checked one) has focus, so Enter picks it and the arrows move from there
    focusAt(
      Math.max(
        0,
        items.findIndex((item) => item.checked),
      ),
    );
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keys, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, []);
  const pick = (item: MenuItem) => {
    onClose(true);
    onPick(item.value);
  };
  return html`<div class="ou-menu" role="menu" aria-label=${label} ref=${menu}>
    ${items.map(
      (item) =>
        html`<button type="button" role="menuitem" tabindex="-1" class="ou-menu-item" onClick=${() => pick(item)}>
          <span class="ou-menu-check" aria-hidden="true">${item.checked ? '✓' : ''}</span>
          <span class="ou-menu-text"><span class="ou-menu-label">${item.label}</span>${item.detail && html`<span class="ou-menu-detail">${item.detail}</span>`}</span>
        </button>`,
    )}
  </div>`;
}

export function MenuButton(props: {
  items: MenuItem[] | (() => MenuItem[]);
  onPick: (value: string) => void;
  /** The menu's accessible name. */
  label?: string;
  /** Runs when the button is clicked to open the menu: false keeps it closed. */
  onOpen?: () => boolean | void;
  children?: unknown;
  [attribute: string]: unknown;
}) {
  const { items, onPick, label = 'Choose', onOpen, children, ...attrs } = props;
  const button = useRef<HTMLButtonElement | null>(null);
  /** The items the open menu lists, as they were when it opened; null while it is closed. */
  const [shown, setShown] = useState<MenuItem[] | null>(null);
  const close = (refocus: boolean) => {
    setShown(null);
    if (refocus) {
      button.current?.focus();
    }
  };
  const toggle = () => {
    if (shown) {
      close(false);
    } else if (onOpen?.() !== false) {
      setShown(typeof items === 'function' ? items() : items);
    }
  };
  useLayoutEffect(() => {
    if (!shown) {
      return;
    }
    // a menu that was open closes as this one opens
    closeOpen?.();
    const closeThis = () => setShown(null);
    closeOpen = closeThis;
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      html`<${MenuList} anchor=${button.current} items=${shown} label=${label} onPick=${onPick} onClose=${close} />`,
      host,
    );
    return () => {
      if (closeOpen === closeThis) {
        closeOpen = null;
      }
      render(null, host);
      host.remove();
    };
  }, [shown]);
  return html`<button type="button" ...${attrs} aria-haspopup="menu" aria-expanded=${String(!!shown)} ref=${button} onClick=${toggle}>${children}</button>`;
}
