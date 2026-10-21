/*
 * "Copy prompt for Claude" on GitHub pages: the clipboard API, or, if the page
 * won't allow it, a hidden textarea and execCommand inside our own shadow root.
 */
import { writeClipboard } from '../shared/util/clipboard.js';

export async function copyText(text, root) {
  if (await writeClipboard(text)) {
    return true;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  (root || document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Copies and says so on the button for a moment. */
export async function copyWithFeedback(text, btn, root) {
  const was = btn.textContent;
  const ok = await copyText(text, root);
  btn.textContent = ok ? 'Copied' : "Couldn't copy";
  if (!ok) {
    btn.title = text;
  }
  setTimeout(() => {
    btn.textContent = was;
  }, 1500);
  return ok;
}
