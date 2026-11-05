/*
 * Push for a branch that already has an open PR, in the page's header next to Open PR #N and "N commits ahead": a fix
 * made after review that GitHub's copy of the branch lacks. The button opens the same confirm box Create pull request
 * uses (action-dialog.ts), listing the commits a push would send (GET .../pr), and its own button pushes them (POST .../pr {action:
 * 'push-ahead'}): a fast-forward of the branch, never forced, refused when GitHub has commits this checkout doesn't.
 * The board's card for the PR opens this page with `#push=1`, which opens the box.
 */
import { html } from '/assets/preact.mjs';
import { plural } from '/assets/domain/text.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { bridge, page, PARAMS } from '/assets/local/page.ts';
import { CommitList, openActionDialog } from './action-dialog.ts';
import { takeView } from './pull-request.ts';
import type { PrView } from '/assets/types.ts';

/** Why the box's Push can't go, or null when it can. */
function blockerOf(view: PrView): string | null {
  if (!view.repo) {
    return "This checkout's origin isn't a GitHub repo.";
  }
  if (!view.pull) {
    return `${view.branch || 'This branch'} has no open PR here: use Create pull request.`;
  }
  if (!view.branch || !view.head_sha) {
    return view.remote.error || 'No branch to push.';
  }
  switch (view.remote.state) {
    case 'diverged':
      return "GitHub's copy has commits this checkout doesn't. Pull first, then open this box again. It never force-pushes.";
    case 'unreachable':
      return view.remote.error || "Couldn't reach origin.";
    case 'missing':
      return `origin has no ${view.branch}: use Create pull request.`;
    case 'same':
      return `${view.branch} is on GitHub and up to date: nothing to push.`;
    default:
      return null;
  }
}

function lead(view: PrView) {
  return html`<p class="ou-local-muted">${view.repo || 'origin'}: <code>${view.branch || ''}</code> goes to <code>origin/${view.branch || ''}</code> as a fast-forward. It never force-pushes.</p>`;
}

function standing(view: PrView) {
  const branch = html`<code>${view.branch || ''}</code>`;
  const sends =
    view.remote.state === 'ahead' &&
    html`<p>GitHub's ${branch} is behind. Pushing sends ${plural(view.to_push.length, 'commit')}:</p><${CommitList} view=${view} />`;
  const pull =
    view.pull &&
    html`<p>Open PR: <a href="${view.pull.url}" target="_blank" rel="noopener">#${String(view.pull.number)}</a></p>`;
  return html`${sends}${pull}`;
}

/** The header Push's click (or the board's link): the confirm box, with where GitHub's copy of the branch stands. */
export function openPushAheadBox() {
  openActionDialog<PrView>({
    refusal: page.story.read_only
      ? { title: 'Push', cant: 'push', to: 'push', story: page.story.id }
      : null,
    checking: "Checking where GitHub's branch stands…",
    load: () => bridge.ask(ROUTES.prView, { params: PARAMS }),
    loaded: takeView,
    title: (view) => `Push ${view.branch || 'the branch'}`,
    lead,
    standing,
    blocker: blockerOf,
    goLabel: () => 'Push',
    working: (view) => `Pushing ${view.branch}…`,
    go: async (view) => {
      const answer = await bridge.ask(ROUTES.prPush, {
        params: PARAMS,
        body: { action: 'push-ahead', head_sha: view.head_sha },
      });
      takeView(answer.view);
      return {
        ok: html`<p class="ou-local-pr-ok">Pushed ${view.branch}.</p>`,
        output: answer.output,
      };
    },
  });
}
