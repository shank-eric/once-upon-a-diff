/*
 * Create pull request, in the page's header. The button opens a confirm box that says where the branch stands on
 * GitHub (GET .../pr) and what a push would send, with the title and body a session handed over (`once-upon
 * pr-draft`) to check and edit. Its own button pushes the branch when it needs it (POST .../pr, never forced),
 * then opens GitHub's compare page with the title and body filled in, where the reviewer makes the PR. Once the
 * branch has an open PR, the header's button is a link to it, with how many commits the local branch is ahead of GitHub's
 * and a Push for them (push-ahead.ts).
 */
import { html as vdom } from '/assets/preact.mjs';
import { plural } from '/assets/domain/text.ts';
import { CopyButton } from '/assets/ui-kit/components/copy-button.ts';
import { CommitList, type ActionSpec } from './action-dialog.ts';
import { ROUTES } from '/assets/contracts/routes.ts';
import { bridge, PARAMS } from '/assets/local/page.ts';
import { foundPull, openDialog, takeView } from '/assets/local/actions.ts';
import { store, storyOf, type ShipState } from '/assets/local/store.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { PrView } from '/assets/types.ts';

/** Longest compare link to hand GitHub; past it the body is left out and copied instead. */
const MAX_URL = 7000;
/** How often coming back to the tab may look again for the PR (ls-remote and gh each time). */
const RECHECK_MS = 30000;

let lastLook = 0;

/** How many commits the local branch has that GitHub's copy lacks, when the view says it is a plain fast-forward behind. */
function aheadCount(view: PrView) {
  return view.remote.state === 'ahead' ? view.to_push.length : 0;
}

/** The header's button: a link to the open PR once there is one, else Create pull request (on a branch only, and not where Push ships it: push.ts). */
export function PrButtons(props: { story: LocalStoryData; ship: ShipState }) {
  const { story, ship } = props;
  if (!story.local.branch || story.local.ship === 'push') {
    return null;
  }
  const view = ship.prView;
  const pull = view && view.pull;
  if (pull) {
    const link = vdom`<a class="ou-local-pr-link" href=${pull.url} target="_blank" rel="noopener">Open PR #${String(pull.number)}</a>`;
    const behind = view && aheadCount(view);
    if (!behind) {
      return link;
    }
    const off = story.read_only
      ? 'Open this story from the board or `once-upon page` to push it: this link is read-only'
      : '';
    return vdom`<span class="ou-local-ahead">${plural(behind, 'commit')} ahead</span><button type="button" class="ou-local-push-ahead" disabled=${!!off} title=${off || 'Fast-forward this branch to GitHub, where the open PR is'} onClick=${() => openDialog('push-ahead')}>Push</button>${link}`;
  }
  return vdom`<button type="button" class="ou-local-pr" title="Push this branch if it needs it, then open GitHub's Create pull request page" onClick=${() => openDialog('pr')}>Create pull request</button>`;
}

/** Looks where the branch stands (quietly: the header button only), at most every RECHECK_MS unless forced. */
export async function lookForPull(force = false) {
  const { local } = storyOf();
  // a page opened with the read-only key may look (GET), so its Open PR link shows; only pushing is refused
  if (!local.branch || local.ship === 'push' || (!force && Date.now() - lastLook < RECHECK_MS)) {
    return;
  }
  const hadPull = store.get().ship.prView?.pull ?? null;
  lastLook = Date.now();
  try {
    const view: PrView = await bridge.ask(ROUTES.prView, { params: PARAMS });
    if (hadPull && !view.pull) {
      view.pull = hadPull; // gh not answering for a moment doesn't close a PR already seen
    }
    takeView(view);
    if (view.pull && !hadPull) {
      foundPull(); // Approve goes: the PR is the next step
    }
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

/** What the push would do, and why the box won't push when it can't. */
function standing(view: PrView) {
  const branch = vdom`<code>${view.branch || ''}</code>`;
  const count = plural(view.to_push.length, 'commit');
  let says;
  switch (view.remote.state) {
    case 'missing':
      says = vdom`<p>${branch} isn't on GitHub yet. Pushing sends ${count}:</p><${CommitList} view=${view} />`;
      break;
    case 'ahead':
      says = vdom`<p>GitHub's ${branch} is behind. Pushing sends ${count}:</p><${CommitList} view=${view} />`;
      break;
    case 'same':
      says = vdom`<p>${branch} is on GitHub and up to date, so there's nothing to push.</p>`;
      break;
    case 'diverged':
      says = vdom`<p class="ou-local-pr-stop">GitHub's ${branch} has commits this checkout doesn't, so a push would be refused. Pull them, then open this box again. It never force-pushes.</p>`;
      break;
    default:
      says = vdom`<p class="ou-local-pr-stop">${view.remote.error || "Couldn't reach origin."}</p>`;
  }
  const pull =
    view.pull &&
    vdom`<p>Open PR: <a href="${view.pull.url}" target="_blank" rel="noopener">#${String(view.pull.number)}</a></p>`;
  return vdom`${says}${pull}`;
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

function lead(view: PrView) {
  return vdom`<p class="ou-local-muted">${view.repo || 'origin'}: <code>${view.branch || ''}</code> into
    <input name="base" class="ou-local-pr-base" value="${view.base}" aria-label="Base branch" spellcheck="false" /></p>`;
}

function fields(view: PrView) {
  const draft = view.draft;
  const note = draft
    ? vdom`Title and body handed over by a session (<code>once-upon pr-draft</code>). Edit them here or on GitHub.`
    : vdom`No title and body were handed over. Leave them empty and GitHub fills them from the commits.`;
  return vdom`<label>Title<input name="title" value="${draft ? draft.title : ''}" /></label>
    <label>Body<textarea name="body" rows="12" value="${draft ? draft.body : ''}"></textarea></label>
    <p class="ou-local-muted">${note}</p>`;
}

/** What a field in the box holds. */
const fieldOf = (form: HTMLFormElement, name: string) =>
  (form.querySelector(`[name="${name}"]`) as HTMLInputElement).value;

/** After the push: where the PR page opened, and the body to copy when the link couldn't carry it. */
function done(url: string, body: string, bodyLeftOut: boolean, opened: boolean) {
  const where = opened
    ? vdom`GitHub's Create pull request page is open in a new tab. Check it there and click <b>Create pull request</b>.`
    : vdom`Open <a href="${url}" target="_blank" rel="noopener">GitHub's Create pull request page</a>, check it, and click <b>Create pull request</b>.`;
  const copy =
    bodyLeftOut &&
    vdom`<p>The body is too long for the link, so it's left out there. <${CopyButton} text=${body} onFailed=${() => "Couldn't copy"} attrs=${{ 'data-pr-copy-body': true }}>Copy body</${CopyButton}> and paste it in.</p>`;
  return vdom`<p class="ou-local-pr-ok">${where}</p>${copy}`;
}

async function create(view: PrView, form: HTMLFormElement) {
  const base = fieldOf(form, 'base').trim() || view.base;
  const title = fieldOf(form, 'title').trim();
  const body = fieldOf(form, 'body').trim();
  const { url, bodyLeftOut } = compareUrl(
    view.repo as string,
    base,
    view.branch as string,
    title,
    body,
  );
  // opened now, on the click, so the browser doesn't block it once the push is done
  const tab = window.open('about:blank', '_blank');
  if (tab) {
    tab.opener = null;
  }
  let output = '';
  try {
    if (view.remote.state !== 'same') {
      const answer = await bridge.ask(ROUTES.prPush, {
        params: PARAMS,
        body: { action: 'push', head_sha: view.head_sha },
      });
      output = answer.output;
      takeView(answer.view);
    }
  } catch (err) {
    if (tab) {
      tab.close();
    }
    throw err;
  }
  if (tab) {
    tab.location.href = url;
  }
  lastLook = 0; // look for the new PR when they come back from GitHub
  return { ok: done(url, body, bodyLeftOut, !!tab), output };
}

/** The Create pull request box: where the branch stands, and the button that pushes it if it needs it and opens GitHub's compare page. */
export function prSpec(story: LocalStoryData): ActionSpec<PrView> {
  return {
    refusal: story.read_only
      ? // a read-only link carries the read-only key, which can't push: say where to open the story, rather than fail on a click
        {
          title: 'Create pull request',
          cant: 'push its branch',
          to: 'push and open the PR',
          story: story.id,
        }
      : null,
    checking: `Checking where ${story.local.branch || 'the branch'} stands on GitHub…`,
    load: () => bridge.ask(ROUTES.prView, { params: PARAMS }),
    loaded: takeView,
    title: () => 'Create pull request',
    lead,
    standing,
    fields,
    blocker: blockerOf,
    goLabel: (view) =>
      view.remote.state !== 'same' ? 'Push and open on GitHub' : 'Open on GitHub',
    working: (view) => (view.remote.state !== 'same' ? `Pushing ${view.branch}…` : null),
    go: create,
  };
}
