/*
 * Push for a branch that already has an open PR, in the page's header next to Open PR #N and "N commits ahead": a fix
 * made after review that GitHub's copy of the branch lacks. The button opens the same confirm box Create pull request
 * uses, listing the commits a push would send (GET .../pr), and its own button pushes them (POST .../pr {action:
 * 'push-ahead'}): a fast-forward of the branch, never forced, refused when GitHub has commits this checkout doesn't.
 * The board's card for the PR opens this page with `#push=1`, which opens the box.
 */
import { html } from '/assets/protocol/domain/html.ts';
import { setHtml } from '/assets/panel/dom.ts';
import { plural } from '/assets/protocol/domain/text.ts';
import { ROUTES } from '/assets/protocol/routes.ts';
import { bridge, page, PARAMS } from './page.ts';
import { boxElement, commitListHtml, takeView } from './pull-request.ts';
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

function formHtml(view: PrView) {
  const blocker = blockerOf(view);
  const branch = html`<code>${view.branch || ''}</code>`;
  const sends =
    view.remote.state === 'ahead' &&
    html`<p>GitHub's ${branch} is behind. Pushing sends ${plural(view.to_push.length, 'commit')}:</p>${commitListHtml(view)}`;
  const pull =
    view.pull &&
    html`<p>Open PR: <a href="${view.pull.url}" target="_blank" rel="noopener">#${String(view.pull.number)}</a></p>`;
  return html`<form class="ou-local-pr-form">
    <h2>Push ${view.branch || 'the branch'}</h2>
    <p class="ou-local-muted">${view.repo || 'origin'}: ${branch} goes to <code>origin/${view.branch || ''}</code> as a fast-forward. It never force-pushes.</p>
    <div class="ou-local-pr-standing">${sends}${pull}</div>
    <div class="ou-local-pr-result" role="status">${blocker && html`<p class="ou-local-pr-stop">${blocker}</p>`}</div>
    <div class="ou-local-pr-buttons">
      <button type="button" data-pr-cancel>Cancel</button>
      <button type="submit" class="ou-local-pr-go"${blocker ? html` disabled` : html``}>Push</button>
    </div>
  </form>`;
}

async function submit(form: HTMLFormElement, view: PrView) {
  const goButton = form.querySelector<HTMLButtonElement>('.ou-local-pr-go')!;
  const result = form.querySelector('.ou-local-pr-result')!;
  goButton.disabled = true;
  setHtml(result, html`<p>Pushing ${view.branch}…</p>`);
  try {
    const answer = await bridge.ask(ROUTES.prPush, {
      params: PARAMS,
      body: { action: 'push-ahead', head_sha: view.head_sha },
    });
    takeView(answer.view);
    const lines = answer.output && html`<pre class="ou-local-pr-output">${answer.output}</pre>`;
    setHtml(result, html`<p class="ou-local-pr-ok">Pushed ${view.branch}.</p>${lines}`);
    goButton.textContent = 'Done';
  } catch (err) {
    setHtml(
      result,
      html`<p class="ou-local-pr-stop">The push didn't go through.</p><pre class="ou-local-pr-output">${(err as Error).message}</pre>`,
    );
    goButton.disabled = false;
  }
}

/** The header Push's click (or the board's link): the confirm box, with where GitHub's copy of the branch stands. */
export async function openPushAheadBox() {
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
  let view: PrView;
  try {
    view = await bridge.ask(ROUTES.prView, { params: PARAMS });
  } catch (err) {
    setHtml(
      box,
      html`<p class="ou-local-pr-stop">Couldn't check the branch: ${(err as Error).message}</p><div class="ou-local-pr-buttons"><button type="button" data-pr-cancel>Close</button></div>`,
    );
    return;
  }
  takeView(view);
  setHtml(box, formHtml(view));
  const form = box.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(form, view);
  });
}
