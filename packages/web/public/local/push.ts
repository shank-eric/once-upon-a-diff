/*
 * Push, in the page's header, for a story whose commits go straight to the repo's default branch (the bridge decides:
 * config.json's `ship` rules, else by branch; Create pull request is for every other story). The button opens the same
 * confirm box Create pull request uses. It says where origin's branch stands (GET .../push) and what a push would send,
 * and its own button pushes the approved commit (POST .../push, a fast-forward, never forced). The button is off until
 * the story is approved, except on a storyless review, where the head the page shows is what it pushes. When GitHub protects the branch or requires pull requests, the box refuses and offers Create
 * pull request. The board's Ready to ship card opens this page with `#push=1` in its link, which opens the box.
 */
import { html } from '/assets/protocol/domain/html.ts';
import { setHtml } from '/assets/ui/dom.ts';
import { plural } from '/assets/protocol/domain/text.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { bridge, page, PARAMS } from './page.ts';
import { boxElement, commitListHtml, openPrBox } from './pull-request.ts';
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

function standingHtml(view: PushView) {
  const branch = html`<code>${view.branch || ''}</code>`;
  const later =
    view.later > 0 &&
    html`<p class="ou-local-muted">${plural(view.later, 'later commit')} on your ${branch} ${view.later === 1 ? "isn't" : "aren't"} approved and stay local.</p>`;
  if (view.remote.state === 'ahead') {
    return html`<p>GitHub's ${branch} is behind. Pushing sends ${plural(view.to_push.length, 'commit')}:</p>${commitListHtml(view)}${later}`;
  }
  return html`${later}`;
}

function formHtml(view: PushView) {
  const sha = view.approved_sha ? view.approved_sha.slice(0, 7) : '';
  const which = page.story.local.storyless ? 'the commit shown' : 'the approved commit';
  const blocked = !!view.blocker;
  const offer =
    view.pr_instead && html`<button type="button" data-push-pr>Create pull request</button>`;
  return html`<form class="ou-local-pr-form">
    <h2>Push to ${view.branch || 'the default branch'}</h2>
    <p class="ou-local-muted">${view.repo || 'origin'}: ${which} ${sha && html`<code>${sha}</code>`} goes straight to <code>origin/${view.branch || ''}</code> as a fast-forward. It never force-pushes.</p>
    <div class="ou-local-pr-standing">${standingHtml(view)}</div>
    <div class="ou-local-pr-result" role="status">${view.blocker && html`<p class="ou-local-pr-stop">${view.blocker}</p>`}</div>
    <div class="ou-local-pr-buttons">
      <button type="button" data-pr-cancel>Cancel</button>
      ${offer}
      <button type="submit" class="ou-local-pr-go"${blocked && html` disabled`}>Push</button>
    </div>
  </form>`;
}

async function submit(form: HTMLFormElement, view: PushView) {
  const goButton = form.querySelector<HTMLButtonElement>('.ou-local-pr-go')!;
  const result = form.querySelector('.ou-local-pr-result')!;
  goButton.disabled = true;
  setHtml(result, html`<p>Pushing to ${view.branch || 'origin'}…</p>`);
  try {
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
    const lines = answer.output && html`<pre class="ou-local-pr-output">${answer.output}</pre>`;
    setHtml(
      result,
      html`<p class="ou-local-pr-ok">Pushed ${pushedAt} to ${view.branch || 'origin'}.</p>${lines}`,
    );
    goButton.textContent = 'Done';
  } catch (err) {
    setHtml(
      result,
      html`<p class="ou-local-pr-stop">The push didn't go through.</p><pre class="ou-local-pr-output">${(err as Error).message}</pre>`,
    );
    goButton.disabled = false;
  }
}

/** The header button's click (or the board's link): the confirm box, with where origin's branch stands. */
export async function openPushBox() {
  const box = boxElement();
  if (page.story.read_only) {
    setHtml(
      box,
      html`<form class="ou-local-pr-form"><h2>Push</h2>
        <p>This page was opened with a read-only link, which can read the story but not push.</p>
        <p>To push, open the story from the agent board (<b>Open story</b>) or run <code>once-upon page --story ${page.story.id}</code>.</p>
        <div class="ou-local-pr-buttons"><button type="button" data-pr-cancel>Close</button></div></form>`,
    );
    box.showModal();
    return;
  }
  setHtml(box, html`<p class="ou-local-muted">Checking where GitHub's branch stands…</p>`);
  box.showModal();
  let view: PushView;
  try {
    view = await bridge.ask(ROUTES.pushView, { params: PARAMS });
  } catch (err) {
    setHtml(
      box,
      html`<p class="ou-local-pr-stop">Couldn't check the branch: ${(err as Error).message}</p><div class="ou-local-pr-buttons"><button type="button" data-pr-cancel>Close</button></div>`,
    );
    return;
  }
  setHtml(box, formHtml(view));
  const form = box.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(form, view);
  });
  form.querySelector('[data-push-pr]')?.addEventListener('click', () => {
    box.close();
    openPrBox();
  });
}

window.addEventListener('ou-approval-changed', redrawPush);
