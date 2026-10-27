/*
 * The review inbox page: the built PR stories waiting for review, newest first, with the unreviewed ones marked. They
 * open on the PR's changes page, where the panel is, and Mark reviewed ticks them off (GitHub's own marks tick them
 * too). The page's key (the link's #key=, which `once-upon review` and the extension print) reaches the inbox routes
 * and nothing else.
 */
import { authHeader, startAuth } from '/assets/local/auth.ts';
import { notConnectedHtml } from '/assets/local/not-connected.ts';
import { openMenu } from '/assets/local/menu.ts';
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { shortDateTime } from '/assets/util/time.ts';
import type { InboxList, InboxStory } from '/assets/types.ts';

/** Like the board: new stories show up without a reload. */
const POLL_MS = 3000;
const app = document.getElementById('ou-inbox-app') as HTMLElement;
const params = new URLSearchParams(location.hash.slice(1));
const KEY = params.get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board/link');

/** What the page shows: the repo filter (from the link's #repo=, then the select), and whether reviewed stories are listed. */
const view = { repo: params.get('repo') || '', showReviewed: false };
let list: InboxList = { repos: [], stories: [] };
/** Whether the last poll failed, so the next good one redraws even when nothing changed. */
let failed = false;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  await authed;
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      ...authHeader(KEY),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: T & { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(json.error || `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return json;
}

const AUTO_WHY = {
  review: 'marked reviewed because you submitted a review on GitHub after the story was built',
  'all viewed': 'marked reviewed because every file is Viewed on GitHub',
};

function storyHtml(story: InboxStory) {
  const reviewed = !!story.reviewed_at;
  const auto =
    story.reviewed_by === 'review' || story.reviewed_by === 'all viewed' ? story.reviewed_by : null;
  return html`<li class="ou-inbox-item${!reviewed && ' ou-inbox-new'}" data-story="${story.id}">
    <div class="ou-inbox-main">
      <div class="ou-inbox-prompt">${!reviewed && html`<span class="ou-inbox-dot" title="Not reviewed yet"></span>`}<span class="ou-inbox-kind">PR story</span> ${story.title}</div>
      <div class="ou-local-muted">${story.repo}#${story.number} · built ${shortDateTime(story.built_at)}${auto && html` · <span class="ou-inbox-auto" title="${AUTO_WHY[auto]}">auto: ${auto}</span>`}</div>
    </div>
    <div class="ou-inbox-actions">
      <a class="ou-inbox-open" href="${story.url}" target="_blank" rel="noopener">Open PR</a>
      <button type="button" data-story-reviewed="${story.id}" data-to="${String(!reviewed)}">${reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</button>
    </div>
  </li>`;
}

function render() {
  const stories = list.stories.filter((story) => view.showReviewed || !story.reviewed_at);
  const items = stories
    .map((story) => ({ at: story.built_at, markup: storyHtml(story) }))
    .sort((first, second) => second.at.localeCompare(first.at));
  const unreviewed = list.repos.reduce((sum, repo) => sum + repo.unreviewed, 0);
  // the stories listed leave out the reviewed ones unless Show reviewed is on, so the repos' counts say whether any exist
  const any = list.repos.some(
    (repo) => repo.count && (!view.repo || repo.repo.toLowerCase() === view.repo.toLowerCase()),
  );
  const empty = any
    ? 'Nothing left to review here.'
    : 'Nothing yet. A PR story shows up here once one is built.';
  const body = items.length
    ? html`<ul class="ou-inbox-list">${items.map((item) => item.markup)}</ul>`
    : html`<p class="ou-local-muted">${empty}</p>`;
  document.title = unreviewed ? `(${unreviewed}) Review inbox` : 'Review inbox';
  setHtml(
    app,
    html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Review inbox</h1><div class="ou-local-muted">${unreviewed} to review</div></div>
      <button type="button" class="ou-inbox-repo" aria-haspopup="menu" aria-expanded="false" title="Show one repo's items">${view.repo || 'All repos'} ▾</button>
      <label class="ou-local-ws"><input type="checkbox" class="ou-inbox-all"${view.showReviewed && html` checked`}> Show reviewed</label>
      <button type="button" data-board>Agent board</button>
    </header>
    <main class="ou-inbox">${body}</main>`,
  );
}

async function refresh() {
  try {
    const query = view.repo ? `?${new URLSearchParams({ repo: view.repo })}` : '';
    const next = await api<InboxList>('GET', `/api/inbox${query}`);
    // a redraw closes an open Repo menu, so the polling redraws only when something changed (or an error is showing)
    if (failed || JSON.stringify(next) !== JSON.stringify(list)) {
      failed = false;
      list = next;
      render();
    }
  } catch (err) {
    failed = true;
    // refused for want of a key: say how to connect (the poll fills the inbox in once there is a cookie)
    const refused = [401, 403].includes((err as { status?: number }).status ?? 0);
    setHtml(
      app,
      refused
        ? notConnectedHtml('inbox')
        : html`<p class="ou-local-error">Couldn't load the inbox: ${(err as Error).message}</p>`,
    );
  }
}

app.addEventListener('click', async (event) => {
  const target = event.target as Element;
  const markStory = target.closest('[data-story-reviewed]');
  try {
    if (target.closest('.ou-inbox-repo')) {
      chooseRepo(target.closest('.ou-inbox-repo') as HTMLElement);
    } else if (target.closest('[data-board]')) {
      const { url } = await api<{ url: string }>('GET', '/api/board/link');
      window.open(url, '_blank', 'noopener');
    } else if (markStory) {
      await api('POST', '/api/inbox/reviewed', {
        story: markStory.getAttribute('data-story-reviewed'),
        reviewed: markStory.getAttribute('data-to') === 'true',
      });
      await refresh();
    }
  } catch (err) {
    alert(`Couldn't do that: ${(err as Error).message}`);
  }
});
/** The repo filter: a menu of the repos (with what waits in each), in place of a native select. */
function chooseRepo(anchor: HTMLElement) {
  const entries = [
    { value: '', label: 'All repos', checked: !view.repo },
    ...list.repos.map((repo) => ({
      value: repo.repo,
      label: repo.repo,
      detail: `${repo.unreviewed} to review`,
      checked: repo.repo.toLowerCase() === view.repo.toLowerCase(),
    })),
  ];
  openMenu(
    anchor,
    entries,
    (value) => {
      view.repo = value;
      // draw now: with one repo the server's answer doesn't change, and refresh() redraws only when it does
      render();
      refresh();
    },
    { label: 'Repo' },
  );
}

app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.matches('.ou-inbox-all')) {
    // draw now: Show reviewed is filtered here, so the server's answer doesn't change
    view.showReviewed = (target as HTMLInputElement).checked;
    render();
    refresh();
  }
});
refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
window.addEventListener('focus', refresh);
document.addEventListener(
  'visibilitychange',
  () => document.visibilityState === 'visible' && refresh(),
);
