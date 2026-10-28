/*
 * Approve, in the page's header: "this is ready to ship at this commit". One POST .../approve with the head the page
 * shows (the bridge refuses it when the branch has moved), which marks the story reviewed and tells a listening session.
 * Approved, the header shows when and at which commit, with Unapprove. A new commit clears it on the bridge, and the
 * page's next reload of the story (its version changed) draws the button again. Not shown once the branch has a PR.
 * The read-only link can't approve (the full page key only), so there the button is off and says why.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { shortDateTime } from '/assets/util/time.ts';
import { api, page, STORY_PATH } from './page.ts';

/** Set by pull-request.ts when the branch turns out to have an open PR (an event, so the two files don't import each other). */
let hasPull = false;
let failure = '';

/** The header's Approve button, or the approved chip with Unapprove. */
export function approveHtml() {
  if (hasPull) {
    return html``;
  }
  const { approved, head_oid: head } = page.story.local;
  if (approved) {
    return html`<span class="ou-local-approved" title="Approved ${approved.at}. A new commit clears it.">Approved at ${approved.head_oid.slice(0, 7)} · ${shortDateTime(approved.at)}</span> <button type="button" class="ou-local-unapprove">Unapprove</button>`;
  }
  let off = '';
  if (page.story.read_only) {
    off =
      'Open this story from the board or `once-upon page` to approve it: the inbox link is read-only';
  } else if (!head) {
    off = 'The diff has no head yet';
  }
  return html`<button type="button" class="ou-local-approve"${off && html` disabled`} title="${off || 'Ready to ship at this commit: marks the story reviewed and tells a session listening for it'}">Approve</button>${failure && html` <span class="ou-local-pr-stop">${failure}</span>`}`;
}

export function redrawApprove() {
  const holder = document.querySelector('.ou-local-approve-holder');
  if (holder) {
    setHtml(holder, approveHtml());
  }
}

/** Approve (or Unapprove) was clicked. */
export async function toggleApprove(approve: boolean) {
  failure = '';
  try {
    const answer = await api<{ approved: { at: string; head_oid: string } | null }>(
      'POST',
      `${STORY_PATH}/approve`,
      { approved: approve, head_sha: page.story.local.head_oid },
    );
    page.story.local.approved = answer.approved;
  } catch (err) {
    failure = (err as Error).message;
  }
  redrawApprove();
}

window.addEventListener('ou-pull-found', () => {
  hasPull = true;
  redrawApprove();
});
