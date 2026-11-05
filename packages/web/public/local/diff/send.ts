/*
 * Send, in the page's header beside the Fix before push toggle: hands every draft note to a Claude session as one
 * fix request. It is the panel's own Send (panel/src/fixes/fixes.ts), so it sends the same request and shows the same
 * message; the header only asks the panel to run it. Off with no note to send, and while the panel is closed.
 */
import { html } from '/assets/domain/html.ts';
import { setHtml } from '/assets/ui-kit/dom.ts';
import { plural } from '/assets/domain/text.ts';
import { page } from '/assets/local/page.ts';

/** A draft note: not sent to a session yet, and not fixed. */
const draftCount = () => page.story.local.notes.filter((note) => !note.sent && !note.fixed).length;

/** The header's Send button: "Send 2 notes", off when there are none, or when the panel that sends them is closed. */
export function sendButtonHtml() {
  const drafts = draftCount();
  let off = '';
  if (!drafts) {
    off = 'No notes to send: add one by clicking a line number in the diff';
  } else if (!page.overlay) {
    off = 'Show the story to send: the panel sends the notes';
  }
  const title =
    off || 'Hands every draft note to a Claude session as one request. Same as Send in the panel.';
  return html`<button type="button" class="ou-local-send"${off && html` disabled`} title="${title}">${drafts ? `Send ${plural(drafts, 'note')}` : 'Send'}</button>`;
}

export function redrawSend() {
  const holder = document.querySelector('.ou-local-send-holder');
  if (holder) {
    setHtml(holder, sendButtonHtml());
  }
}

/** Send was clicked: the panel's send, which says where it went and tells the page (placeNotes) how the notes stand. */
export async function sendNotes() {
  if (page.overlay) {
    await page.overlay.sendFixes();
  }
}
