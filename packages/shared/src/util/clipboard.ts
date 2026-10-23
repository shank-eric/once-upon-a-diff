// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The async clipboard API, as a promise that never rejects. Callers choose
 * their own fallback (selecting the text, or a hidden textarea) when it
 * resolves false.
 */

/** Resolves true once the text is on the clipboard, false when the page has no clipboard API or it refused. */
export function writeClipboard(text) {
  if (!(navigator.clipboard && navigator.clipboard.writeText)) {
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}
