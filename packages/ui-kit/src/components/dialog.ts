/*
 * Dialog: a modal `<dialog>`. It opens when it is drawn and is gone when it is not, so what is inside starts fresh each time. A click
 * on its backdrop and Escape both say `onClose`; the caller stops drawing it, and the dialog closes itself as it goes, so the browser
 * gives focus back to what had it when the dialog opened. `id` and `class` are the host's own hooks (its styles,
 * the place its tests look). Styled by the host: ui.css only gives the element nothing.
 */
import { html, useEffect, useRef } from '/assets/preact.mjs';

export function Dialog(props: {
  onClose: () => void;
  id?: string;
  class?: string;
  children?: unknown;
}) {
  const { onClose, id, class: className, children } = props;
  const box = useRef<HTMLDialogElement | null>(null);
  const leaving = useRef(false);
  useEffect(() => {
    const element = box.current;
    element?.showModal();
    return () => {
      // drawn no more: close it while it is still on the page (taking it away with `open` still on leaves focus on the body)
      leaving.current = true;
      element?.close();
    };
  }, []);
  // a click that lands on the dialog itself, not on something inside it, is on its backdrop
  const backdrop = (event: Event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };
  return html`<dialog ref=${box} id=${id} class=${className} onClick=${backdrop} onClose=${() => !leaving.current && onClose()}>${children}</dialog>`;
}
