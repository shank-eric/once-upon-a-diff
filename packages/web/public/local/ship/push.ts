/*
 * Push, in the page's header, for a story whose commits go straight to the repo's default branch (the bridge decides:
 * config.json's `ship` rules, else by branch; Create pull request is for every other story). The button opens the same
 * confirm box Create pull request uses (action-dialog.ts). It says where origin's branch stands (GET .../push) and what a push would send,
 * and its own button pushes the approved commit (POST .../push, a fast-forward, never forced). The button is off until
 * the story is approved, except on a storyless review, where the head the page shows is what it pushes. When GitHub protects the branch or requires pull requests, the box refuses and offers Create
 * pull request. The board's Ready to ship card opens this page with `#push=1` in its link, which opens the box.
 */
import { html } from '/assets/protocol/domain/html.ts';
import { setHtml } from '/assets/ui/dom.ts';
import { plural } from '/assets/protocol/domain/text.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { bridge, page, PARAMS } from '/assets/local/page.ts';
import { html as vdom } from '/assets/preact.mjs';
import { CommitList, openActionDialog } from './action-dialog.ts';
import { openPrBox } from './pull-request.ts';
import type { PushView } from '/assets/types.ts';

/** Set once a push has gone through, so the header says so until the page is reloaded. */
let pushedAt: string | null = null;

/** The header's Push button, off until the story is approved; empty on a story that ships by pull request. */
export function pushButtonHtml() {
  const local = page.story.local;
  if (local.ship !== 'push') {
    return html``;
  }
  if (pushedAt) {
    return html`<span class="ou-local-approved">Pushed ${pushedAt}</span>`;
  }
  let off = '';
  if (page.story.read_only) {
    off = 'Open this story from the board or `once-upon page` to push it: this link is read-only';
  } else if (!local.approved && !local.storyless) {
    off = 'Approve the story first: Push sends the approved commit';
  }
  const does = local.storyless
    ? 'Fast-forward this commit to the default branch on GitHub'
    : 'Fast-forward the approved commit to the default branch on GitHub';
  return html`<button type="button" class="ou-local-push"${off && html` disabled`} title="${off || does}">Push</button>`;
}

export function redrawPush() {
  const holder = document.querySelector('.ou-local-push-holder');
  if (holder) {
    setHtml(holder, pushButtonHtml());
  }
}

function standing(view: PushView) {
  const branch = vdom`<code>${view.branch || ''}</code>`;
  const later =
    view.later > 0 &&
    vdom`<p class="ou-local-muted">${plural(view.later, 'later commit')} on your ${branch} ${view.later === 1 ? "isn't" : "aren't"} approved and stay local.</p>`;
  if (view.remote.state === 'ahead') {
    return vdom`<p>GitHub's ${branch} is behind. Pushing sends ${plural(view.to_push.length, 'commit')}:</p><${CommitList} view=${view} />${later}`;
  }
  return later;
}

function lead(view: PushView) {
  const sha = view.approved_sha ? view.approved_sha.slice(0, 7) : '';
  const which = page.story.local.storyless ? 'the commit shown' : 'the approved commit';
  return vdom`<p class="ou-local-muted">${view.repo || 'origin'}: ${which} ${sha && vdom`<code>${sha}</code>`} goes straight to <code>origin/${view.branch || ''}</code> as a fast-forward. It never force-pushes.</p>`;
}

async function push(view: PushView) {
  const answer = await bridge.ask(ROUTES.pushApproved, {
    params: PARAMS,
    // a storyless review sends the head its diff was drawn at: that is what the click approves
    body: {
      action: 'push',
      head_sha: page.story.local.storyless ? page.story.local.head_oid : view.approved_sha,
    },
  });
  pushedAt = view.approved_sha ? view.approved_sha.slice(0, 7) : 'now';
  page.story.local.approved = null;
  redrawPush();
  window.dispatchEvent(new Event('ou-pushed')); // Approve goes: the commit is on GitHub
  return {
    ok: vdom`<p class="ou-local-pr-ok">Pushed ${pushedAt} to ${view.branch || 'origin'}.</p>`,
    output: answer.output,
  };
}

/** The header button's click (or the board's link): the confirm box, with where origin's branch stands. */
export function openPushBox() {
  openActionDialog<PushView>({
    refusal: page.story.read_only
      ? { title: 'Push', cant: 'push', to: 'push', story: page.story.id }
      : null,
    checking: "Checking where GitHub's branch stands…",
    load: () => bridge.ask(ROUTES.pushView, { params: PARAMS }),
    title: (view) => `Push to ${view.branch || 'the default branch'}`,
    lead,
    standing,
    blocker: (view) => view.blocker,
    goLabel: () => 'Push',
    working: (view) => `Pushing to ${view.branch || 'origin'}…`,
    go: push,
    extra: (view, close) =>
      view.pr_instead &&
      vdom`<button type="button" data-push-pr onClick=${() => {
        close();
        openPrBox();
      }}>Create pull request</button>`,
  });
}

window.addEventListener('ou-approval-changed', redrawPush);
