/*
 * Approve, in the page's header: "this is ready to ship at this commit". One POST .../approve with the head the page
 * shows (the bridge refuses it when the branch has moved), which marks the story reviewed and tells a listening session.
 * Approved, the header shows when and at which commit, with Unapprove. A new commit clears it on the bridge, and the
 * page's next reload of the story (its version changed) draws the button again. Not shown once the branch has a PR.
 * The read-only link can't approve (the full page key only), so there the button is off and says why. A storyless review
 * (no story told) has no Approve: seeing the diff and clicking Push or Create pull request is the approval.
 */
import { html } from '/assets/preact.mjs';
import { shortDateTime } from '/assets/terms/time.ts';
import { shortSha } from '/assets/terms/text.ts';
import { toggleApprove } from '/assets/local/actions.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { ShipState } from '/assets/local/store.ts';

/** The header's Approve button, or the approved chip with Unapprove. */
export function ApproveButton(props: { story: LocalStoryData; ship: ShipState }) {
  const { story, ship } = props;
  if (ship.hasPull || story.local.storyless) {
    return null;
  }
  const { approved, head_oid: head } = story.local;
  if (approved) {
    return html`<span class="ou-local-approved" title=${`Approved ${approved.at}. A new commit clears it.`}>Approved at ${shortSha(approved.head_oid)} · ${shortDateTime(approved.at)}</span> <button type="button" class="ou-local-unapprove" onClick=${() => toggleApprove(false)}>Unapprove</button>`;
  }
  let off = '';
  if (story.read_only) {
    off =
      'Open this story from the board or `once-upon page` to approve it: this link is read-only';
  } else if (!head) {
    off = 'The diff has no head yet';
  } else if (story.chapters.some((chapter) => chapter.unwritten)) {
    off = 'Some chapters are still being written';
  }
  return html`<button type="button" class="ou-local-approve" disabled=${!!off} title=${off || 'Ready to ship at this commit: marks the story reviewed and tells a session listening for it'} onClick=${() => toggleApprove(true)}>Approve</button>${ship.approveFailure ? html` <span class="ou-local-pr-stop">${ship.approveFailure}</span>` : null}`;
}
