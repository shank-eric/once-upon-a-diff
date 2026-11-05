/*
 * Push, in the page's header, for a story whose commits go straight to the repo's default branch (the bridge decides:
 * config.json's `ship` rules, else by branch; Create pull request is for every other story). The button opens the same
 * confirm box Create pull request uses (action-dialog.ts). It says where origin's branch stands (GET .../push) and what a push would send,
 * and its own button pushes the approved commit (POST .../push, a fast-forward, never forced). The button is off until
 * the story is approved, except on a storyless review, where the head the page shows is what it pushes. When GitHub protects the branch or requires pull requests, the box refuses and offers Create
 * pull request. The board's Ready to ship card opens this page with `#push=1` in its link, which opens the box.
 */
import { html as vdom } from '/assets/preact.mjs';
import { plural, shortSha } from '/assets/domain/text.ts';
import { ROUTES } from '/assets/contracts/routes.ts';
import { bridge, PARAMS } from '/assets/local/page.ts';
import { openDialog, pushed } from '/assets/local/actions.ts';
import { storyOf, type ShipState } from '/assets/local/store.ts';
import { CommitList, type ActionSpec } from './action-dialog.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { PushView } from '/assets/types.ts';

/** The header's Push button, off until the story is approved; empty on a story that ships by pull request. */
export function PushButton(props: { story: LocalStoryData; ship: ShipState }) {
  const { story, ship } = props;
  const local = story.local;
  if (local.ship !== 'push') {
    return null;
  }
  if (ship.pushedAt) {
    return vdom`<span class="ou-local-approved">Pushed ${ship.pushedAt}</span>`;
  }
  let off = '';
  if (story.read_only) {
    off = 'Open this story from the board or `once-upon page` to push it: this link is read-only';
  } else if (!local.approved && !local.storyless) {
    off = 'Approve the story first: Push sends the approved commit';
  }
  const does = local.storyless
    ? 'Fast-forward this commit to the default branch on GitHub'
    : 'Fast-forward the approved commit to the default branch on GitHub';
  return vdom`<button type="button" class="ou-local-push" disabled=${!!off} title=${off || does} onClick=${() => openDialog('push')}>Push</button>`;
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
  const sha = shortSha(view.approved_sha);
  const which = storyOf().local.storyless ? 'the commit shown' : 'the approved commit';
  return vdom`<p class="ou-local-muted">${view.repo || 'origin'}: ${which} ${sha && vdom`<code>${sha}</code>`} goes straight to <code>origin/${view.branch || ''}</code> as a fast-forward. It never force-pushes.</p>`;
}

async function push(view: PushView) {
  const answer = await bridge.ask(ROUTES.pushApproved, {
    params: PARAMS,
    // a storyless review sends the head its diff was drawn at: that is what the click approves
    body: {
      action: 'push',
      head_sha: storyOf().local.storyless ? storyOf().local.head_oid : view.approved_sha,
    },
  });
  const pushedAt = view.approved_sha ? shortSha(view.approved_sha) : 'now';
  pushed(pushedAt); // the header says so, and Approve goes: the commit is on GitHub
  return {
    ok: vdom`<p class="ou-local-pr-ok">Pushed ${pushedAt} to ${view.branch || 'origin'}.</p>`,
    output: answer.output,
  };
}

/** The Push box: where origin's branch stands, and the button that pushes the approved commit. */
export function pushSpec(story: LocalStoryData): ActionSpec<PushView> {
  return {
    refusal: story.read_only ? { title: 'Push', cant: 'push', to: 'push', story: story.id } : null,
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
        openDialog('pr');
      }}>Create pull request</button>`,
  };
}
