/*
 * The panel's body for the step on screen: what's being changed, the step
 * list, then the Overview or a chapter, with its drafted comments, its fix
 * before push notes, its files and its questions. render() works out what the
 * step says (the story's text, the drafted comments) and view() draws it, with the step list and the file list
 * from the parts' live data. One click handler serves what the parts that still write strings put in it (the drafts, the fixes).
 */
import { Fragment, html } from '/assets/preact.mjs';
import { html as markup } from '@once-upon-a-diff/protocol/domain/html';
import { copyComment } from './copy-buttons.ts';
import { refAttrs } from './file-refs.ts';
import type { VNode } from './parse-markup.ts';
import { plural } from '@once-upon-a-diff/protocol/domain/text';
import type { PanelContext } from './context.ts';
import type { Chapter, DraftAction, Side } from '@once-upon-a-diff/protocol/types';

const stripChapterPrefix = (title: string) => title.replace(/^Chapter \d+:\s*/, '');
const UNCOVERED_SHOWN = 12; // hunk links in the Overview's note before "and N more"

/** What the step says, worked out once per render: the markup the story's text and the drafted comments are, and which files it lists. */
interface Pieces {
  step: number;
  since: unknown;
  story: unknown;
  uncovered: unknown;
  comments: unknown;
  filesTitle: string;
  filesSummary: string;
  entries: Chapter['files'] | { rel: string }[];
}

export function createBody(context: PanelContext) {
  const { story, state, shell } = context;
  const { data } = story;
  const { $ } = shell;
  const { markdown, inline } = context.markdown;
  const files = context.fileList;
  let pieces: Pieces | null = null;
  let renderId = 0;

  /** The story's text and the drafted comments are strings: the nodes they make are given the parts' own behavior (markup.ts). */
  const nodes = (markupText: unknown) => context.markup.nodes(markupText);

  function stepList() {
    const overview = html`<li data-n="0" class=${state.n === 0 ? 'ou-current' : undefined} onClick=${() => context.navigation.go(0)}>Overview <span class="ou-count">(${data.files.length})</span></li>`;
    const steps = context.steps().map((step, index) => {
      const number = index + 1;
      const prefix = story.isNew(number)
        ? html`<span class="ou-new">New</span> `
        : `${story.chapterNumber(number)}. `;
      const done = context.viewed.stepProgress(number);
      const progress = step.unwritten
        ? html`<span class="ou-stepprog ou-writing" title="This chapter is being written">writing</span>`
        : html`<span class=${done?.done ? 'ou-stepprog ou-done' : 'ou-stepprog'} data-prog-for=${number} title=${done ? done.title : undefined}>${done ? done.text : null}</span>`;
      const classes = [
        number === state.n && 'ou-current',
        context.working.stepChanging(number) && 'ou-changing',
      ]
        .filter(Boolean)
        .join(' ');
      return html`<li data-n=${number} class=${classes || undefined} onClick=${() => context.navigation.go(number)}>${prefix}${stripChapterPrefix(step.title)} <span class="ou-count">(${step.files.length})</span>${progress}${context.working.stepTag(number)}${context.marks.stepTags(number)}</li>`;
    });
    return [overview, ...steps];
  }

  function overviewPieces(): Pieces {
    context.refs.startStep(story.allRels, data.overview_refs);
    const intro = story.overviewMarkdown
      ? markdown(story.overviewMarkdown)
      : markup`${data.summary && markup`<p>${inline(data.summary)}</p>`}${data.plan && markup`<p>${inline(data.plan)}</p>`}`;
    return {
      step: 0,
      since: null,
      story: intro,
      uncovered: uncoveredHtml(),
      comments: context.drafts.allCommentsHtml(),
      filesTitle: `All files (${data.files.length})`,
      filesSummary: `${data.chapters.length} chapters`,
      entries: data.files,
    };
  }

  /** A quiet note on the Overview: changed hunks no chapter points at (once-upon's build allowed them), as line links. */
  function uncoveredHtml() {
    const hunks = (data.uncovered_hunks || []).flatMap((file) =>
      file.hunks.map((hunk) => ({ rel: file.rel, hunk })),
    );
    if (!hunks.length) {
      return null;
    }
    const shown = hunks
      .slice(0, UNCOVERED_SHOWN)
      .map(
        ({ rel, hunk }, i) =>
          markup`${i ? ', ' : ''}<code ${refAttrs(rel, hunk)}>${hunk.ref}</code>`,
      );
    const more =
      hunks.length > UNCOVERED_SHOWN ? ` and ${hunks.length - UNCOVERED_SHOWN} more` : '';
    return markup`<p class="ou-quiet ou-uncovered">${plural(hunks.length, 'changed hunk')} no chapter points at: ${shown}${more}.</p>`;
  }

  function chapterPieces(chapter: Chapter): Pieces {
    context.refs.startStep(
      chapter.files.map((file) => file.rel),
      chapter.refs,
    );
    const storyHtml = context.refs.storyWithPills(() => {
      if (!chapter.unwritten && chapter.narrative.trim()) {
        return markdown(chapter.narrative);
      }
      const headline =
        chapter.headline && markup`<p><strong>${inline(chapter.headline)}</strong></p>`;
      const scenario = chapter.scenario && markup`<p>The scenario: ${inline(chapter.scenario)}</p>`;
      const summary = chapter.summary && markup`<p>${inline(chapter.summary)}</p>`;
      const note = chapter.unwritten
        ? "This chapter is being written. It'll show up here in a moment."
        : "This chapter's story isn't written yet.";
      return markup`${headline}${scenario}${summary}<p class="ou-empty">${note}</p>`;
    });
    return {
      step: state.n,
      since: context.freshness.sinceBanner(chapter),
      story: storyHtml,
      uncovered: null,
      // the comments resolve their file names after the story and before the file list, as references do in reading order
      comments: context.drafts.chapterCommentsHtml(chapter),
      filesTitle: `Files in this chapter (${chapter.files.length})`,
      filesSummary: files.filesSummary(state.n),
      entries: chapter.files,
    };
  }

  /** The story's nodes, with the viewed tracker's progress and early boxes under the first heading (or first, with none). */
  function withBoxes(storyNodes: (VNode | string)[]) {
    const boxes = context.viewed.boxes();
    const head = storyNodes.findIndex(
      (node) => typeof node !== 'string' && /^h[1-4]$/.test(String(node.type)),
    );
    if (head < 0) {
      return [...boxes, ...storyNodes];
    }
    return [...storyNodes.slice(0, head + 1), ...boxes, ...storyNodes.slice(head + 1)];
  }

  /** The body's content, drawn from what render() worked out and the parts' live data (null until there is a step to show). */
  function view(): VNode | null {
    if (!pieces) {
      return null;
    }
    const { step, entries } = pieces;
    const items = (entries as { rel: string }[]).map((file) => files.fileItem(file, step));
    return html`<${Fragment} key=${renderId}>
      <div class="ou-working"></div><h2 class="ou-h">Steps</h2><ol class="ou-map">${stepList()}</ol>
      ${nodes(pieces.since)}<div class="ou-md">${withBoxes(nodes(pieces.story))}</div>${nodes(pieces.uncovered)}${nodes(pieces.comments)}<div class="ou-fixes"></div>${files.filesBox(pieces.filesTitle, pieces.filesSummary, items)}<div class="ou-rebuild-box"></div>
    </${Fragment}>`;
  }

  /** Works out the step on screen and draws it, then has the parts that write into it do so. */
  function render() {
    pieces = context.chapter() ? chapterPieces(context.chapter() as Chapter) : overviewPieces();
    renderId++;
    context.viewed.compute(true); // the progress boxes draw from it, and the step list starts blank
    shell.redraw();
    context.questions.render();
    context.drafts.refresh(false);
    context.freshness.render();
    context.rebuild.render();
    context.fixes.render();
    context.working.paint();
    $('.ou-body')!.scrollTop = 0;
  }

  /**
   * What a click in the body does, by what was clicked: the first match wins. The step list and the Mark viewed buttons have their own
   * handlers; this one is for what the parts that still write strings (the drafts, the fixes, the questions) put in the body and the dock.
   */
  function onClick(event: MouseEvent) {
    const target = event.target as Element;
    const copyButton = target.closest('.ou-copy');
    if (copyButton) {
      const comment = copyButton.closest('.ou-comment') as Element;
      const step = Number(comment.getAttribute('data-n'));
      const index = Number(comment.getAttribute('data-i'));
      return copyComment(data.chapters[step - 1].comments[index].body, copyButton as HTMLElement);
    }
    const gotoButton = target.closest('[data-goto]');
    if (gotoButton) {
      return context.navigation.go(Number(gotoButton.getAttribute('data-goto')));
    }
    const scriptButton = target.closest('[data-draft-script]');
    if (scriptButton) {
      return context.drafts.copyScript(scriptButton as HTMLElement);
    }
    if (target.closest('[data-draft-reload]')) {
      return context.drafts.reloadPage();
    }
    const actButton = target.closest('[data-draft-act]');
    if (actButton) {
      const comment = actButton.closest('.ou-comment') as Element;
      return context.drafts.act(
        Number(comment.getAttribute('data-n')),
        Number(comment.getAttribute('data-i')),
        actButton.getAttribute('data-draft-act') as DraftAction,
      );
    }
    const fixControl = target.closest('[data-fix-act]');
    if (fixControl) {
      return context.fixes.act(fixControl as HTMLInputElement);
    }
    const showButton = target.closest('[data-draft-show]');
    if (showButton) {
      const key = showButton.getAttribute('data-draft-show') as 'showPosted' | 'showDismissed';
      state[key] = !state[key];
      context.saveState();
      return context.drafts.render();
    }
    const ref = target.closest('[data-rel]');
    if (!ref) {
      return;
    }
    const rel = ref.getAttribute('data-rel') as string;
    const start = +(ref.getAttribute('data-start') as string);
    const line = ref.hasAttribute('data-start')
      ? {
          side: (ref.getAttribute('data-side') || 'R') as Side,
          start,
          end: +(ref.getAttribute('data-end') as string) || start,
        }
      : null;
    context.scroll.jumpTo(rel, line);
  }
  $('.ou-body')!.addEventListener('click', onClick);

  return { render, view, ready: () => pieces !== null };
}

export type Body = ReturnType<typeof createBody>;
