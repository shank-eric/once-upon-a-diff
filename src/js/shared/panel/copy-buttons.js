/*
 * The panel's copy buttons: a drafted comment's Copy, the status hint's
 * "Copy prompt for Claude", and the small session buttons that copy a
 * resume command. Each says how it went on the button for a moment.
 */
import { writeClipboard } from '../util/clipboard.js';

/** Selects the element's text, so Cmd+C works when the clipboard said no. */
function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A drafted comment's Copy: the clipboard, else selecting the comment's text and execCommand. */
export function copyComment(text, button) {
  const done = (ok) => {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
  };
  writeClipboard(text).then((ok) => {
    if (ok) {
      done(true);
      return;
    }
    selectText(button.closest('.prs-comment').querySelector('pre'));
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (e) {
      copied = false;
    }
    done(copied);
  });
}

/** Copies the listen prompt; if the clipboard says no, shows it selected so Cmd+C works. */
export function copyPrompt(text, button, pre) {
  writeClipboard(text).then((ok) => {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    if (!ok && pre) {
      pre.textContent = text;
      pre.hidden = false;
      selectText(pre);
    }
    setTimeout(() => {
      button.textContent = 'Copy prompt for Claude';
    }, 1500);
  });
}

/** A small button that copies its text: "copied" for a moment, or the text itself (to copy by hand) a little longer. */
export function copyButtonText(text, button) {
  const was = button.textContent;
  writeClipboard(text).then((ok) => {
    button.textContent = ok ? 'copied' : text;
    setTimeout(
      () => {
        button.textContent = was;
      },
      ok ? 1200 : 4000,
    );
  });
}
