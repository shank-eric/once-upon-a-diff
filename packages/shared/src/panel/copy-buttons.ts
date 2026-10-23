/*
 * The panel's copy buttons: a drafted comment's Copy, the Overview's "Copy as
 * gh script" and the status hint's "Copy prompt for Claude". Each says how it
 * went on the button for a moment.
 */
import { writeClipboard } from '../util/clipboard.ts';

/** Selects the element's text, so Cmd+C works when the clipboard said no. */
function selectText(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection() as Selection; // null only in a frame with no browsing context
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A drafted comment's Copy: the clipboard, else selecting the comment's text and execCommand. */
export function copyComment(text: string, button: HTMLElement): void {
  const showResult = (ok: boolean) => {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
  };
  writeClipboard(text).then((ok) => {
    if (ok) {
      showResult(true);
      return;
    }
    selectText((button.closest('.ou-comment') as Element).querySelector('pre') as HTMLPreElement);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    showResult(copied);
  });
}

/** Copies text; if the clipboard says no, shows it selected in `pre` so Cmd+C works. The button says how it went. */
export function copyWithFallback(text: string, button: HTMLElement, pre: HTMLElement | null): void {
  const label = (button.dataset.label ||= button.textContent);
  writeClipboard(text).then((ok) => {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    if (!ok && pre) {
      pre.textContent = text;
      pre.hidden = false;
      selectText(pre);
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
}

/** Copies the listen prompt; if the clipboard says no, shows it selected so Cmd+C works. */
export function copyPrompt(text: string, button: HTMLElement, pre: HTMLElement | null): void {
  copyWithFallback(text, button, pre);
}
