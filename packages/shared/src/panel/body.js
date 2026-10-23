/*
 * The panel's body for the step on screen: what's being changed, the step
 * list, then the Overview or a chapter, with its drafted comments, its fix
 * before push notes, its files and its questions. One click handler serves
 * everything in it.
 */
import { html } from '../util/html.js';
import { setHtml } from '../util/dom.js';
import { copyComment } from './copy-buttons.js';
import { plural } from '../util/text.js';

const stripChapterPrefix = (title) => title.replace(/^Chapter \d+:\s*/, '');
const UNCOVERED_SHOWN = 12; // hunk links in the Overview's note before "and N more"

export function createBody(context) {
  const { story, state, shell } = context;
  const { data } = story;
  const { $ } = shell;
  const { markdown, inline } = context.markdown;
  const files = context.fileList;

  function stepListHtml() {
    const overview = html`<li data-n="0" class="${state.n === 0 ? 'ou-current' : ''}">Overview <span class="ou-count">(${data.files.length})</span></li>`;
    const steps = context.steps().map((step, index) => {
      const number = index + 1;
      const prefix = story.isNew(number)
        ? html`<span class="ou-new">New</span> `
        : `${story.chapterNumber(number)}. `;
      const progress = html`<span class="ou-stepprog" data-prog-for="${number}"></span>`;
      return html`<li data-n="${number}" class="${number === state.n ? 'ou-current' : ''}">${prefix}${stripChapterPrefix(step.title)} <span class="ou-count">(${step.files.length})</span>${progress}</li>`;
    });
    return [overview, ...steps];
  }

  const titleText = (chapter) => (chapter ? chapter.title : `Overview: ${data.pr.title || ''}`);

  function overviewHtml() {
    context.refs.startStep(story.allRels);
    const intro = story.overviewMarkdown
      ? markdown(story.overviewMarkdown)
      : html`${data.summary && html`<p>${inline(data.summary)}</p>`}${data.plan && html`<p>${inline(data.plan)}</p>`}`;
    const items = data.files.map((file) => files.fileItem(file, 0));
    const filesBox = files.filesBox(
      `All files (${data.files.length})`,
      `${data.chapters.length} chapters`,
      items,
    );
    return html`<div class="ou-md">${intro}</div>${uncoveredHtml()}${context.drafts.allCommentsHtml()}<div class="ou-fixes"></div>${filesBox}<div class="ou-rebuild-box"></div>`;
  }

  /** A quiet note on the Overview: changed hunks no chapter points at (once-upon's build allowed them), as line links. */
  function uncoveredHtml() {
    const refs = (data.uncovered_hunks || []).flatMap((file) =>
      file.hunks.map((hunk) => `\`${hunk.ref}\``),
    );
    if (!refs.length) {
      return null;
    }
    const shown = refs.slice(0, UNCOVERED_SHOWN).join(', ');
    const more = refs.length > UNCOVERED_SHOWN ? ` and ${refs.length - UNCOVERED_SHOWN} more` : '';
    return html`<p class="ou-quiet ou-uncovered">${inline(`${plural(refs.length, 'changed hunk')} no chapter points at: ${shown}${more}.`)}</p>`;
  }

  function chapterHtml(chapter) {
    context.refs.startStep(chapter.files.map((file) => file.rel));
    const storyHtml = context.refs.storyWithPills(() => {
      if (chapter.narrative) {
        return markdown(chapter.narrative);
      }
      const headline =
        chapter.headline && html`<p><strong>${inline(chapter.headline)}</strong></p>`;
      const scenario = chapter.scenario && html`<p>The scenario: ${inline(chapter.scenario)}</p>`;
      const summary = chapter.summary && html`<p>${inline(chapter.summary)}</p>`;
      return html`${headline}${scenario}${summary}<p class="ou-empty">This chapter's story isn't written yet.</p>`;
    });
    // the comments resolve their file names after the story and before the file list, as references do in reading order
    const comments = context.drafts.chapterCommentsHtml(chapter);
    const items = chapter.files.map((file) => files.fileItem(file, state.n));
    return html`${context.freshness.sinceBanner(chapter)}<div class="ou-md">${storyHtml}</div>
        ${comments}<div class="ou-fixes"></div>
        ${files.filesBox(`Files in this chapter (${chapter.files.length})`, files.filesSummary(state.n), items)}
        <div class="ou-rebuild-box"></div>`;
  }

  /** The viewed tracker sits right under the chapter's (or the Overview's) first heading. */
  function placeProgress() {
    const storyBox = $('.ou-body .ou-md');
    const holder = document.createElement('div');
    setHtml(
      holder,
      html`<div class="ou-progress" aria-live="polite"></div><div class="ou-early-box" role="status"></div>`,
    );
    const head =
      storyBox && storyBox.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
    if (head) {
      head.after(...holder.childNodes);
    } else if (storyBox) {
      storyBox.prepend(...holder.childNodes);
    }
  }

  function render() {
    const chapter = context.chapter();
    $('.ou-title').textContent = titleText(chapter);
    $('.ou-title').title = $('.ou-title').textContent;
    $('.ou-prev').disabled = state.n === 0;
    $('.ou-next').disabled = state.n === context.steps().length;
    const stepList = stepListHtml();
    const body = chapter ? chapterHtml(chapter) : overviewHtml();
    setHtml(
      $('.ou-body'),
      html`<div class="ou-working"></div><h2 class="ou-h">Steps</h2><ol class="ou-map">${stepList}</ol>${body}<div class="ou-questions"></div>`,
    );
    placeProgress();
    const commentsBox = $('.ou-body details.ou-allc');
    if (commentsBox) {
      commentsBox.addEventListener('toggle', () => {
        state.allCommentsOpen = commentsBox.open;
      });
    }
    const filesBox = $('.ou-body details.ou-filesbox');
    if (filesBox) {
      filesBox.addEventListener('toggle', () => {
        if (state.filesOpen !== filesBox.open) {
          state.filesOpen = filesBox.open;
          context.saveState();
        }
      });
    }
    context.questions.render();
    context.viewed.render();
    context.drafts.refresh(false);
    context.freshness.render();
    context.rebuild.render();
    context.marks.render();
    context.fixes.render();
    context.working.render();
    $('.ou-body').scrollTop = 0;
  }

  /** What a click in the body does, by what was clicked: the first match wins. */
  function onClick(event) {
    const target = event.target;
    const stepItem = target.closest('ol.ou-map li[data-n]');
    if (stepItem) {
      return context.navigation.go(Number(stepItem.getAttribute('data-n')));
    }
    const copyButton = target.closest('.ou-copy');
    if (copyButton) {
      const comment = copyButton.closest('.ou-comment');
      const step = Number(comment.getAttribute('data-n'));
      const index = Number(comment.getAttribute('data-i'));
      return copyComment(data.chapters[step - 1].comments[index].body, copyButton);
    }
    const gotoButton = target.closest('[data-goto]');
    if (gotoButton) {
      return context.navigation.go(Number(gotoButton.getAttribute('data-goto')));
    }
    const scriptButton = target.closest('[data-draft-script]');
    if (scriptButton) {
      return context.drafts.copyScript(scriptButton);
    }
    if (target.closest('[data-draft-reload]')) {
      return context.drafts.reloadPage();
    }
    const markButton = target.closest('button[data-mark-for]');
    if (markButton) {
      return context.viewed.toggle(markButton.getAttribute('data-mark-for'));
    }
    const actButton = target.closest('[data-draft-act]');
    if (actButton) {
      const comment = actButton.closest('.ou-comment');
      return context.drafts.act(
        Number(comment.getAttribute('data-n')),
        Number(comment.getAttribute('data-i')),
        actButton.getAttribute('data-draft-act'),
      );
    }
    const fixControl = target.closest('[data-fix-act]');
    if (fixControl) {
      return context.fixes.act(fixControl);
    }
    const questionButton = target.closest('[data-qa-act]');
    if (questionButton) {
      return context.questions.act(questionButton);
    }
    const showButton = target.closest('[data-draft-show]');
    if (showButton) {
      const key = showButton.getAttribute('data-draft-show');
      state[key] = !state[key];
      context.saveState();
      return context.drafts.render();
    }
    const ref = target.closest('[data-rel]');
    if (!ref) {
      return;
    }
    const rel = ref.getAttribute('data-rel');
    const start = +ref.getAttribute('data-start');
    const line = ref.hasAttribute('data-start')
      ? {
          side: ref.getAttribute('data-side') || 'R',
          start,
          end: +ref.getAttribute('data-end') || start,
        }
      : null;
    context.scroll.jumpTo(rel, line);
  }
  $('.ou-body').addEventListener('click', onClick);

  return { render };
}
