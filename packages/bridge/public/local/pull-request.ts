/*
 * Create pull request, in the page's header. The button opens a confirm box that says where the branch stands on
 * GitHub (GET .../pr) and what a push would send, with the title and body a session handed over (`once-upon
 * pr-draft`) to check and edit. Its own button pushes the branch when it needs it (POST .../pr, never forced),
 * then opens GitHub's compare page with the title and body filled in, where the reviewer makes the PR. Once the
 * branch has an open PR, the header's button is a link to it.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { plural } from '/assets/util/text.ts';
import { writeClipboard } from '/assets/util/clipboard.ts';
import { api, page, STORY_PATH } from './page.ts';
import type { PrPushAnswer, PrView } from '/assets/types.ts';

/** Longest compare link to hand GitHub; past it the body is left out and copied instead. */
const MAX_URL = 7000;
/** How often coming back to the tab may look again for the PR (ls-remote and gh each time). */
const RECHECK_MS = 30000;

let lastView: PrView | null = null;
let lastLook = 0;

/** The header's button: a link to the open PR once there is one, else Create pull request (on a branch only). */
export function prButtonHtml() {
  if (!page.story.local.branch) {
    return html``;
  }
  const pull = lastView && lastView.pull;
  if (pull) {
    return html`<a class="ou-local-pr-link" href="${pull.url}" target="_blank" rel="noopener">Open PR #${String(pull.number)}</a>`;
  }
  return html`<button type="button" class="ou-local-pr" title="Push this branch if it needs it, then open GitHub's Create pull request page">Create pull request</button>`;
}

function redrawButton() {
  const holder = document.querySelector('.ou-local-pr-holder');
  if (holder) {
    setHtml(holder, prButtonHtml());
  }
}

/** Looks where the branch stands (quietly: the header button only), at most every RECHECK_MS unless forced. */
export async function lookForPull(force = false) {
  if (!page.story.local.branch || (!force && Date.now() - lastLook < RECHECK_MS)) {
    return;
  }
  if (lastView && lastView.pull) {
    return;
  }
  lastLook = Date.now();
  try {
    lastView = await api<PrView>('GET', `${STORY_PATH}/pr`);
    redrawButton();
  } catch {
    /* the bridge may be restarting; the button still works */
  }
}

/** A ref as a compare-link path: each part encoded, the slashes kept (test/cypress-fixes). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** GitHub's compare page for the PR, with the title and body when the link isn't too long for the body. */
export function compareUrl(
  repo: string,
  base: string,
  branch: string,
  title: string,
  body: string,
): { url: string; bodyLeftOut: boolean } {
  const plain = `https://github.com/${repo}/compare/${refPath(base)}...${refPath(branch)}?expand=1`;
  const withTitle = title ? `${plain}&title=${encodeURIComponent(title)}` : plain;
  const withBody = body ? `${withTitle}&body=${encodeURIComponent(body)}` : withTitle;
  if (withBody.length <= MAX_URL) {
    return { url: withBody, bodyLeftOut: false };
  }
  return { url: withTitle, bodyLeftOut: true };
}

function commitListHtml(view: PrView) {
  const shown = view.to_push.map(
    (commit) => html`<li><code>${commit.sha.slice(0, 7)}</code> ${commit.subject}</li>`,
  );
  return html`<ul class="ou-local-pr-commits">${shown}</ul>`;
}

/** What the push would do, and why the box won't push when it can't. */
function standingHtml(view: PrView) {
  const branch = html`<code>${view.branch || ''}</code>`;
  const count = plural(view.to_push.length, 'commit');
  switch (view.remote.state) {
    case 'missing':
      return html`<p>${branch} isn't on GitHub yet. Pushing sends ${count}:</p>${commitListHtml(view)}`;
    case 'ahead':
      return html`<p>GitHub's ${branch} is behind. Pushing sends ${count}:</p>${commitListHtml(view)}`;
    case 'same':
      return html`<p>${branch} is on GitHub and up to date, so there's nothing to push.</p>`;
    case 'diverged':
      return html`<p class="ou-local-pr-stop">GitHub's ${branch} has commits this checkout doesn't, so a push would be refused. Pull them, then open this box again. It never force-pushes.</p>`;
    default:
      return html`<p class="ou-local-pr-stop">${view.remote.error || "Couldn't reach origin."}</p>`;
  }
}

/** Why the box's button is off, or null when it can go. */
function blockerOf(view: PrView): string | null {
  if (!view.repo) {
    return "This checkout's origin isn't a GitHub repo.";
  }
  if (view.pull) {
    return `${view.branch} already has an open PR.`;
  }
  if (!view.branch || !view.head_sha) {
    return view.remote.error || 'No branch to open a PR from.';
  }
  if (view.remote.state === 'diverged' || view.remote.state === 'unreachable') {
    return 'Nothing to do here until that is sorted.';
  }
  return null;
}

function formHtml(view: PrView) {
  const draft = view.draft;
  const blocker = blockerOf(view);
  const pushes = view.remote.state !== 'same';
  const goLabel = pushes ? 'Push and open on GitHub' : 'Open on GitHub';
  const draftNote = draft
    ? html`Title and body handed over by a session (<code>once-upon pr-draft</code>). Edit them here or on GitHub.`
    : html`No title and body were handed over. Leave them empty and GitHub fills them from the commits.`;
  const pull =
    view.pull &&
    html`<p>Open PR: <a href="${view.pull.url}" target="_blank" rel="noopener">#${String(view.pull.number)}</a></p>`;
  return html`<form class="ou-local-pr-form">
    <h2>Create pull request</h2>
    <p class="ou-local-muted">${view.repo || 'origin'}: <code>${view.branch || ''}</code> into
      <input name="base" class="ou-local-pr-base" value="${view.base}" aria-label="Base branch" spellcheck="false"></p>
    <div class="ou-local-pr-standing">${standingHtml(view)}${pull}</div>
    <label>Title<input name="title" value="${draft ? draft.title : ''}"></label>
    <label>Body<textarea name="body" rows="12">${draft ? draft.body : ''}</textarea></label>
    <p class="ou-local-muted">${draftNote}</p>
    <div class="ou-local-pr-result" role="status">${blocker && html`<p class="ou-local-pr-stop">${blocker}</p>`}</div>
    <div class="ou-local-pr-buttons">
      <button type="button" data-pr-cancel>Cancel</button>
      <button type="submit" class="ou-local-pr-go"${blocker ? html` disabled` : html``}>${goLabel}</button>
    </div>
  </form>`;
}

function boxElement(): HTMLDialogElement {
  let box = document.getElementById('ou-local-pr-box') as HTMLDialogElement | null;
  if (!box) {
    box = document.createElement('dialog');
    box.id = 'ou-local-pr-box';
    box.addEventListener('click', (event) => {
      const target = event.target as Element;
      if (target === box || target.closest('[data-pr-cancel]')) {
        box!.close();
      }
    });
    document.body.appendChild(box);
  }
  return box;
}

/** After the push: where the PR page opened, git's lines, and the body to copy when the link couldn't carry it. */
function doneHtml(url: string, bodyLeftOut: boolean, opened: boolean, output: string) {
  const where = opened
    ? html`GitHub's Create pull request page is open in a new tab. Check it there and click <b>Create pull request</b>.`
    : html`Open <a href="${url}" target="_blank" rel="noopener">GitHub's Create pull request page</a>, check it, and click <b>Create pull request</b>.`;
  const copy =
    bodyLeftOut &&
    html`<p>The body is too long for the link, so it's left out there. <button type="button" data-pr-copy-body>Copy body</button> and paste it in.</p>`;
  const lines = output && html`<pre class="ou-local-pr-output">${output}</pre>`;
  return html`<p class="ou-local-pr-ok">${where}</p>${copy}${lines}`;
}

async function submit(form: HTMLFormElement, view: PrView) {
  const fields = new FormData(form);
  const base = String(fields.get('base') || '').trim() || view.base;
  const title = String(fields.get('title') || '').trim();
  const body = String(fields.get('body') || '').trim();
  const { url, bodyLeftOut } = compareUrl(
    view.repo as string,
    base,
    view.branch as string,
    title,
    body,
  );
  const goButton = form.querySelector<HTMLButtonElement>('.ou-local-pr-go')!;
  const result = form.querySelector('.ou-local-pr-result')!;
  // opened now, on the click, so the browser doesn't block it once the push is done
  const tab = window.open('about:blank', '_blank');
  if (tab) {
    tab.opener = null;
  }
  goButton.disabled = true;
  let output = '';
  try {
    if (view.remote.state !== 'same') {
      setHtml(result, html`<p>Pushing ${view.branch}…</p>`);
      const answer = await api<PrPushAnswer>('POST', `${STORY_PATH}/pr`, {
        action: 'push',
        head_sha: view.head_sha,
      });
      output = answer.output;
      lastView = answer.view;
    }
  } catch (err) {
    if (tab) {
      tab.close();
    }
    setHtml(
      result,
      html`<p class="ou-local-pr-stop">The push didn't go through.</p><pre class="ou-local-pr-output">${(err as Error).message}</pre>`,
    );
    goButton.disabled = false;
    return;
  }
  if (tab) {
    tab.location.href = url;
  }
  setHtml(result, doneHtml(url, bodyLeftOut, !!tab, output));
  const copyButton = result.querySelector<HTMLButtonElement>('[data-pr-copy-body]');
  if (copyButton) {
    copyButton.onclick = async () => {
      copyButton.textContent = (await writeClipboard(body)) ? 'Copied' : "Couldn't copy";
    };
  }
  goButton.textContent = 'Done';
  lastLook = 0; // look for the new PR when they come back from GitHub
}

/** The header button's click: the confirm box, with where the branch stands. */
export async function openPrBox() {
  const box = boxElement();
  setHtml(
    box,
    html`<p class="ou-local-muted">Checking where ${page.story.local.branch || 'the branch'} stands on GitHub…</p>`,
  );
  box.showModal();
  let view: PrView;
  try {
    view = await api<PrView>('GET', `${STORY_PATH}/pr`);
  } catch (err) {
    setHtml(
      box,
      html`<p class="ou-local-pr-stop">Couldn't check the branch: ${(err as Error).message}</p><div class="ou-local-pr-buttons"><button type="button" data-pr-cancel>Close</button></div>`,
    );
    return;
  }
  lastView = view;
  redrawButton();
  setHtml(box, formHtml(view));
  const form = box.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(form, view);
  });
}
