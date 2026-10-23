/*
 * Drafted comments: each chapter's, and the Overview's list of all of them,
 * with their state from opts.drafts: posted, in the reviewer's pending review,
 * dismissed, a fix-before-push note (and whether it's sent or fixed), or still
 * a draft. The buttons are Copy, Dismiss, Restore, Add to my review (GitHub)
 * and Add to fix before push (with opts.fixes), and on a PR's Overview, Copy as gh script
 * (review-script.js) for every draft still to post. Posted is what gh finds
 * on the PR.
 *
 * draftView and shownIn have no DOM, so node tests can use them.
 */
import { html } from '../util/html.ts';
import { insertHtml, setHtml } from '../util/dom.ts';
import { capitalize } from '../util/text.ts';
import { refAttrs } from './file-refs.ts';
import { copyWithFallback } from './copy-buttons.ts';
import { scriptDrafts, reviewScript } from './review-script.ts';
import type { PanelContext } from './context.ts';
import type { Chapter, DraftAction, DraftComment, DraftFix, DraftRow, Side } from '../types.ts';

/** How a draft shows: see draftView. */
export type DraftShow = 'dismissed' | 'fix' | 'posted' | 'pending' | 'added' | 'draft';

/**
 * How the panel shows one draft row from the bridge: 'dismissed', 'fix', 'posted', 'pending', 'added' or 'draft'.
 * 'added' is Add to my review's own state: it's in their pending review, but GitHub doesn't redraw an open
 * Files changed page for that, so this page doesn't show it yet. It turns into the usual posted or pending
 * display once gh matches it on a page loaded after the add, or the comment turns up on the page (onPage).
 * settle: the add is confirmed, so the bridge can drop its `added` mark.
 */
export function draftView(
  row: Partial<DraftRow> | null | undefined,
  { pageAt = 0, onPage = false } = {},
): { show: DraftShow; settle: boolean } {
  const draft = row || { status: 'draft', dismissed: false };
  if (draft.dismissed) {
    return { show: 'dismissed', settle: false };
  }
  if (draft.fix) {
    return { show: 'fix', settle: false }; // a draft that's now a fix-before-push note
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

const plainText = (text: string | null | undefined) =>
  String(text || '')
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Does one of these comment texts on the page (rendered markdown) show this draft's body? */
export function shownIn(texts: (string | null)[], body: string): boolean {
  const want = plainText(body).slice(0, 160);
  if (want.length < 8) {
    return false;
  }
  return texts.some((text) => plainText(text).includes(want));
}

// kept across panel re-renders on this page: a failed Add to my review, and adds already settled
const reviewErrors = new Map<string, string>();
const settling = new Set<string>();

const ALL_COMMENTS_OPEN = 4; // more drafts than this and the Overview's list starts folded
const REFRESH_MS = 10000;
const SCRIPT_TITLE =
  'Copies a shell script that puts these line drafts into one pending review with gh api. It only copies: ' +
  'nothing is posted until you run it, and the review stays unsubmitted until you submit it on GitHub.';
const githubLink = (url: string) =>
  html` · <a href="${url}" target="_blank" rel="noopener noreferrer">view on GitHub</a>`;
/** How far a draft's fix-before-push note has got: sent to a session, fixed in a commit, or ticked done. */
function fixProgress(fix: DraftFix) {
  if (fix.state === 'fixed') {
    return html` · <span class="ou-ok">fixed in ${String(fix.sha || '').slice(0, 7)} ✓</span>`;
  }
  if (fix.state === 'sent') {
    return html` · sent to ${fix.sent_to || 'the next Claude session'}`;
  }
  return fix.done && html` · <span class="ou-ok">done ✓</span>`;
}
const lineJump = (rel: string, side: Side | undefined, line: number) =>
  html`<button class="ou-linkish" ${refAttrs(rel, { side: side === 'L' ? 'L' : 'R', start: Number(line), end: Number(line) })}>Jump to line ${line}</button>`;

export function createDrafts(context: PanelContext) {
  const { story, state, opts, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let rows: DraftRow[] = [];
  let loadError: string | null = null;
  let loadedAt = 0;
  let checked = false; // the bridge has said what's become of each draft at least once

  /** One drafted comment, with its step and index: render adds its state and its buttons. */
  function commentHtml(comment: DraftComment, step: number, index: number) {
    const general = !comment.line || /^\(/.test(comment.path || '');
    const ref = !general && context.refs.resolveRef(comment.path);
    let name;
    if (ref) {
      const line = {
        side: (comment.side === 'L' ? 'L' : 'R') as Side,
        start: comment.line,
        end: comment.line,
      };
      name = html`<code ${refAttrs(ref.rel, line)}>${comment.path}:${comment.line}</code>`;
    } else {
      name = html`<code>${comment.path}${!general && `:${comment.line}`}</code>`;
    }
    const where = general ? 'General PR comment' : html`On ${name}`;
    const head = html`<div class="ou-where"><span>${where}</span><span class="ou-cbtns"><button class="ou-copy">Copy</button></span></div>`;
    return html`<div class="ou-comment" data-n="${step}" data-i="${index}">${head}<pre>${comment.body}</pre><div class="ou-cstate" hidden></div></div>`;
  }

  /** A chapter's drafted comments, under their heading. */
  function chapterCommentsHtml(chapter: Chapter) {
    const comments = (chapter.comments || []).map((comment, index) =>
      commentHtml(comment, state.n, index),
    );
    if (!comments.length) {
      return null;
    }
    return html`<div class="ou-drafts"><h2 class="ou-h">${context.commentsTitle} <span class="ou-draftsum"></span></h2><div class="ou-drafttoggles"></div>${comments}</div>`;
  }

  /** The Overview's list of every chapter's drafted comments, grouped by chapter, each with its chapter's actions. */
  function allCommentsHtml() {
    const groups = data.chapters
      .map((chapter, index) => ({ step: index + 1, chapter, comments: chapter.comments || [] }))
      .filter((group) => group.comments.length);
    const total = groups.reduce((sum, group) => sum + group.comments.length, 0);
    if (!total) {
      return null;
    }
    const items = groups.map((group) => {
      const name = capitalize(story.chapterName(group.step));
      const title = String(group.chapter.title || '').replace(/^Chapter \d+:\s*/, '');
      const comments = group.comments.map((comment, index) =>
        commentHtml(comment, group.step, index),
      );
      return html`<div class="ou-cgroup" data-group="${group.step}"><h3 class="ou-cgh"><button class="ou-linkish" data-goto="${group.step}">${name}</button>: ${title}</h3>${comments}</div>`;
    });
    const open = state.allCommentsOpen != null ? state.allCommentsOpen : total <= ALL_COMMENTS_OPEN;
    const summary = html`<summary><h2 class="ou-h">${context.commentsTitle}: all chapters (${total}) <span class="ou-draftsum"></span></h2></summary>`;
    return html`<details class="ou-drafts ou-allc"${open && html` open`}>${summary}<div class="ou-drafttoggles"></div><pre class="ou-script" hidden></pre>${items}</details>`;
  }

  async function refresh(force: boolean) {
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
      checked = true;
    } catch (e) {
      loadError = (e && (e as Error).message) as string | null;
    }
    render();
  }

  const rowKey = (step: number, index: number) => {
    const row = rows.find((candidate) => candidate.chapter === step && candidate.index === index);
    return row && row.key ? row.key : `${step}:${index}`;
  };

  async function act(step: number, index: number, action: DraftAction) {
    const adding = action === 'review' || action === 'fix';
    const button =
      adding &&
      $<HTMLButtonElement>(
        `.ou-comment[data-n="${step}"][data-i="${index}"] [data-draft-act="${action}"]`,
      );
    if (button) {
      button.disabled = true;
      button.textContent = 'Adding…';
    }
    const key = rowKey(step, index);
    try {
      const result = await opts.drafts!.act(step, index, action); // its buttons show only with opts.drafts
      rows = result.drafts || rows;
      loadError = result.error || null;
      loadedAt = Date.now();
      if (adding) {
        reviewErrors.delete(key);
      }
      if (action === 'fix') {
        context.fixes.refresh(); // it's in Fix before push now
      }
      if (action === 'review' && result.added) {
        shell.message(
          `Added to your pending review${result.added.started ? ' (started a new one)' : ''}. Nobody else sees it until you submit the review.`,
        );
      }
    } catch (e) {
      const why = e && (e as Error).message ? (e as Error).message : String(e);
      if (adding) {
        reviewErrors.set(key, why); // shown on the draft, which keeps its buttons
      } else {
        shell.message(`Couldn't save that: ${why}`);
      }
    }
    render();
  }

  /** The PR's line drafts still to post, for Copy as gh script: null where there's no PR or gh hasn't been asked yet. */
  function scriptable() {
    const onPr =
      context.hostName === 'GitHub' && data.kind !== 'local' && data.pr.repo && data.pr.number;
    if (!onPr || !opts.drafts || !checked || loadError) {
      return null; // without gh's posted state, the script could post one twice
    }
    return scriptDrafts(data.chapters, rows, story.allRels);
  }

  /** Copy as gh script: copies the script, and nothing else. Running it is the reviewer's call. */
  function copyScript(button: HTMLElement) {
    const drafts = scriptable();
    if (!drafts || !drafts.comments.length) {
      return;
    }
    let text;
    try {
      text = reviewScript({ repo: data.pr.repo, number: data.pr.number, ...drafts });
    } catch (e) {
      shell.message(`Couldn't make the script: ${(e as Error).message}`);
      return;
    }
    copyWithFallback(text, button, $('.ou-script'));
  }

  function reloadPage() {
    if (opts.reloadPage) {
      opts.reloadPage();
    }
  }

  /** Is this line draft's comment on the page yet? Read only: it looks for its text in the file's comments. */
  function commentOnPage(comment: DraftComment | undefined) {
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
  function renderComment(
    el: HTMLElement,
    row: DraftRow,
    comment: DraftComment | undefined,
    step: number,
    index: number,
  ): DraftShow {
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
        () => settling.delete(row.key as string),
      );
    }
    const stateLine = el.querySelector<HTMLElement>('.ou-cstate')!;
    const buttons = el.querySelector('.ou-cbtns')!;
    for (const button of buttons.querySelectorAll('[data-draft-act]')) {
      button.remove();
    }
    el.classList.remove('ou-c-done', 'ou-c-pending');
    el.hidden = false;
    stateLine.hidden = true;
    const link = row.url && githubLink(row.url);
    const addButton = (action: DraftAction, label: string, title: string) =>
      insertHtml(
        buttons,
        'afterbegin',
        html`<button data-draft-act="${action}" title="${title}">${label}</button>`,
      );
    const showError = () => {
      const error = reviewErrors.get(row.key || `${step}:${index}`);
      if (error) {
        stateLine.hidden = false;
        setHtml(stateLine, html`<span class="ou-cerr">${error}</span>`);
      }
    };
    if (view.show === 'dismissed') {
      el.classList.add('ou-c-done');
      el.hidden = !state.showDismissed;
      stateLine.hidden = false;
      setHtml(stateLine, "Dismissed. It won't be suggested again for this PR.");
      addButton('restore', 'Restore', 'Bring this draft back');
    } else if (view.show === 'fix') {
      el.classList.add('ou-c-done', 'ou-c-pending');
      stateLine.hidden = false;
      const fix = row.fix as DraftFix; // draftView says 'fix' only with one
      const jump = lineJump(fix.path, fix.side, fix.line);
      setHtml(
        stateLine,
        html`<span class="ou-pend">In fix before push</span>${fixProgress(fix)} · ${jump}`,
      );
    } else if (view.show === 'posted') {
      el.classList.add('ou-c-done');
      el.hidden = !state.showPosted;
      stateLine.hidden = false;
      setHtml(stateLine, html`<span class="ou-ok">Posted ✓</span>${link}`);
    } else if (view.show === 'pending') {
      el.classList.add('ou-c-done', 'ou-c-pending');
      stateLine.hidden = false;
      const addedLink = row.added && row.added.url && githubLink(row.added.url);
      setHtml(
        stateLine,
        html`<span class="ou-pend">In your pending review</span>, not submitted yet${link || addedLink}`,
      );
    } else if (view.show === 'added') {
      // Add to my review worked, but this page won't show the comment until it's reloaded
      el.classList.add('ou-c-done', 'ou-c-pending');
      stateLine.hidden = false;
      const ref = comment && context.refs.resolveRef(comment.path);
      const jump =
        ref &&
        html` · ${lineJump(ref.rel, (comment as DraftComment).side, (comment as DraftComment).line)}`;
      const onGithub = row.added!.url && githubLink(row.added!.url); // 'added' means it has one
      const reload =
        opts.reloadPage &&
        html` <button class="ou-linkish" data-draft-reload title="Reloads this page. The panel stays on this chapter.">Reload page</button>`;
      const path = comment ? comment.path : '';
      const line = comment ? comment.line : '';
      setHtml(
        stateLine,
        html`<span class="ou-pend">In your pending review</span>, on ${path} line ${line}${jump}${onGithub}<span class="ou-cnote">GitHub shows it after a reload.${reload}</span>`,
      );
    } else {
      const unmapped = !!(comment && comment.unmapped);
      if (unmapped) {
        stateLine.hidden = false;
        setHtml(
          stateLine,
          html`<span class="ou-cstale">Kept from before the rebuild, but its line isn't in the diff any more. Check where it belongs before posting it.</span>`,
        );
      } else if (context.reading.isStaleDraft(step, index)) {
        stateLine.hidden = false;
        setHtml(
          stateLine,
          html`<span class="ou-cstale">May be out of date: a newer commit changed this line after you read the chapter.</span>`,
        );
      } else if (comment && comment.carried) {
        stateLine.hidden = false;
        setHtml(
          stateLine,
          html`<span class="ou-cdraft">Draft</span>, kept from before the rebuild`,
        );
      } else if (!state.n) {
        stateLine.hidden = false;
        setHtml(stateLine, html`<span class="ou-cdraft">Draft</span>, not posted`);
      }
      addButton(
        'dismiss',
        'Dismiss',
        "Not a comment you want: hide it, and don't suggest it again",
      );
      const onLine = comment && comment.path && Number(comment.line) > 0 && !unmapped;
      if (opts.fixes && onLine) {
        addButton(
          'fix',
          'Add to fix before push',
          'Makes it a fix-before-push note on its line, to send to the Claude session working the branch with the others',
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
    const box = $('.ou-drafts');
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
    for (const el of box.querySelectorAll<HTMLElement>('.ou-comment[data-i]')) {
      const step = Number(el.getAttribute('data-n'));
      const index = Number(el.getAttribute('data-i'));
      const row: DraftRow =
        byKey.get(`${step}:${index}`) || ({ status: 'draft', dismissed: false } as DraftRow);
      const comment = ((data.chapters[step - 1] || ({} as Partial<Chapter>)).comments || [])[index];
      const show = renderComment(el, row, comment, step, index);
      if (show === 'added') {
        counts.pending++;
      } else if (show in counts) {
        counts[show as keyof typeof counts]++;
      }
    }
    const { posted, pending, dismissed, fix: fixed } = counts;
    const left = shown.length
      ? shown.length - posted - pending - dismissed - fixed
      : box.querySelectorAll('.ou-comment[data-i]').length;
    const summary = [
      `${left} to post`,
      fixed && `${fixed} in fix before push`,
      posted && `${posted} posted`,
      pending && `${pending} pending`,
      dismissed && `${dismissed} dismissed`,
    ].filter(Boolean);
    box.querySelector('.ou-draftsum')!.textContent = shown.length ? `(${summary.join(' · ')})` : '';
    const forScript = overview ? scriptable() : null;
    const toggles = [
      forScript &&
        forScript.comments.length > 0 &&
        html`<button class="ou-linkish" data-draft-script title="${SCRIPT_TITLE}">Copy as gh script (${forScript.comments.length})</button>`,
      posted > 0 &&
        html`<button class="ou-linkish" data-draft-show="showPosted">${state.showPosted ? 'Hide' : 'Show'} posted (${posted})</button>`,
      dismissed > 0 &&
        html`<button class="ou-linkish" data-draft-show="showDismissed">${state.showDismissed ? 'Hide' : 'Show'} dismissed (${dismissed})</button>`,
      loadError &&
        html`<span class="ou-why" title="${loadError}">Couldn't check GitHub for posted comments.</span>`,
    ].filter(Boolean);
    setHtml(
      box.querySelector('.ou-drafttoggles')!,
      toggles.map((toggle, i) => html`${i > 0 && ' '}${toggle}`),
    );
  }

  return {
    chapterCommentsHtml,
    allCommentsHtml,
    refresh,
    act,
    render,
    reloadPage,
    copyScript,
    waitingOnPage,
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
