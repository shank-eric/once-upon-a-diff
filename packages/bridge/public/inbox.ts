/*
 * The review inbox page: what waits for your review, newest first, with the unreviewed ones marked. It lists nothing
 * yet, and says so: the stories it lists come with later changes. The page's key (the link's #key=, which
 * `once-upon review` and the extension print) reaches the inbox routes and nothing else.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import type { InboxList } from '/assets/types.ts';

const POLL_MS = 5000;
const app = document.getElementById('ou-inbox-app') as HTMLElement;
const params = new URLSearchParams(location.hash.slice(1));
const KEY = params.get('key') || '';

/** What the page shows: the repo from the link's #repo=. */
const view = { repo: params.get('repo') || '' };
let list: InboxList = { repos: [] };
/** Whether the last poll failed, so the next good one redraws even when nothing changed. */
let failed = false;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (!KEY) {
    throw new Error('this link has no key: open the inbox from the link `once-upon review` prints');
  }
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: T & { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

function render() {
  const unreviewed = list.repos.reduce((sum, repo) => sum + repo.unreviewed, 0);
  document.title = unreviewed ? `(${unreviewed}) Review inbox` : 'Review inbox';
  setHtml(
    app,
    html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Review inbox</h1><div class="ou-local-muted">${unreviewed} to review${view.repo && html` in ${view.repo}`}</div></div>
    </header>
    <main class="ou-inbox"><p class="ou-local-muted">Nothing yet.</p></main>`,
  );
}

async function refresh() {
  try {
    const query = view.repo ? `?${new URLSearchParams({ repo: view.repo })}` : '';
    const next = await api<InboxList>('GET', `/api/inbox${query}`);
    // the polling redraws only when something changed (or an error is showing)
    if (failed || JSON.stringify(next) !== JSON.stringify(list)) {
      failed = false;
      list = next;
      render();
    }
  } catch (err) {
    failed = true;
    setHtml(
      app,
      html`<p class="ou-local-error">Couldn't load the inbox: ${(err as Error).message}</p>`,
    );
  }
}

refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
window.addEventListener('focus', refresh);
