/*
 * The bridge's local page: a diff of local commits drawn with the same DOM
 * shapes as GitHub's /changes page (file regions with id diff-<sha256(path)>,
 * line cells with data-line-anchor, a role=tree file list, a Viewed toggle
 * with aria-pressed), so the very same story panel runs on it unchanged.
 *
 * Here the page owns the review state that GitHub would own: Viewed toggles
 * and line notes go to the bridge, and notes are "fix before push" items.
 */
import { storyOverlay } from '/assets/overlay.js';

const BOOT = JSON.parse(document.getElementById('ds-boot').textContent);
const S = `/api/stories/${encodeURIComponent(BOOT.story)}`;
const app = document.getElementById('ds-app');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function api(method, p, body) {
  const r = await fetch(p, {
    method, cache: 'no-store',
    headers: { Authorization: `Bearer ${BOOT.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

let story = null;
let overlay = null;
let hidden = false;
let lastUi = {};

// ---------- the diff
function treeHtml(rels) {
  const root = { dirs: new Map(), files: [] };
  for (const rel of rels) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(key)) node.dirs.set(key, { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(key);
    }
    node.files.push(rel);
  }
  const draw = (node, depth) => {
    let html = '';
    for (const [key, dir] of [...node.dirs].sort()) {
      // fold single-folder chains into one row, as GitHub does
      let k = key;
      let d = dir;
      let label = dir.name;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [nk, nd] = [...d.dirs][0];
        k = nk; label += '/' + nd.name; d = nd;
      }
      html += `<div role="treeitem" aria-expanded="true" id="${esc(k)}" class="ds-tree-dir"><div class="ds-tree-label" style="padding-left:${8 + depth * 12}px">${esc(label)}</div><div role="group">${draw(d, depth + 1)}</div></div>`;
    }
    for (const rel of node.files.sort()) {
      html += `<div role="treeitem" id="${esc(rel)}" class="ds-tree-file" data-goto="${esc(rel)}" style="padding-left:${8 + depth * 12}px">${esc(rel.split('/').pop())}</div>`;
    }
    return html;
  };
  return draw(root, 0);
}

function rowsHtml(f) {
  if (f.binary) return '<tr class="ds-info"><td colspan="3">Binary file</td></tr>';
  if (f.whitespace_only) return '<tr class="ds-info"><td colspan="3">Only whitespace changes, hidden. Turn off Hide whitespace to see them.</td></tr>';
  if (!f.hunks.length) return `<tr class="ds-info"><td colspan="3">${f.kind === 'renamed' ? 'Renamed without changes' : 'No changed lines'}</td></tr>`;
  let html = '';
  for (const h of f.hunks) {
    html += `<tr class="ds-hunk"><td class="ds-num"></td><td class="ds-num"></td><td class="ds-code">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${esc(h.header || '')}</td></tr>`;
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      const sign = line[0];
      const text = esc(line.slice(1));
      const cell = (side, num) => `<td class="ds-num" data-line-anchor="diff-${f.sha}${side}${num}" data-side="${side}" data-line="${num}" title="Add a fix-before-push note">${num}</td>`;
      if (sign === ' ') { html += `<tr class="ds-line ds-ctx">${cell('L', o)}${cell('R', n)}<td class="ds-code"><span class="ds-sign"> </span>${text}</td></tr>`; o++; n++; }
      else if (sign === '-') { html += `<tr class="ds-line ds-del">${cell('L', o)}<td class="ds-num"></td><td class="ds-code"><span class="ds-sign">-</span>${text}</td></tr>`; o++; }
      else if (sign === '+') { html += `<tr class="ds-line ds-add"><td class="ds-num"></td>${cell('R', n)}<td class="ds-code"><span class="ds-sign">+</span>${text}</td></tr>`; n++; }
      else html += `<tr class="ds-info"><td class="ds-num"></td><td class="ds-num"></td><td class="ds-code">${text}</td></tr>`;
    }
  }
  return html;
}

function fileHtml(f) {
  const kind = f.kind === 'renamed' && f.renamed_from ? `renamed from ${f.renamed_from}` : f.kind === 'modified' ? '' : f.kind;
  return `<div class="ds-file-wrap"><section role="region" class="ds-file${f.viewed ? ' ds-folded' : ''}" id="diff-${f.sha}" data-path="${esc(f.rel)}" aria-label="${esc(f.rel)}">
    <header class="ds-file-head">
      <button class="ds-fold" type="button" aria-label="Fold or unfold this file" aria-expanded="${!f.viewed}"></button>
      <code class="ds-path">${esc(f.rel)}</code>
      ${kind ? `<span class="ds-kind">${esc(kind)}</span>` : ''}
      ${f.whitespace_only ? '<span class="ds-kind" title="Hide whitespace is on">whitespace only</span>' : ''}
      <span class="ds-stat"><span class="ds-plus">+${f.stats.added}</span> <span class="ds-minus">−${f.stats.removed}</span></span>
      ${f.viewed_changed ? '<span class="ds-changed" title="You marked this viewed, and its diff has changed since">changed since viewed</span>' : ''}
      <button class="ds-viewed" type="button" aria-pressed="${f.viewed ? 'true' : 'false'}">Viewed</button>
    </header>
    <div class="ds-file-body"><table class="ds-diff"><colgroup><col class="ds-col-num"><col class="ds-col-num"><col></colgroup><tbody>${rowsHtml(f)}</tbody></table></div>
  </section></div>`;
}

function headerHtml() {
  const l = story.local;
  const added = l.files.reduce((n, f) => n + f.stats.added, 0);
  const removed = l.files.reduce((n, f) => n + f.stats.removed, 0);
  const open = l.notes.filter(n => !n.done).length;
  return `<header class="ds-top">
    <div class="ds-top-main">
      <h1>${esc(story.title)}</h1>
      <div class="ds-muted">${esc(l.repo)} · <code>${esc(l.base)}</code> ${esc(l.base_oid.slice(0, 9))} → <code>${esc(l.head)}</code> ${esc(l.head_oid.slice(0, 9))}${l.branch ? ` · ${esc(l.branch)}` : ''} · ${l.commits.length} commit${l.commits.length === 1 ? '' : 's'} · ${l.files.length} files <span class="ds-plus">+${added}</span> <span class="ds-minus">−${removed}</span></div>
    </div>
    <label class="ds-ws" title="Draw the diff with git diff -w, like GitHub's Hide whitespace. Remembered for every local story."><input type="checkbox" class="ds-ws-toggle"${l.hide_whitespace ? ' checked' : ''}> Hide whitespace</label>
    <button type="button" class="ds-notes-toggle" aria-expanded="false">Fix before push: ${open} open</button>
  </header>
  <section class="ds-notes-list" hidden></section>`;
}

function notesListHtml() {
  const notes = story.local.notes;
  if (!notes.length) return '<p class="ds-muted">No fix-before-push notes yet. Click a line number in the diff to add one.</p>';
  return `<ul>${notes.map(n => `<li class="${n.done ? 'ds-done' : ''}"><label><input type="checkbox" data-note-done="${esc(n.id)}"${n.done ? ' checked' : ''}> <a href="#" data-note-goto="${esc(n.id)}"><code>${esc(n.path)}${n.line ? `:${n.side === 'L' ? 'L' : ''}${n.line}` : ''}</code></a></label> ${esc(n.body)}</li>`).join('')}</ul>
    <p class="ds-muted">Also in the terminal: <code>diff-story notes --story ${esc(story.id)}</code></p>`;
}

function noteRow(n, away) {
  return `<tr class="ds-note-row" data-note="${esc(n.id)}"><td colspan="3"><div class="ds-note${n.done ? ' ds-done' : ''}">
    <div class="ds-note-head"><b>Fix before push</b><span class="ds-muted">${esc(new Date(n.at).toLocaleString())}</span>
      ${away ? `<span class="ds-muted">on ${n.side === 'L' ? 'L' : ''}${n.line}, a line this diff doesn't draw${story.local.hide_whitespace ? ' with whitespace hidden' : ''}</span>` : ''}
      <label><input type="checkbox" data-note-done="${esc(n.id)}"${n.done ? ' checked' : ''}> done</label>
      <button type="button" data-note-delete="${esc(n.id)}">Delete</button></div>
    <div class="ds-note-body">${esc(n.body)}</div></div></td></tr>`;
}

function placeNotes() {
  for (const el of document.querySelectorAll('.ds-note-row')) el.remove();
  for (const n of story.local.notes) {
    const f = story.local.files.find(x => x.rel === n.path);
    if (!f) continue;
    const cell = n.line && document.querySelector(`[data-line-anchor="diff-${f.sha}${n.side}${n.line}"]`);
    const row = cell ? cell.closest('tr') : document.querySelector(`#diff-${f.sha} tbody tr`);
    if (row) row.insertAdjacentHTML('afterend', noteRow(n, !!n.line && !cell));
  }
  const open = story.local.notes.filter(n => !n.done).length;
  const btn = document.querySelector('.ds-notes-toggle');
  if (btn) btn.textContent = `Fix before push: ${open} open`;
  const list = document.querySelector('.ds-notes-list');
  if (list) list.innerHTML = notesListHtml();
}

function render() {
  const keep = window.scrollY;
  app.innerHTML = `${headerHtml()}<div class="ds-layout"><nav class="ds-tree" role="tree" aria-label="Changed files">${treeHtml(story.local.files.map(f => f.rel))}</nav>
    <main class="ds-files">${story.local.files.map(fileHtml).join('')}</main></div>`;
  placeNotes();
  window.scrollTo({ top: keep });
}

// ---------- the panel, the same one the extension puts on GitHub
const panelData = () => ({ ...story, local: undefined });
function mount(initial) {
  if (overlay) overlay.destroy();
  removeReopen();
  overlay = storyOverlay(panelData(), {
    initial,
    host: 'this page',
    commentsTitle: 'Fix before push (drafted)',
    onState: s => { lastUi = { ...s, hidden: false }; api('POST', `${S}/ui`, lastUi).catch(() => {}); },
    onPosition: p => api('POST', `${S}/position`, { ...p, url: location.href }).catch(() => {}),
    onClose: () => { overlay = null; hidden = true; api('POST', `${S}/ui`, { ...lastUi, hidden: true }).catch(() => {}); showReopen(); },
    ask: q => api('POST', `${S}/questions`, { ...q, url: location.href }),
    loadQuestions: () => api('GET', `${S}/questions`).then(r => r.questions),
    drafts: {
      load: () => api('GET', `${S}/drafts`),
      act: (chapter, index, action) => api('POST', `${S}/drafts`, { chapter, index, action }),
    },
    status: () => api('GET', `/api/status?story=${encodeURIComponent(BOOT.story)}`).catch(err => {
      throw Object.assign(err, { code: /token/.test(err.message) ? 'token' : /HTTP 404|not found/.test(err.message) ? 'old' : 'down' });
    }),
  });
}
function showReopen() {
  removeReopen();
  const b = document.createElement('button');
  b.className = 'ds-reopen';
  b.type = 'button';
  b.textContent = 'Show story';
  b.onclick = () => { hidden = false; mount({ ...lastUi }); };
  document.body.appendChild(b);
}
function removeReopen() { document.querySelector('.ds-reopen')?.remove(); }

// ---------- clicks on the diff: Viewed, fold, notes, tree
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('#diff-story-panel')) return;
  const viewedBtn = t.closest('.ds-viewed');
  if (viewedBtn) {
    const section = viewedBtn.closest('.ds-file');
    const rel = section.getAttribute('data-path');
    const on = viewedBtn.getAttribute('aria-pressed') !== 'true';
    viewedBtn.setAttribute('aria-pressed', String(on));
    section.classList.toggle('ds-folded', on);
    section.querySelector('.ds-fold').setAttribute('aria-expanded', String(!on));
    section.querySelector('.ds-changed')?.remove();
    const f = story.local.files.find(x => x.rel === rel);
    if (f) { f.viewed = on; f.viewed_changed = false; }
    try { await api('POST', `${S}/viewed`, { path: rel, viewed: on }); } catch (err) { alert(`Couldn't save: ${err.message}`); }
    if (on) {
      const top = section.getBoundingClientRect().top;
      if (top < 0) section.scrollIntoView();
    }
    return;
  }
  const fold = t.closest('.ds-fold');
  if (fold) {
    const section = fold.closest('.ds-file');
    const folded = section.classList.toggle('ds-folded');
    fold.setAttribute('aria-expanded', String(!folded));
    return;
  }
  const go = t.closest('[data-goto]');
  if (go) {
    const f = story.local.files.find(x => x.rel === go.getAttribute('data-goto'));
    const el = f && document.getElementById(`diff-${f.sha}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 60 });
    return;
  }
  const num = t.closest('td.ds-num[data-line-anchor]');
  if (num) return openEditor(num);
  const cancel = t.closest('[data-editor-cancel]');
  if (cancel) { cancel.closest('tr').remove(); return; }
  const del = t.closest('[data-note-delete]');
  if (del) {
    await api('POST', `${S}/notes/${encodeURIComponent(del.getAttribute('data-note-delete'))}`, { delete: true });
    story.local.notes = story.local.notes.filter(n => n.id !== del.getAttribute('data-note-delete'));
    placeNotes();
    return;
  }
  const gotoNote = t.closest('[data-note-goto]');
  if (gotoNote) {
    e.preventDefault();
    const row = document.querySelector(`.ds-note-row[data-note="${CSS.escape(gotoNote.getAttribute('data-note-goto'))}"]`);
    if (row) { row.closest('.ds-file').classList.remove('ds-folded'); window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3 }); }
    return;
  }
  const toggle = t.closest('.ds-notes-toggle');
  if (toggle) {
    const list = document.querySelector('.ds-notes-list');
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  }
});
async function setHideWhitespace(on) {
  const box = document.querySelector('.ds-ws-toggle');
  if (box) box.disabled = true;
  try {
    await api('POST', '/api/prefs', { hideWhitespace: on });
    story = await api('GET', S);
    render();
    if (!hidden) mount(overlay ? { ...overlay.state, bodyScroll: overlay.bodyScroll } : lastUi);
  } catch (err) {
    alert(`Couldn't change Hide whitespace: ${err.message}`);
    if (box) { box.checked = !on; box.disabled = false; }
  }
}

document.addEventListener('change', async e => {
  const ws = e.target.closest('.ds-ws-toggle');
  if (ws) return setHideWhitespace(ws.checked);
  const box = e.target.closest('[data-note-done]');
  if (!box) return;
  const id = box.getAttribute('data-note-done');
  const n = await api('POST', `${S}/notes/${encodeURIComponent(id)}`, { done: box.checked });
  story.local.notes = story.local.notes.map(x => (x.id === id ? n : x));
  placeNotes();
});

function openEditor(cell) {
  const row = cell.closest('tr');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('ds-note-edit')) return row.nextElementSibling.querySelector('textarea').focus();
  const side = cell.getAttribute('data-side');
  const line = Number(cell.getAttribute('data-line'));
  const rel = cell.closest('.ds-file').getAttribute('data-path');
  row.insertAdjacentHTML('afterend', `<tr class="ds-note-edit"><td colspan="3"><form class="ds-note-form">
    <div class="ds-muted">Fix before push on <code>${esc(rel)}:${side === 'L' ? 'L' : ''}${line}</code></div>
    <textarea rows="3" placeholder="What to fix before pushing"></textarea>
    <div><button type="submit">Add note</button> <button type="button" data-editor-cancel>Cancel</button></div></form></td></tr>`);
  const form = row.nextElementSibling.querySelector('form');
  const ta = form.querySelector('textarea');
  ta.focus();
  ta.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    try {
      const note = await api('POST', `${S}/notes`, { path: rel, side, line, body });
      story.local.notes.push(note);
      form.closest('tr').remove();
      placeNotes();
    } catch (err) { alert(`Couldn't save the note: ${err.message}`); }
  });
}

// ---------- follow the story and the commits: when chapters.json changes or the head moves, redraw
async function poll() {
  if (document.visibilityState !== 'visible') return;
  try {
    const { version } = await api('GET', `${S}/version`);
    if (version === story.version) return;
    const editing = document.querySelector('.ds-note-edit');
    if (editing) return; // don't redraw under a note being written
    story = await api('GET', S);
    render();
    if (!hidden) mount(overlay ? { ...overlay.state, bodyScroll: overlay.bodyScroll } : lastUi);
  } catch { /* bridge restarting */ }
}

async function start() {
  try {
    story = await api('GET', S);
  } catch (err) {
    app.innerHTML = `<p class="ds-error">Couldn't load the story: ${esc(err.message)}</p>`;
    return;
  }
  document.title = story.title;
  lastUi = await api('GET', `${S}/ui`).catch(() => ({}));
  render();
  hidden = !!lastUi.hidden;
  if (hidden) showReopen();
  else mount(lastUi);
  window.__diffStoryLocal = { get story() { return story; }, get overlay() { return overlay; } };
  setInterval(poll, 5000);
  window.addEventListener('focus', poll); // a comment drafted in the terminal shows up as soon as you come back
}
start();
