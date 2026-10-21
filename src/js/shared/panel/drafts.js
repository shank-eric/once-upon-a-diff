/*
 * Drafted comments: each chapter's, and the Overview's list of all of them,
 * with their state from opts.drafts: posted, in the reviewer's pending review,
 * dismissed, a local story's fix-before-push note, or still a draft. The
 * buttons are Copy, Mark posted, Dismiss, Restore, Add to my review (GitHub)
 * and Add to fix before push (a local story).
 *
 * draftView and shownIn have no DOM, so node tests can use them.
 */
import { escapeHtml } from '../util/html.js';
import { capitalize } from '../util/text.js';
import { refAttrs } from './file-refs.js';

/**
 * How the panel shows one draft row from the bridge: 'dismissed', 'fix', 'posted', 'pending', 'added' or 'draft'.
 * 'added' is Add to my review's own state: it's in their pending review, but GitHub doesn't redraw an open
 * Files changed page for that, so this page doesn't show it yet. It turns into the usual posted or pending
 * display once gh matches it on a page loaded after the add, or the comment turns up on the page (onPage).
 * settle: the add is confirmed, so the bridge can drop its `added` mark.
 */
export function draftView(row, { pageAt = 0, onPage = false } = {}) {
  const draft = row || { status: 'draft', dismissed: false };
  if (draft.dismissed) {
    return { show: 'dismissed', settle: false };
  }
  if (draft.fix) {
    return { show: 'fix', settle: false }; // a local story's draft that's now a fix-before-push note
  }
  const known = draft.status === 'posted' || draft.status === 'pending' ? draft.status : 'draft';
  if (!draft.added) {
    return { show: known, settle: false };
  }
  const fromGithub = draft.source === 'github';
  if (draft.status === 'posted') {
    return { show: 'posted', settle: fromGithub };
  }
  if (fromGithub && draft.status === 'pending' && pageAt > (Date.parse(draft.added.at) || 0)) {
    return { show: 'pending', settle: true };
  }
  if (onPage) {
    return { show: 'pending', settle: false };
  }
  return { show: 'added', settle: false };
}

const plainText = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Does one of these comment texts on the page (rendered markdown) show this draft's body? */
export function shownIn(texts, body) {
  const want = plainText(body).slice(0, 160);
  if (want.length < 8) {
    return false;
  }
  return texts.some((text) => plainText(text).includes(want));
}

// kept across panel re-renders on this page: a failed Add to my review, and adds already settled
const reviewErrors = new Map();
const settling = new Set();

const ALL_COMMENTS_OPEN = 4; // more drafts than this and the Overview's list starts folded
const REFRESH_MS = 10000;
const POLL_MS = 60000;
const githubLink = (url) =>
  ` · <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">view on GitHub</a>`;
const lineJump = (rel, side, line) =>
  `<button class="prs-linkish" ${refAttrs(rel, { side: side === 'L' ? 'L' : 'R', start: Number(line), end: Number(line) })}>Jump to line ${escapeHtml(line)}</button>`;

export function createDrafts(context) {
  const { story, state, opts, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let rows = [];
  let loadError = null;
  let loadedAt = 0;

  /** One drafted comment, with its step and index: render adds its state and its buttons. */
  function commentHtml(comment, step, index) {
    const general = !comment.line || /^\(/.test(comment.path || '');
    const ref = !general && context.refs.resolveRef(comment.path);
    let name;
    if (ref) {
      const line = {
        side: comment.side === 'L' ? 'L' : 'R',
        start: comment.line,
        end: comment.line,
      };
      name = `<code ${refAttrs(ref.rel, line)}>${escapeHtml(comment.path)}:${escapeHtml(comment.line)}</code>`;
    } else {
      name = `<code>${escapeHtml(comment.path)}${general ? '' : `:${escapeHtml(comment.line)}`}</code>`;
    }
    const where = general ? 'General PR comment' : `On ${name}`;
    return (
      `<div class="prs-comment" data-n="${step}" data-i="${index}">` +
      `<div class="prs-where"><span>${where}</span><span class="prs-cbtns"><button class="prs-copy">Copy</button></span></div>` +
      `<pre>${escapeHtml(comment.body)}</pre><div class="prs-cstate" hidden></div></div>`
    );
  }

  /** A chapter's drafted comments, under their heading. */
  function chapterCommentsHtml(chapter) {
    const comments = (chapter.comments || [])
      .map((comment, index) => commentHtml(comment, state.n, index))
      .join('');
    if (!comments) {
      return '';
    }
    return `<div class="prs-drafts"><h2 class="prs-h">${escapeHtml(context.commentsTitle)} <span class="prs-draftsum"></span></h2><div class="prs-drafttoggles"></div>${comments}</div>`;
  }

  /** The Overview's list of every chapter's drafted comments, grouped by chapter, each with its chapter's actions. */
  function allCommentsHtml() {
    const groups = data.chapters
      .map((chapter, index) => ({ step: index + 1, chapter, comments: chapter.comments || [] }))
      .filter((group) => group.comments.length);
    const total = groups.reduce((sum, group) => sum + group.comments.length, 0);
    if (!total) {
      return '';
    }
    const items = groups
      .map(
        (group) =>
          `<div class="prs-cgroup" data-group="${group.step}"><h3 class="prs-cgh">` +
          `<button class="prs-linkish" data-goto="${group.step}">${escapeHtml(capitalize(story.chapterName(group.step)))}</button>: ` +
          `${escapeHtml(String(group.chapter.title || '').replace(/^Chapter \d+:\s*/, ''))}</h3>` +
          `${group.comments.map((comment, index) => commentHtml(comment, group.step, index)).join('')}</div>`,
      )
      .join('');
    const open = state.allCommentsOpen != null ? state.allCommentsOpen : total <= ALL_COMMENTS_OPEN;
    return (
      `<details class="prs-drafts prs-allc"${open ? ' open' : ''}><summary><h2 class="prs-h">${escapeHtml(context.commentsTitle)}: all chapters (${total}) <span class="prs-draftsum"></span></h2></summary>` +
      `<div class="prs-drafttoggles"></div>${items}</details>`
    );
  }

  async function refresh(force) {
    if (!opts.drafts) {
      return;
    }
    if (!force && Date.now() - loadedAt < REFRESH_MS) {
      return render();
    }
    loadedAt = Date.now();
    try {
      const result = await opts.drafts.load();
      rows = result.drafts || [];
      loadError = result.error || null;
    } catch (e) {
      loadError = e && e.message;
    }
    render();
  }

  const rowKey = (step, index) => {
    const row = rows.find((candidate) => candidate.chapter === step && candidate.index === index);
    return row && row.key ? row.key : `${step}:${index}`;
  };

  async function act(step, index, action) {
    const adding = action === 'review' || action === 'fix';
    const button =
      adding && $(`.prs-comment[data-n="${step}"][data-i="${index}"] [data-draft-act="${action}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = 'Adding…';
    }
    const key = rowKey(step, index);
    try {
      const result = await opts.drafts.act(step, index, action);
      rows = result.drafts || rows;
      loadError = result.error || null;
      loadedAt = Date.now();
      if (adding) {
        reviewErrors.delete(key);
      }
      if (action === 'review' && result.added) {
        shell.message(
          `Added to your pending review${result.added.started ? ' (started a new one)' : ''}. Nobody else sees it until you submit the review.`,
        );
      }
    } catch (e) {
      const why = e && e.message ? e.message : String(e);
      if (adding) {
        reviewErrors.set(key, why); // shown on the draft, which keeps its buttons
      } else {
        shell.message(`Couldn't save that: ${why}`);
      }
    }
    render();
  }

  function reloadPage() {
    if (opts.reloadPage) {
      opts.reloadPage();
    }
  }

  /** Is this line draft's comment on the page yet? Read only: it looks for its text in the file's comments. */
  function commentOnPage(comment) {
    if (!comment || !comment.path || !(Number(comment.line) > 0)) {
      return false;
    }
    const ref = context.refs.resolveRef(comment.path);
    const block = ref && context.page.blockOf(ref.rel);
    if (!block) {
      return false;
    }
    const texts = [
      ...block.el.querySelectorAll(
        '.comment-body, .js-comment-body, .markdown-body, [data-testid="markdown-body"]',
      ),
    ].map((el) => el.textContent);
    return shownIn(texts, comment.body);
  }

  /** A draft added to the review shows as pending as soon as its comment turns up on the page. */
  const waitingOnPage = () => !!state.n && rows.some((row) => row.chapter === state.n && row.added);

  /** Draws one draft's state and buttons. Returns what it shows, for the counts. */
  function renderComment(el, row, comment, step, index) {
    const view = draftView(row, {
      pageAt: context.pageLoadedAt,
      onPage: !!row.added && commentOnPage(comment),
    });
    if (view.settle && row.key && !settling.has(row.key) && opts.drafts) {
      settling.add(row.key);
      opts.drafts.act(step, index, 'settle').then(
        (result) => {
          rows = result.drafts || rows;
          render();
        },
        () => settling.delete(row.key),
      );
    }
    const stateLine = el.querySelector('.prs-cstate');
    const buttons = el.querySelector('.prs-cbtns');
    for (const button of buttons.querySelectorAll('[data-draft-act]')) {
      button.remove();
    }
    el.classList.remove('prs-c-done', 'prs-c-pending');
    el.hidden = false;
    stateLine.hidden = true;
    const link = row.url ? githubLink(row.url) : '';
    const addButton = (action, label, title) =>
      buttons.insertAdjacentHTML(
        'afterbegin',
        `<button data-draft-act="${action}" title="${escapeHtml(title)}">${label}</button>`,
      );
    const showError = () => {
      const error = reviewErrors.get(row.key || `${step}:${index}`);
      if (error) {
        stateLine.hidden = false;
        stateLine.innerHTML = `<span class="prs-cerr">${escapeHtml(error)}</span>`;
      }
    };
    if (view.show === 'dismissed') {
      el.classList.add('prs-c-done');
      el.hidden = !state.showDismissed;
      stateLine.hidden = false;
      stateLine.innerHTML = "Dismissed. It won't be suggested again for this PR.";
      addButton('restore', 'Restore', 'Bring this draft back');
    } else if (view.show === 'fix') {
      el.classList.add('prs-c-done', 'prs-c-pending');
      stateLine.hidden = false;
      const jump = lineJump(row.fix.path, row.fix.side, row.fix.line);
      stateLine.innerHTML = `<span class="prs-pend">In fix before push</span>${row.fix.done ? ' · <span class="prs-ok">done ✓</span>' : ''} · ${jump}`;
    } else if (view.show === 'posted') {
      el.classList.add('prs-c-done');
      el.hidden = !state.showPosted;
      stateLine.hidden = false;
      stateLine.innerHTML = `<span class="prs-ok">Posted ✓</span>${row.source === 'manual' ? ' (you marked it)' : ''}${link}`;
      addButton(
        'unposted',
        'Unmark',
        row.source === 'manual'
          ? 'Mark it as not posted'
          : 'Not the same comment? Show it as a draft again',
      );
    } else if (view.show === 'pending') {
      el.classList.add('prs-c-done', 'prs-c-pending');
      stateLine.hidden = false;
      const addedLink = row.added && row.added.url ? githubLink(row.added.url) : '';
      stateLine.innerHTML = `<span class="prs-pend">In your pending review</span>, not submitted yet${link || addedLink}`;
    } else if (view.show === 'added') {
      // Add to my review worked, but this page won't show the comment until it's reloaded
      el.classList.add('prs-c-done', 'prs-c-pending');
      stateLine.hidden = false;
      const ref = comment && context.refs.resolveRef(comment.path);
      const jump = ref ? ` · ${lineJump(ref.rel, comment.side, comment.line)}` : '';
      const onGithub = row.added.url ? githubLink(row.added.url) : '';
      const reload = opts.reloadPage
        ? ' <button class="prs-linkish" data-draft-reload title="Reloads this page. The panel stays on this chapter.">Reload page</button>'
        : '';
      stateLine.innerHTML =
        `<span class="prs-pend">In your pending review</span>, on ${escapeHtml(comment ? comment.path : '')} line ${escapeHtml(comment ? comment.line : '')}${jump}${onGithub}` +
        `<span class="prs-cnote">GitHub shows it after a reload.${reload}</span>`;
    } else {
      if (context.reading.isStaleDraft(step, index)) {
        stateLine.hidden = false;
        stateLine.innerHTML =
          '<span class="prs-cstale">May be out of date: a newer commit changed this line after you read the chapter.</span>';
      } else if (!state.n) {
        stateLine.hidden = false;
        stateLine.innerHTML = '<span class="prs-cdraft">Draft</span>, not posted';
      }
      addButton(
        'dismiss',
        'Dismiss',
        "Not a comment you want: hide it, and don't suggest it again",
      );
      addButton('posted', 'Mark posted', 'You posted this (or your own version of it)');
      const onLine = comment && comment.path && Number(comment.line) > 0;
      if (data.kind === 'local' && onLine) {
        addButton(
          'fix',
          'Add to fix before push',
          'Makes it a fix-before-push note on its line, in the checklist and in `diff-story notes`',
        );
        showError();
      }
      if (context.hostName === 'GitHub' && onLine) {
        addButton(
          'review',
          'Add to my review',
          'Adds it to your pending review on GitHub. Only you can see it until you submit the review yourself.',
        );
        showError();
      }
    }
    return view.show;
  }

  function render() {
    const box = $('.prs-drafts');
    if (!box) {
      return;
    }
    const overview = !state.n; // the Overview lists every chapter's drafts
    const shown = rows.filter((row) => {
      if (overview) {
        const chapter = data.chapters[row.chapter - 1];
        return chapter && (chapter.comments || [])[row.index];
      }
      return row.chapter === state.n;
    });
    const byKey = new Map(shown.map((row) => [`${row.chapter}:${row.index}`, row]));
    const counts = { posted: 0, pending: 0, dismissed: 0, fix: 0 };
    for (const el of box.querySelectorAll('.prs-comment[data-i]')) {
      const step = Number(el.getAttribute('data-n'));
      const index = Number(el.getAttribute('data-i'));
      const row = byKey.get(`${step}:${index}`) || { status: 'draft', dismissed: false };
      const comment = ((data.chapters[step - 1] || {}).comments || [])[index];
      const show = renderComment(el, row, comment, step, index);
      if (show === 'added') {
        counts.pending++;
      } else if (show in counts) {
        counts[show]++;
      }
    }
    const { posted, pending, dismissed, fix: fixed } = counts;
    const left = shown.length
      ? shown.length - posted - pending - dismissed - fixed
      : box.querySelectorAll('.prs-comment[data-i]').length;
    const summary = [
      `${left} to post`,
      fixed && `${fixed} in fix before push`,
      posted && `${posted} posted`,
      pending && `${pending} pending`,
      dismissed && `${dismissed} dismissed`,
    ].filter(Boolean);
    box.querySelector('.prs-draftsum').textContent = shown.length ? `(${summary.join(' · ')})` : '';
    box.querySelector('.prs-drafttoggles').innerHTML = [
      posted
        ? `<button class="prs-linkish" data-draft-show="showPosted">${state.showPosted ? 'Hide' : 'Show'} posted (${posted})</button>`
        : '',
      dismissed
        ? `<button class="prs-linkish" data-draft-show="showDismissed">${state.showDismissed ? 'Hide' : 'Show'} dismissed (${dismissed})</button>`
        : '',
      loadError
        ? `<span class="prs-why" title="${escapeHtml(loadError)}">Couldn't check GitHub for posted comments; Mark posted still works.</span>`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  let pollTimer = 0;
  if (opts.drafts) {
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh(true);
      }
    }, POLL_MS);
  }

  return {
    chapterCommentsHtml,
    allCommentsHtml,
    refresh,
    act,
    render,
    reloadPage,
    waitingOnPage,
    destroy: () => clearInterval(pollTimer),
  };
}
