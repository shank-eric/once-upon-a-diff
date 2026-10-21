/*
 * The panel's body for the step on screen: the step list, then the
 * Overview, a chapter, or a backstory moment, with its drafted comments, its
 * files and its questions. One click handler serves everything in it.
 */
import { escapeHtml } from '../util/html.js';
import { copyButtonText, copyComment } from './copy-buttons.js';

const stripChapterPrefix = (title) => title.replace(/^Chapter \d+:\s*/, '');

export function createBody(context) {
  const { story, state, shell } = context;
  const { data } = story;
  const { $ } = shell;
  const { markdown, inline } = context.markdown;
  const files = context.fileList;

  function stepListHtml() {
    const inBackstory = context.inBackstory();
    const overview = `<li data-n="0" class="${state.n === 0 ? 'prs-current' : ''}">${inBackstory ? 'How it got here' : 'Overview'} <span class="prs-count">(${data.files.length})</span></li>`;
    const steps = context.steps().map((step, index) => {
      const number = index + 1;
      let prefix = '';
      if (!inBackstory) {
        prefix = story.isNew(number)
          ? '<span class="prs-new">New</span> '
          : `${story.chapterNumber(number)}. `;
      }
      const progress = inBackstory
        ? ''
        : `<span class="prs-stepprog" data-prog-for="${number}"></span>`;
      return `<li data-n="${number}" class="${number === state.n ? 'prs-current' : ''}">${prefix}${escapeHtml(stripChapterPrefix(step.title))} <span class="prs-count">(${step.files.length})</span>${progress}</li>`;
    });
    return [overview].concat(steps).join('');
  }

  function titleText(chapter) {
    if (context.inBackstory()) {
      return `Backstory: ${chapter ? chapter.title.replace(/^\d+\.\s*/, '') : 'how it got here'}`;
    }
    return chapter ? chapter.title : `Overview: ${data.pr.title || ''}`;
  }

  function backstoryStepHtml(step) {
    context.refs.startStep(step ? step.files.map((file) => file.rel) : story.allRels);
    const banner =
      '<div class="prs-bs-banner">Backstory view: how this got here, in the order it happened. <button class="prs-linkish" data-view="story">Back to the story</button></div>';
    let intro;
    if (step) {
      intro = context.backstory.momentHtml(step);
    } else {
      const summary = story.backstory.summary
        ? markdown(story.backstory.summary)
        : '<p class="prs-empty">No summary written yet.</p>';
      intro = `${summary}${context.backstory.sessionsHtml()}`;
    }
    const items = (step ? step.files : data.files)
      .map((file) => files.fileItem(file, state.n))
      .join('');
    const head = step
      ? `Files changed in this step (${step.files.length})`
      : `All files (${data.files.length})`;
    return (
      `${banner}<div class="prs-md">${intro}</div><h2 class="prs-h">${head}</h2>` +
      `<ul class="prs-files">${items || '<li class="prs-empty">No files of the diff in this step.</li>'}</ul>`
    );
  }

  function overviewHtml() {
    context.refs.startStep(story.allRels);
    const intro = story.overviewMarkdown
      ? markdown(story.overviewMarkdown)
      : `${data.summary ? `<p>${inline(data.summary)}</p>` : ''}${data.plan ? `<p>${inline(data.plan)}</p>` : ''}`;
    const items = data.files.map((file) => files.fileItem(file, 0)).join('');
    const backstory = story.backstory;
    const backstoryTop =
      backstory && (backstory.summary || story.sessions.size)
        ? context.backstory.backstoryBlock(
            { summary: backstory.summary },
            context.backstory.sessionsHtml(),
          )
        : '';
    return `<div class="prs-md">${intro}</div>${backstoryTop}${context.drafts.allCommentsHtml()}${files.filesBox(`All files (${data.files.length})`, `${data.chapters.length} chapters`, items)}`;
  }

  function chapterHtml(chapter) {
    context.refs.startStep(chapter.files.map((file) => file.rel));
    const storyHtml = context.refs.storyWithPills(() => {
      if (chapter.narrative) {
        return markdown(chapter.narrative);
      }
      return (
        `${chapter.headline ? `<p><strong>${inline(chapter.headline)}</strong></p>` : ''}` +
        `${chapter.scenario ? `<p>The scenario: ${inline(chapter.scenario)}</p>` : ''}` +
        `${chapter.summary ? `<p>${inline(chapter.summary)}</p>` : ''}` +
        `<p class="prs-empty">This chapter's story isn't written yet.</p>`
      );
    });
    // the comments resolve their file names after the story and before the file list, as references do in reading order
    const comments = context.drafts.chapterCommentsHtml(chapter);
    const items = chapter.files.map((file) => files.fileItem(file, state.n)).join('');
    return `${context.freshness.sinceBanner(chapter)}<div class="prs-md">${storyHtml}</div>${context.backstory.backstoryBlock(chapter.backstory)}
        ${comments}
        ${files.filesBox(`Files in this chapter (${chapter.files.length})`, files.filesSummary(state.n), items)}`;
  }

  /** The viewed tracker sits right under the chapter's (or the Overview's) first heading. */
  function placeProgress() {
    const storyBox = $('.prs-body .prs-md');
    const holder = document.createElement('div');
    holder.innerHTML =
      '<div class="prs-progress" aria-live="polite"></div><div class="prs-early-box" role="status"></div>';
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
    const inBackstory = context.inBackstory();
    $('.prs-title').textContent = titleText(chapter);
    $('.prs-title').title = $('.prs-title').textContent;
    $('.prs-prev').disabled = state.n === 0;
    $('.prs-next').disabled = state.n === context.steps().length;
    const stepList = stepListHtml();
    let body;
    if (inBackstory) {
      body = backstoryStepHtml(chapter);
    } else if (!chapter) {
      body = overviewHtml();
    } else {
      body = chapterHtml(chapter);
    }
    $('.prs-body').innerHTML =
      `<h2 class="prs-h">${inBackstory ? 'Backstory steps' : 'Steps'}</h2><ol class="prs-map">${stepList}</ol>${body}<div class="prs-questions"></div>`;
    if (!inBackstory) {
      placeProgress();
    }
    const commentsBox = $('.prs-body details.prs-allc');
    if (commentsBox) {
      commentsBox.addEventListener('toggle', () => {
        state.allCommentsOpen = commentsBox.open;
      });
    }
    const filesBox = $('.prs-body details.prs-filesbox');
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
    context.reading.render();
    $('.prs-body').scrollTop = 0;
  }

  /** What a click in the body does, by what was clicked: the first match wins. */
  function onClick(event) {
    const target = event.target;
    const stepItem = target.closest('ol.prs-map li[data-n]');
    if (stepItem) {
      return context.navigation.go(Number(stepItem.getAttribute('data-n')));
    }
    const copyButton = target.closest('.prs-copy');
    if (copyButton) {
      const comment = copyButton.closest('.prs-comment');
      const step = Number(comment.getAttribute('data-n'));
      const index = Number(comment.getAttribute('data-i'));
      return copyComment(data.chapters[step - 1].comments[index].body, copyButton);
    }
    const gotoButton = target.closest('[data-goto]');
    if (gotoButton) {
      return context.navigation.go(Number(gotoButton.getAttribute('data-goto')));
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
      const comment = actButton.closest('.prs-comment');
      return context.drafts.act(
        Number(comment.getAttribute('data-n')),
        Number(comment.getAttribute('data-i')),
        actButton.getAttribute('data-draft-act'),
      );
    }
    const showButton = target.closest('[data-draft-show]');
    if (showButton) {
      const key = showButton.getAttribute('data-draft-show');
      state[key] = !state[key];
      context.saveState();
      return context.drafts.render();
    }
    const textButton = target.closest('[data-copy-text]');
    if (textButton) {
      return copyButtonText(textButton.getAttribute('data-copy-text'), textButton);
    }
    const viewButton = target.closest('[data-view]');
    if (viewButton) {
      return context.navigation.setView(viewButton.getAttribute('data-view'));
    }
    const whyButton = target.closest('.prs-whylink');
    if (whyButton) {
      const box = whyButton.closest('li').querySelector('.prs-whybox');
      if (box) {
        box.hidden = !box.hidden;
        whyButton.setAttribute('aria-expanded', String(!box.hidden));
      }
      return;
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
  $('.prs-body').addEventListener('click', onClick);

  return { render };
}
