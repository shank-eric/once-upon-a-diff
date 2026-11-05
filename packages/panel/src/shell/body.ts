/*
 * The panel's body for the step on screen: what's being changed, the step
 * list, then the Overview or a chapter, with its drafted comments, its fix
 * before push notes, its files and its questions. render() works out what the
 * step says (the story's text, the drafted comments) and view() draws it, with the step list and the file list
 * from the parts' live data. One click handler serves what the parts that still write strings put in it (the drafts, the fixes).
 */
import { Fragment, html } from '/assets/preact.mjs';
import { html as markup } from '@once-upon-a-diff/domain/html';
import { refAttrs } from '../components/file-refs.ts';
import type { VNode } from '@once-upon-a-diff/ui-kit/parse-markup';
import { PartsStrip } from '@once-upon-a-diff/ui-kit/components/parts-strip';
import type { SinceModel } from '../rebuild/freshness-part.ts';
import { plural } from '@once-upon-a-diff/domain/text';
import type { PanelContext } from '../host/context.ts';
import type { Chapter } from '@once-upon-a-diff/contracts/types';

const stripChapterPrefix = (title: string) => title.replace(/^Chapter \d+:\s*/, '');
const UNCOVERED_SHOWN = 12; // hunk links in the Overview's note before "and N more"

/** What the step says, worked out once per render: the markup the story's text and the drafted comments are, and which files it lists. */
interface Pieces {
  step: number;
  since: SinceModel | null;
  story: unknown;
  uncovered: unknown;
  /** the drafted comments' view (a function: parts hand the views their data fresh at each draw) */
  comments: () => VNode | null;
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
    const overview = html`<li data-n="0" class=${state.n === 0 ? 'ou-current' : undefined} onClick=${() => {
      context.count('panel.step.jump');
      context.navigation.go(0);
    }}>Overview <span class="ou-count">(${data.files.length})</span></li>`;
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
      return html`<li data-n=${number} class=${classes || undefined} onClick=${() => {
        context.count('panel.step.jump');
        context.navigation.go(number);
      }}>${prefix}${stripChapterPrefix(step.title)} <span class="ou-count">(${step.files.length})</span>${progress}${context.working.stepTag(number)}${context.marks.stepTags(number)}</li>`;
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
      comments: () => context.drafts.allCommentsView(),
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
      since: context.freshness.sinceModel(chapter),
      story: storyHtml,
      uncovered: null,
      // the comments resolve their file names after the story and before the file list, as references do in reading order
      comments: () => context.drafts.chapterCommentsView(chapter),
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
      <div class="ou-working">${context.working.bannerView()}</div><h2 class="ou-h">Steps</h2><ol class="ou-map">${stepList()}</ol>
      ${data.parts ? html`<${PartsStrip} parts=${data.parts} touched=${story.partsTouched(step)} counts=${step ? undefined : data.parts.files} />` : null}
      ${context.freshness.sinceView(pieces.since)}<div class="ou-md">${withBoxes(nodes(pieces.story))}</div>${nodes(pieces.uncovered)}${pieces.comments()}<div class="ou-fixes">${context.fixes.view()}</div>${files.filesBox(pieces.filesTitle, pieces.filesSummary, items)}<div class="ou-rebuild-box">${context.rebuild.boxView()}</div>
    </${Fragment}>`;
  }

  /** Works out the step on screen and draws it, then has the parts that write into it do so. */
  function render() {
    pieces = context.chapter() ? chapterPieces(context.chapter() as Chapter) : overviewPieces();
    renderId++;
    context.drafts.reset(); // the comments are drawn afresh
    context.viewed.compute(true); // the progress boxes draw from it, and the step list starts blank
    shell.redraw();
    context.questions.render();
    context.drafts.refresh(false);
    context.freshness.render();
    context.rebuild.render();
    context.working.dimPage();
    $('.ou-body')!.scrollTop = 0;
  }

  return { render, view, ready: () => pieces !== null };
}

export type Body = ReturnType<typeof createBody>;
