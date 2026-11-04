/*
 * Drafted comments: each chapter's, and the Overview's list of all of them, with their state from opts.drafts: posted, in the
 * reviewer's pending review, dismissed, a fix-before-push note (and whether it's sent or fixed), or still a draft. The buttons
 * are Copy, Dismiss, Restore, Add to my review (GitHub) and Add to fix before push (with opts.fixes), and on a PR's Overview,
 * Copy as gh script (review-script.ts) for every draft still to post. Posted is what gh finds on the PR.
 *
 * render() works out each comment's state (and the counts that sum them up) from the bridge's rows and the page, and the views
 * draw what it worked out: the comments, their buttons and the toggles under the title come from the one pass, so a count and
 * the rows it counts agree. What the old string panel rewrote by hand, a state the part keeps is reset where it rebuilt it:
 * reset() when the body is drawn again for a step, render() for the buttons and the toggles.
 *
 * Copy's "Copied" and the label timers are the part's, and are cleared in destroy().
 */
import { html } from '/assets/preact.mjs';
import { capitalize } from '@once-upon-a-diff/protocol/domain/text';
import { writeClipboard } from '../clipboard.ts';
import { draftView, shownIn, type DraftShow } from './drafts.ts';
import { scriptDrafts, reviewScript } from './review-script.ts';
import type { PanelContext } from '../context.ts';
import type {
  Chapter,
  DraftAction,
  DraftComment,
  DraftFix,
  DraftRow,
  Side,
} from '@once-upon-a-diff/protocol/types';

// kept across panel re-renders on this page: a failed Add to my review, and adds already settled
const reviewErrors = new Map<string, string>();
const settling = new Set<string>();

const ALL_COMMENTS_OPEN = 4; // more drafts than this and the Overview's list starts folded
const REFRESH_MS = 10000;
const COPY_LABEL_MS = 1500;
const SCRIPT_TITLE =
  'Copies a shell script that puts these line drafts into one pending review with gh api. It only copies: ' +
  'nothing is posted until you run it, and the review stays unsubmitted until you submit it on GitHub.';

/** What a comment's state line says (data, not nodes: the view draws it each time). */
type Line =
  | { kind: 'dismissed' }
  | { kind: 'fix'; fix: DraftFix }
  | { kind: 'posted'; link: string | null }
  | { kind: 'pending'; link: string | null }
  | {
      kind: 'added';
      path: string;
      line: number | string;
      rel: string | null;
      side: Side | undefined;
      link: string | null;
      reload: boolean;
    }
  | { kind: 'unmapped' }
  | { kind: 'stale' }
  | { kind: 'carried' }
  | { kind: 'notposted' }
  | { kind: 'error'; error: string };

interface Button {
  action: DraftAction;
  label: string;
  title: string;
}

/** One comment as render() worked it out: how it shows, its buttons, and its state line (and what the element still holds). */
interface Model {
  classes: string;
  hidden: boolean;
  /** shown under the comment, or null for hidden */
  line: Line | null;
  /** what the state line holds: its last content stays when it is hidden, as the old element's did */
  content: Line | null;
  buttons: Button[];
}

interface Toggles {
  script: number | null;
  posted: number;
  dismissed: number;
  loadError: string | null;
}

/** Selects the element's text, so Cmd+C works when the clipboard said no. */
function selectText(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection() as Selection; // null only in a frame with no browsing context
  selection.removeAllRanges();
  selection.addRange(range);
}

export function createDrafts(context: PanelContext) {
  const { story, state, opts, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let rows: DraftRow[] = [];
  let loadError: string | null = null;
  let loadedAt = 0;
  let checked = false; // the bridge has said what's become of each draft at least once
  let alive = true;

  let models = new Map<string, Model>();
  let adding = new Set<string>(); // `${step}:${index}:${action}` for an Add that is out
  let summary = '';
  let toggles: Toggles | null = null;
  let scriptText: string | null = null; // the script, shown to copy by hand when the clipboard said no
  const copied = new Map<string, string>(); // a Copy button's label while it says how it went
  const copyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const keyOf = (step: number, index: number) => `${step}:${index}`;

  // ---------- views

  const githubLink = (url: string) =>
    html` · <a href=${url} target="_blank" rel="noopener noreferrer">view on GitHub</a>`;

  /** How far a draft's fix-before-push note has got: sent to a session, fixed in a commit, or ticked done. */
  function fixProgress(fix: DraftFix) {
    if (fix.state === 'fixed') {
      return html` · <span class="ou-ok">fixed in ${String(fix.sha || '').slice(0, 7)} ✓</span>`;
    }
    if (fix.state === 'sent') {
      return html` · sent to ${fix.sent_to || 'the next Claude session'}`;
    }
    return fix.done ? html` · <span class="ou-ok">done ✓</span>` : null;
  }

  const lineJump = (rel: string, side: Side | undefined, line: number | string) =>
    html`<button class="ou-linkish" ...${context.refs.jumpProps(rel, { side: side === 'L' ? 'L' : 'R', start: Number(line), end: Number(line) })}>Jump to line ${line}</button>`;

  /** What a comment's state line says. */
  function lineView(line: Line) {
    switch (line.kind) {
      case 'dismissed':
        return "Dismissed. It won't be suggested again for this PR.";
      case 'fix': {
        const fix = line.fix;
        return html`<span class="ou-pend">In fix before push</span>${fixProgress(fix)} · ${lineJump(fix.path, fix.side, fix.line)}`;
      }
      case 'posted':
        return html`<span class="ou-ok">Posted ✓</span>${line.link && githubLink(line.link)}`;
      case 'pending':
        return html`<span class="ou-pend">In your pending review</span>, not submitted yet${line.link && githubLink(line.link)}`;
      case 'added': {
        const jump = line.rel && html` · ${lineJump(line.rel, line.side, line.line)}`;
        const reload = line.reload
          ? html` <button class="ou-linkish" data-draft-reload="" title="Reloads this page. The panel stays on this chapter." onClick=${reloadPage}>Reload page</button>`
          : null;
        return html`<span class="ou-pend">In your pending review</span>, on ${line.path} line ${line.line}${jump}${line.link && githubLink(line.link)}<span class="ou-cnote">GitHub shows it after a reload.${reload}</span>`;
      }
      case 'unmapped':
        return html`<span class="ou-cstale">Kept from before the rebuild, but its line isn't in the diff any more. Check where it belongs before posting it.</span>`;
      case 'stale':
        return html`<span class="ou-cstale">May be out of date: a newer commit changed this line after you read the chapter.</span>`;
      case 'carried':
        return html`<span class="ou-cdraft">Draft</span>, kept from before the rebuild`;
      case 'notposted':
        return html`<span class="ou-cdraft">Draft</span>, not posted`;
      case 'error':
        return html`<span class="ou-cerr">${line.error}</span>`;
    }
  }

  /** One drafted comment, with its step and index: its state and buttons are what render() worked out for it. */
  function commentView(comment: DraftComment, step: number, index: number) {
    const key = keyOf(step, index);
    const model = models.get(key);
    const general = !comment.line || /^\(/.test(comment.path || '');
    const rel = !general ? context.refs.fileOf(comment.path) : null;
    let name;
    if (rel) {
      const line = {
        side: (comment.side === 'L' ? 'L' : 'R') as Side,
        start: comment.line,
        end: comment.line,
      };
      name = html`<code ...${context.refs.jumpProps(rel, line)}>${comment.path}:${comment.line}</code>`;
    } else {
      name = html`<code>${comment.path}${!general && `:${comment.line}`}</code>`;
    }
    const where = general ? 'General PR comment' : html`On ${name}`;
    const buttons = (model?.buttons || []).map((button) => {
      const adds = adding.has(`${key}:${button.action}`);
      return html`<button key=${button.action} data-draft-act=${button.action} title=${button.title} disabled=${adds} onClick=${() => act(step, index, button.action)}>${adds ? 'Adding…' : button.label}</button>`;
    });
    return html`<div class=${model?.classes || 'ou-comment'} data-n=${step} data-i=${index} hidden=${model?.hidden || false}><div class="ou-where"><span>${where}</span><span class="ou-cbtns">${buttons}<button class="ou-copy" onClick=${() => copyComment(step, index, comment.body)}>${copied.get(key) || 'Copy'}</button></span></div><pre>${comment.body}</pre><div class="ou-cstate" hidden=${!model?.line}>${model?.content ? lineView(model.content) : null}</div></div>`;
  }

  /** The Copy as gh script, Show/Hide posted and dismissed buttons and the load error, in a row. */
  function togglesView() {
    if (!toggles) {
      return null;
    }
    const items: unknown[] = [];
    if (toggles.script) {
      items.push(
        html`<button class="ou-linkish" data-draft-script="" title=${SCRIPT_TITLE} onClick=${copyScript}>${copied.get('script') || `Copy as gh script (${toggles.script})`}</button>`,
      );
    }
    if (toggles.posted > 0) {
      items.push(showToggle('showPosted', 'posted', toggles.posted));
    }
    if (toggles.dismissed > 0) {
      items.push(showToggle('showDismissed', 'dismissed', toggles.dismissed));
    }
    if (toggles.loadError) {
      items.push(
        html`<span class="ou-why" title=${toggles.loadError}>Couldn't check GitHub for posted comments.</span>`,
      );
    }
    return items.flatMap((item, i) => (i > 0 ? [' ', item] : [item]));
  }

  const showToggle = (key: 'showPosted' | 'showDismissed', word: string, count: number) =>
    html`<button class="ou-linkish" data-draft-show=${key} onClick=${() => {
      state[key] = !state[key];
      context.saveState();
      render();
    }}>${state[key] ? 'Hide' : 'Show'} ${word} (${count})</button>`;

  /** A chapter's drafted comments, under their heading (null with none). */
  function chapterCommentsView(chapter: Chapter) {
    const comments = (chapter.comments || []).map((comment, index) =>
      commentView(comment, state.n, index),
    );
    if (!comments.length) {
      return null;
    }
    return html`<div class="ou-drafts"><h2 class="ou-h">${context.commentsTitle} <span class="ou-draftsum">${summary}</span></h2><div class="ou-drafttoggles">${togglesView()}</div>${comments}</div>`;
  }

  /** The Overview's list of every chapter's drafted comments, grouped by chapter, each with its chapter's actions. */
  function allCommentsView() {
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
        commentView(comment, group.step, index),
      );
      return html`<div class="ou-cgroup" data-group=${group.step}><h3 class="ou-cgh"><button class="ou-linkish" data-goto=${group.step} onClick=${() => context.navigation.go(group.step)}>${name}</button>: ${title}</h3>${comments}</div>`;
    });
    const open = state.allCommentsOpen != null ? state.allCommentsOpen : total <= ALL_COMMENTS_OPEN;
    const onToggle = (event: Event) => {
      state.allCommentsOpen = (event.currentTarget as HTMLDetailsElement).open;
    };
    return html`<details class="ou-drafts ou-allc" open=${open} onToggle=${onToggle}><summary><h2 class="ou-h">${context.commentsTitle}: all chapters (${total}) <span class="ou-draftsum">${summary}</span></h2></summary><div class="ou-drafttoggles">${togglesView()}</div><pre class="ou-script" hidden=${!scriptText}>${scriptText}</pre>${items}</details>`;
  }

  // ---------- the bridge's rows

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
    return row && row.key ? row.key : keyOf(step, index);
  };

  async function act(step: number, index: number, action: DraftAction) {
    const adding_ = action === 'review' || action === 'fix';
    if (adding_) {
      adding.add(`${keyOf(step, index)}:${action}`);
      shell.redraw();
    }
    const key = rowKey(step, index);
    try {
      const result = await opts.drafts!.act(step, index, action); // its buttons show only with opts.drafts
      rows = result.drafts || rows;
      loadError = result.error || null;
      loadedAt = Date.now();
      if (adding_) {
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
      if (adding_) {
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
    return scriptDrafts(data.chapters, rows);
  }

  // ---------- Copy

  /** Says how a copy went on its button for a moment (the label goes back by itself). */
  function showCopied(key: string, label: string) {
    clearTimeout(copyTimers.get(key));
    copied.set(key, label);
    copyTimers.set(
      key,
      setTimeout(() => {
        copyTimers.delete(key);
        copied.delete(key);
        shell.redraw();
      }, COPY_LABEL_MS),
    );
    shell.redraw();
  }

  /** A drafted comment's Copy: the clipboard, else selecting the comment's text and execCommand. */
  function copyComment(step: number, index: number, text: string) {
    const key = keyOf(step, index);
    writeClipboard(text).then((ok) => {
      if (!alive) {
        return;
      }
      if (ok) {
        return showCopied(key, 'Copied');
      }
      const pre = $(`.ou-comment[data-n="${step}"][data-i="${index}"] pre`);
      if (pre) {
        selectText(pre);
      }
      let done = false;
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      showCopied(key, done ? 'Copied' : 'Select and copy');
    });
  }

  /** Copy as gh script: copies the script, and nothing else. Running it is the reviewer's call. */
  function copyScript() {
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
    writeClipboard(text).then((ok) => {
      if (!alive) {
        return;
      }
      if (!ok) {
        scriptText = text; // shown selected, so Cmd+C works
      }
      showCopied('script', ok ? 'Copied' : 'Select and copy');
      const pre = !ok && $('.ou-script');
      if (pre) {
        selectText(pre);
      }
    });
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
    const rel = context.refs.fileOf(comment.path);
    const block = rel && context.page.blockOf(rel);
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

  // ---------- what render() works out

  const githubLinkOf = (url: string | null | undefined) => url || null;

  /** One comment's model: how it shows, what its state line says, which buttons it has. Returns what it shows, for the counts. */
  function modelComment(
    row: DraftRow,
    comment: DraftComment | undefined,
    step: number,
    index: number,
    settle: { step: number; index: number; key: string }[],
  ): { show: DraftShow; model: Model } {
    const key = keyOf(step, index);
    const view = draftView(row, {
      pageAt: context.pageLoadedAt,
      onPage: !!row.added && commentOnPage(comment),
    });
    if (view.settle && row.key && !settling.has(row.key) && opts.drafts) {
      settling.add(row.key);
      settle.push({ step, index, key: row.key });
    }
    const classes = ['ou-comment'];
    let hidden = false;
    let line: Line | null = null;
    const buttons: Button[] = [];
    // a button added later sits before the ones added earlier
    const addButton = (action: DraftAction, label: string, title: string) =>
      buttons.unshift({ action, label, title });
    const showError = () => {
      const error = reviewErrors.get(row.key || key);
      if (error) {
        line = { kind: 'error', error };
      }
    };
    if (view.show === 'dismissed') {
      classes.push('ou-c-done');
      hidden = !state.showDismissed;
      line = { kind: 'dismissed' };
      addButton('restore', 'Restore', 'Bring this draft back');
    } else if (view.show === 'fix') {
      classes.push('ou-c-done', 'ou-c-pending');
      line = { kind: 'fix', fix: row.fix as DraftFix }; // draftView says 'fix' only with one
    } else if (view.show === 'posted') {
      classes.push('ou-c-done');
      hidden = !state.showPosted;
      line = { kind: 'posted', link: githubLinkOf(row.url) };
    } else if (view.show === 'pending') {
      classes.push('ou-c-done', 'ou-c-pending');
      line = { kind: 'pending', link: githubLinkOf(row.url) || githubLinkOf(row.added?.url) };
    } else if (view.show === 'added') {
      // Add to my review worked, but this page won't show the comment until it's reloaded
      classes.push('ou-c-done', 'ou-c-pending');
      line = {
        kind: 'added',
        path: comment ? comment.path : '',
        line: comment ? comment.line : '',
        rel: comment ? context.refs.fileOf(comment.path) : null,
        side: comment ? comment.side : undefined,
        link: row.added!.url || null, // GitHub may return no comment URL
        reload: !!opts.reloadPage,
      };
    } else {
      const unmapped = !!(comment && comment.unmapped);
      if (unmapped) {
        line = { kind: 'unmapped' };
      } else if (context.reading.isStaleDraft(step, index)) {
        line = { kind: 'stale' };
      } else if (comment && comment.carried) {
        line = { kind: 'carried' };
      } else if (!state.n) {
        line = { kind: 'notposted' };
      }
      addButton(
        'dismiss',
        'Dismiss',
        "Not a comment you want: hide it, and don't suggest it again",
      );
      const onLine = comment && comment.path && Number(comment.line) > 0 && !unmapped;
      if (opts.fixes && onLine && context.fixes.canAdd()) {
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
    return {
      show: view.show,
      model: {
        classes: classes.join(' '),
        hidden,
        line,
        content: line || models.get(key)?.content || null,
        buttons,
      },
    };
  }

  /** Works out every comment on screen (and the counts and toggles), and draws them. */
  function render() {
    if (!alive) {
      return; // a late answer after the panel was closed
    }
    const overview = !state.n; // the Overview lists every chapter's drafts
    const chapters = overview
      ? data.chapters.map((chapter, i) => ({ step: i + 1, chapter }))
      : [{ step: state.n, chapter: context.chapter() as Chapter }];
    const comments = chapters.flatMap(({ step, chapter }) =>
      ((chapter && chapter.comments) || []).map((comment, index) => ({ step, index, comment })),
    );
    if (!comments.length) {
      return;
    }
    const shown = rows.filter((row) => {
      if (overview) {
        const chapter = data.chapters[row.chapter - 1];
        return chapter && (chapter.comments || [])[row.index];
      }
      return row.chapter === state.n;
    });
    const byKey = new Map(shown.map((row) => [keyOf(row.chapter, row.index), row]));
    const counts = { posted: 0, pending: 0, dismissed: 0, fix: 0 };
    const settle: { step: number; index: number; key: string }[] = [];
    const next = new Map<string, Model>();
    for (const { step, index, comment } of comments) {
      const row: DraftRow =
        byKey.get(keyOf(step, index)) || ({ status: 'draft', dismissed: false } as DraftRow);
      const { show, model } = modelComment(row, comment, step, index, settle);
      next.set(keyOf(step, index), model);
      if (show === 'added') {
        counts.pending++;
      } else if (show in counts) {
        counts[show as keyof typeof counts]++;
      }
    }
    const { posted, pending, dismissed, fix: fixed } = counts;
    const left = shown.length
      ? shown.length - posted - pending - dismissed - fixed
      : comments.length;
    const parts = [
      `${left} to post`,
      fixed && `${fixed} in fix before push`,
      posted && `${posted} posted`,
      pending && `${pending} pending`,
      dismissed && `${dismissed} dismissed`,
    ].filter(Boolean);
    const forScript = overview ? scriptable() : null;
    models = next;
    adding = new Set(); // the buttons are drawn afresh
    copied.delete('script'); // and so is the toggle row
    summary = shown.length ? `(${parts.join(' · ')})` : '';
    toggles = {
      script: forScript && forScript.comments.length > 0 ? forScript.comments.length : null,
      posted,
      dismissed,
      loadError,
    };
    shell.redraw();
    for (const due of settle) {
      settleDraft(due.step, due.index, due.key);
    }
  }

  /** The bridge can drop an add's mark once it is confirmed: asked once, after the draw that found it due. */
  function settleDraft(step: number, index: number, key: string) {
    opts.drafts!.act(step, index, 'settle').then(
      (result) => {
        rows = result.drafts || rows;
        render();
      },
      () => settling.delete(key),
    );
  }

  /** The body is drawn again for a step: what the old comments' elements held is gone, and the new ones start as drafts. */
  function reset() {
    models = new Map();
    adding = new Set();
    summary = '';
    toggles = null;
    scriptText = null;
    copied.clear();
    for (const timer of copyTimers.values()) {
      clearTimeout(timer);
    }
    copyTimers.clear();
  }

  function destroy() {
    alive = false;
    reset();
  }

  return {
    chapterCommentsView,
    allCommentsView,
    refresh,
    act,
    render,
    reset,
    reloadPage,
    copyScript,
    waitingOnPage,
    destroy,
  };
}

export type Drafts = ReturnType<typeof createDrafts>;
