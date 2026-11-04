/*
 * The story's markdown: ui's renderer with the panel's own links. Backticked file names and links to the PR's files become
 * jump links (file-refs.ts), each followed by its Mark viewed pill; every other link is ui's safe web link. What it returns
 * is raw() markup for html`` to take.
 */
import { createMarkdown as createUiMarkdown } from '@once-upon-a-diff/ui/markdown';
import { parseDiffLink, refLinkId } from '@once-upon-a-diff/protocol/domain/line-refs';
import { refAttrs } from './file-refs.ts';
import type { MarkdownLink } from '@once-upon-a-diff/ui/markdown';
import type { PanelContext } from './context.ts';

export function createMarkdown(context: PanelContext) {
  const { story, refs } = context;

  /** Links to this PR's files (and lines) scroll the page instead of navigating. `text` is markup already. */
  const link: MarkdownLink = (url, text) => {
    const id = refLinkId(url);
    const diffLink = parseDiffLink(url);
    const rel = diffLink && story.shaToPath.get(diffLink.sha);
    if (id !== null) {
      // a link by id: the ref's file and lines. A ref this text doesn't have is just its words.
      const ref = refs.refById(id);
      return ref && refs.fileOf(ref.path)
        ? `<span ${refAttrs(ref.path, refs.lineOf(ref))}>${text}</span>${refs.pill(ref.path)}`
        : text;
    }
    if (rel && refs.inScope(rel)) {
      return `<span ${refAttrs(rel, diffLink.line)}>${text}</span>${refs.pill(rel)}`;
    }
    return null;
  };

  return createUiMarkdown({ link });
}

export type Markdown = ReturnType<typeof createMarkdown>;
