/*
 * "Copy prompt for Claude" on GitHub pages: the clipboard API, or, if the page
 * won't allow it, a hidden textarea and execCommand inside our own shadow root.
 */
import { writeClipboard } from '@once-upon-a-diff/shared/util/clipboard';

export async function copyText(text: string, root?: Node | null): Promise<boolean> {
  if (await writeClipboard(text)) {
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  (root || document.body).appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

/** Copies and says so on the button for a moment. */
export async function copyWithFeedback(
  text: string,
  btn: HTMLElement,
  root?: Node | null,
): Promise<boolean> {
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
