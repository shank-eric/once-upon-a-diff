/*
 * Approve, in the page's header: "this is ready to ship at this commit". One POST .../approve with the head the page
 * shows (the bridge refuses it when the branch has moved), which marks the story reviewed and tells a listening session.
 * Approved, the header shows when and at which commit, with Unapprove. A new commit clears it on the bridge, and the
 * page's next reload of the story (its version changed) draws the button again. Not shown once the branch has a PR.
 * The read-only link can't approve (the full page key only), so there the button is off and says why. A storyless review
 * (no story told) has no Approve: seeing the diff and clicking Push or Create pull request is the approval.
 */
import { html } from '/assets/protocol/domain/html.ts';
import { setHtml } from '/assets/ui/dom.ts';
import { shortDateTime } from '/assets/protocol/domain/time.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { bridge, page, PARAMS } from './page.ts';

/** Set by pull-request.ts when the branch turns out to have an open PR (an event, so the two files don't import each other). */
let hasPull = false;
let failure = '';

/** The header's Approve button, or the approved chip with Unapprove. */
export function approveHtml() {
  if (hasPull || page.story.local.storyless) {
    return html``;
  }
  const { approved, head_oid: head } = page.story.local;
  if (approved) {
    return html`<span class="ou-local-approved" title="Approved ${approved.at}. A new commit clears it.">Approved at ${approved.head_oid.slice(0, 7)} · ${shortDateTime(approved.at)}</span> <button type="button" class="ou-local-unapprove">Unapprove</button>`;
  }
  let off = '';
  if (page.story.read_only) {
    off =
      'Open this story from the board or `once-upon page` to approve it: this link is read-only';
  } else if (!head) {
    off = 'The diff has no head yet';
  } else if (page.story.chapters.some((chapter) => chapter.unwritten)) {
    off = 'Some chapters are still being written';
  }
  return html`<button type="button" class="ou-local-approve"${off && html` disabled`} title="${off || 'Ready to ship at this commit: marks the story reviewed and tells a session listening for it'}">Approve</button>${failure && html` <span class="ou-local-pr-stop">${failure}</span>`}`;
}

export function redrawApprove() {
  const holder = document.querySelector('.ou-local-approve-holder');
  if (holder) {
    setHtml(holder, approveHtml());
  }
  window.dispatchEvent(new Event('ou-approval-changed')); // Push (push.ts) is off until the story is approved
}

/** Approve (or Unapprove) was clicked. */
export async function toggleApprove(approve: boolean) {
  failure = '';
  try {
    const answer = await bridge.ask(ROUTES.approve, {
      params: PARAMS,
      body: { approved: approve, head_sha: page.story.local.head_oid },
    });
    page.story.local.approved = answer.approved;
  } catch (err) {
    failure = (err as Error).message;
  }
  redrawApprove();
}

window.addEventListener('ou-pushed', () => {
  hasPull = true; // the commit is on GitHub: nothing left to approve
  redrawApprove();
});

window.addEventListener('ou-pull-found', () => {
  hasPull = true;
  redrawApprove();
});
