/*
 * The review inbox page: the Claude Code turns the Stop hook has handed the bridge (skills/once-upon/bin/capture-turn.sh),
 * newest first, with the unreviewed ones marked. Review opens a turn as a local story (the page's own diff view and
 * the story panel, so Ask and Fix before push work on it), and Mark reviewed ticks it off. The page's key (the link's
 * #key=, which `once-upon review` and the extension print) reaches the turn routes and nothing else.
 */
import { html } from '/assets/util/html.ts';
import { setHtml } from '/assets/util/dom.ts';
import { plural } from '/assets/util/text.ts';
import { shortDateTime } from '/assets/util/time.ts';
import type { Turn, TurnList } from '/assets/types.ts';

const POLL_MS = 5000;
const app = document.getElementById('ou-inbox-app') as HTMLElement;
const params = new URLSearchParams(location.hash.slice(1));
const KEY = params.get('key') || '';

/** What the page shows: the repo filter (from the link's #repo=, then the select), whether reviewed turns are listed, and which turns' files are open. */
const view = { repo: params.get('repo') || '', showReviewed: false, open: new Set<string>() };
let list: TurnList = { turns: [], repos: [] };

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
  return html`<li class="ou-inbox-turn${!reviewed && ' ou-inbox-new'}" data-turn="${turn.id}">
    <div class="ou-inbox-main">
      <div class="ou-inbox-prompt">${!reviewed && html`<span class="ou-inbox-dot" title="Not reviewed yet"></span>`}${prompt || 'A turn with no prompt we could read'}</div>
      <div class="ou-local-muted">${where} · ${shortDateTime(turn.at)} · ${size}</div>
      <details data-files="${turn.id}"${view.open.has(turn.id) && html` open`}><summary class="ou-local-muted">Files</summary><ul class="ou-inbox-files">${files}</ul></details>
    </div>
    <div class="ou-inbox-actions">
      <button type="button" data-open="${turn.id}">Review</button>
      <button type="button" data-reviewed="${turn.id}" data-to="${String(!reviewed)}">${reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</button>
    </div>
  </li>`;
}

function render() {
  const shown = list.turns.filter((turn) => view.showReviewed || !turn.reviewed_at);
  const unreviewed = list.repos.reduce((sum, repo) => sum + repo.unreviewed, 0);
  const options = list.repos.map(
    (repo) =>
      html`<option value="${repo.repo}"${repo.repo.toLowerCase() === view.repo.toLowerCase() && html` selected`}>${repo.repo} (${repo.unreviewed})</option>`,
  );
  const empty = list.turns.length
    ? 'Nothing left to review here.'
    : 'No turns yet. They arrive from the Stop hook after each Claude Code turn that changes files.';
  const body = shown.length
    ? html`<ul class="ou-inbox-list">${shown.map(turnHtml)}</ul>`
    : html`<p class="ou-local-muted">${empty}</p>`;
  document.title = unreviewed ? `(${unreviewed}) Review inbox` : 'Review inbox';
  setHtml(
    app,
    html`<header class="ou-local-top">
      <div class="ou-local-top-main"><h1>Review inbox</h1><div class="ou-local-muted">${unreviewed} to review</div></div>
      <select class="ou-inbox-repo" aria-label="Repo"><option value="">All repos</option>${options}</select>
      <label class="ou-local-ws"><input type="checkbox" class="ou-inbox-all"${view.showReviewed && html` checked`}> Show reviewed</label>
    </header>
    <main class="ou-inbox">${body}</main>`,
  );
}

async function refresh() {
  try {
    const query = view.repo ? `?repo=${encodeURIComponent(view.repo)}` : '';
    const next = await api<TurnList>('GET', `/api/turns${query}`);
    // a redraw closes an open Repo menu, so the polling redraws only when something changed
    if (JSON.stringify(next) !== JSON.stringify(list)) {
      list = next;
      render();
    }
  } catch (err) {
    setHtml(
      app,
      html`<p class="ou-local-error">Couldn't load the inbox: ${(err as Error).message}</p>`,
    );
  }
}

app.addEventListener('click', async (event) => {
  const target = event.target as Element;
  const open = target.closest('[data-open]');
  const mark = target.closest('[data-reviewed]');
  try {
    if (open) {
      const { url } = await api<{ url: string }>('POST', '/api/turns/open', {
        id: open.getAttribute('data-open'),
      });
      window.open(url, '_blank', 'noopener');
    } else if (mark) {
      await api('POST', '/api/turns/reviewed', {
        id: mark.getAttribute('data-reviewed'),
        reviewed: mark.getAttribute('data-to') === 'true',
      });
      await refresh();
    }
  } catch (err) {
    alert(`Couldn't do that: ${(err as Error).message}`);
  }
});
app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (target.matches('.ou-inbox-repo')) {
    view.repo = target.value;
    refresh();
  } else if (target.matches('.ou-inbox-all')) {
    view.showReviewed = (target as HTMLInputElement).checked;
    render();
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
