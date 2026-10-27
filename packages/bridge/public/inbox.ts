/*
 * The review inbox page: the Claude Code turns the bridge made from the capture hook's spool (skills/once-upon/bin/capture-turn.sh),
 * newest first, with the unreviewed ones marked. Review opens a turn as a local story (the page's own diff view and
 * the story panel, so Ask and Fix before push work on it), and Mark reviewed ticks it off. Built PR stories wait in
 * the same list, marked as PR stories: they open on the PR's changes page, where the panel is, and are marked reviewed
 * the same way. So do local stories (a branch's story before any PR), marked as local stories, which open on their local page. The page's key (the link's
 * #key=, which `once-upon review` and the extension print) reaches the turn routes and nothing else.
 */
import { authHeader, startAuth } from '/assets/local/auth.ts';
import { notConnectedHtml } from '/assets/local/not-connected.ts';
import { openMenu } from '/assets/local/menu.ts';
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { plural } from '/assets/util/text.ts';
import { shortDateTime } from '/assets/util/time.ts';
import type { InboxLocalStory, InboxStory, Turn, InboxList } from '/assets/types.ts';

/** Like the board: new turns and PR stories show up without a reload. */
const POLL_MS = 3000;
const app = document.getElementById('ou-inbox-app') as HTMLElement;
const params = new URLSearchParams(location.hash.slice(1));
const KEY = params.get('key') || '';
/** Hands the key to the server when the host takes a cookie; calls wait for that so the cookie is there. */
const authed = startAuth(KEY, '/api/board/link');

/** What the page shows: the repo filter (from the link's #repo=, then the select), the session filter, whether reviewed turns are listed, and which turns' files are open. */
const view = {
  repo: params.get('repo') || '',
  /** one Claude Code session's turns (the agent board's link sets it, from the link's #session=) */
  session: params.get('session') || '',
  showReviewed: false,
  open: new Set<string>(),
};
let list: InboxList = { turns: [], repos: [], stories: [], local_stories: [] };
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

const firstLine = (text: string | null) =>
  (text || '')
    .split('\n')
    .find((line) => line.trim())
    ?.trim() || '';

function turnHtml(turn: Turn) {
  const reviewed = !!turn.reviewed_at;
  const prompt = firstLine(turn.prompt);
  const where = `${turn.repo || turn.repo_name}${turn.branch ? ` · ${turn.branch}` : ''}`;
  const size = html`${plural(turn.files.length, 'file')} <span class="ou-local-plus">+${turn.added}</span> <span class="ou-local-minus">−${turn.removed}</span>`;
  const kinds = { created: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
  const files = turn.files.map(
    (file) =>
      html`<li><code>${kinds[file.kind]}</code> ${file.path} <span class="ou-local-plus">+${file.added}</span> <span class="ou-local-minus">−${file.removed}</span>${file.omitted && html` <span class="ou-local-muted">(too big to keep)</span>`}</li>`,
  );
  const stopped =
    turn.interrupted &&
    html` · <span title="Stopped before it finished. It ends at your next prompt, so it may include edits made after you stopped it.">stopped</span>`;
  return html`<li class="ou-inbox-item${!reviewed && ' ou-inbox-new'}" data-turn="${turn.id}">
    <div class="ou-inbox-main">
      <div class="ou-inbox-prompt">${!reviewed && html`<span class="ou-inbox-dot" title="Not reviewed yet"></span>`}${prompt || 'A turn with no prompt we could read'}</div>
      <div class="ou-local-muted">${where} · ${shortDateTime(turn.at)} · ${size}${stopped}</div>
      <details data-files="${turn.id}"${view.open.has(turn.id) && html` open`}><summary class="ou-local-muted">Files</summary><ul class="ou-inbox-files">${files}</ul></details>
    </div>
    <div class="ou-inbox-actions">
      <button type="button" data-open="${turn.id}">Review</button>
      <button type="button" data-reviewed="${turn.id}" data-to="${String(!reviewed)}">${reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</button>
    </div>
  </li>`;
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

/** A local story (a branch's story before any PR): Open story goes to its page on this bridge, Mark reviewed ticks it off. */
function localStoryHtml(story: InboxLocalStory) {
  const reviewed = !!story.reviewed_at;
  const where = `${story.repo || story.repo_name}${story.branch ? ` · ${story.branch}` : ''}`;
  return html`<li class="ou-inbox-item${!reviewed && ' ou-inbox-new'}" data-story="${story.id}">
    <div class="ou-inbox-main">
      <div class="ou-inbox-prompt">${!reviewed && html`<span class="ou-inbox-dot" title="Not reviewed yet"></span>`}<span class="ou-inbox-kind">Local story</span> ${story.title}</div>
      <div class="ou-local-muted">${where} · built ${shortDateTime(story.built_at)}</div>
    </div>
    <div class="ou-inbox-actions">
      <button type="button" data-open-story="${story.id}">Open story</button>
      <button type="button" data-story-reviewed="${story.id}" data-to="${String(!reviewed)}">${reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</button>
    </div>
  </li>`;
}

function render() {
  const shown = list.turns.filter(
    (turn) =>
      (view.showReviewed || !turn.reviewed_at) && (!view.session || turn.session === view.session),
  );
  // a session's turns: its PR stories are shown only when the link also named a repo
  const stories = list.stories.filter(
    (story) =>
      (view.showReviewed || !story.reviewed_at) &&
      (!view.session || (view.repo && story.repo.toLowerCase() === view.repo.toLowerCase())),
  );
  const locals = list.local_stories.filter(
    (story) =>
      (view.showReviewed || !story.reviewed_at) &&
      (!view.session ||
        (view.repo && (story.repo || '').toLowerCase() === view.repo.toLowerCase())),
  );
  const items = [
    ...shown.map((turn) => ({ at: turn.at, markup: turnHtml(turn) })),
    ...stories.map((story) => ({ at: story.built_at, markup: storyHtml(story) })),
    ...locals.map((story) => ({ at: story.built_at, markup: localStoryHtml(story) })),
  ].sort((first, second) => second.at.localeCompare(first.at));
  const unreviewed = list.repos.reduce((sum, repo) => sum + repo.unreviewed, 0);
  // the turns come only unreviewed unless Show reviewed is on, so the repos' counts (turns and PR stories) say whether any exist
  const any = list.repos.some(
    (repo) => repo.count && (!view.repo || repo.repo.toLowerCase() === view.repo.toLowerCase()),
  );
  const empty = any
    ? 'Nothing left to review here.'
    : 'Nothing yet. Turns come from the capture hook’s spool after each Claude Code turn that changes files, and PR stories when one is built.';
  const body = items.length
    ? html`<ul class="ou-inbox-list">${items.map((item) => item.markup)}</ul>`
    : html`<p class="ou-local-muted">${empty}</p>`;
  document.title = unreviewed ? `(${unreviewed}) Review inbox` : 'Review inbox';
  setHtml(
    app,
    html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Review inbox</h1><div class="ou-local-muted">${unreviewed} to review</div></div>
      <button type="button" class="ou-inbox-repo" aria-haspopup="menu" aria-expanded="false" title="Show one repo's items">${view.repo || 'All repos'} ▾</button>
      ${view.session && html`<button type="button" class="ou-inbox-session" title="Show every session's turns again">Session ${view.session.slice(0, 8)} ✕</button>`}
      <label class="ou-local-ws"><input type="checkbox" class="ou-inbox-all"${view.showReviewed && html` checked`}> Show reviewed</label>
      <button type="button" data-board>Agent board</button>
    </header>
    <main class="ou-inbox">${body}</main>`,
  );
}

async function refresh() {
  try {
    // the server leaves out the reviewed turns before it cuts the list to its newest 100, so they can't hide older unreviewed ones
    const query = new URLSearchParams();
    if (view.repo) {
      query.set('repo', view.repo);
    }
    if (!view.showReviewed) {
      query.set('unreviewed', '1');
    }
    const next = await api<InboxList>('GET', `/api/inbox${query.size ? `?${query}` : ''}`);
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
  const open = target.closest('[data-open]');
  const mark = target.closest('[data-reviewed]');
  const markStory = target.closest('[data-story-reviewed]');
  const openStory = target.closest('[data-open-story]');
  try {
    if (target.closest('.ou-inbox-repo')) {
      chooseRepo(target.closest('.ou-inbox-repo') as HTMLElement);
    } else if (target.closest('[data-board]')) {
      const { url } = await api<{ url: string }>('GET', '/api/board/link');
      window.open(url, '_blank', 'noopener');
    } else if (target.closest('.ou-inbox-session')) {
      view.session = '';
      render();
    } else if (open) {
      const { url } = await api<{ url: string }>('POST', '/api/inbox/open', {
        id: open.getAttribute('data-open'),
      });
      window.open(url, '_blank', 'noopener');
    } else if (openStory) {
      const { url } = await api<{ url: string }>('POST', '/api/inbox/open', {
        story: openStory.getAttribute('data-open-story'),
      });
      window.open(url, '_blank', 'noopener');
    } else if (markStory) {
      await api('POST', '/api/inbox/reviewed', {
        story: markStory.getAttribute('data-story-reviewed'),
        reviewed: markStory.getAttribute('data-to') === 'true',
      });
      await refresh();
    } else if (mark) {
      await api('POST', '/api/inbox/reviewed', {
        id: mark.getAttribute('data-reviewed'),
        reviewed: mark.getAttribute('data-to') === 'true',
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
app.addEventListener(
  'toggle',
  (event) => {
    const details = event.target as HTMLDetailsElement;
    const id = details.getAttribute('data-files');
    if (id) {
      view.open[details.open ? 'add' : 'delete'](id);
    }
  },
  true,
);

refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
window.addEventListener('focus', refresh);
document.addEventListener(
  'visibilitychange',
  () => document.visibilityState === 'visible' && refresh(),
);
