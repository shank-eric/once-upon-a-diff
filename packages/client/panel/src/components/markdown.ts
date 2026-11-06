/*
 * The story's markdown: the terms package's renderer with the panel's own links. Backticked file names and links to the PR's files become
 * jump links (ref-attrs.ts), each followed by its Mark viewed pill; every other link is the renderer's safe web link. What it returns
 * is raw() markup for html`` to take.
 */
import {
  createMarkdown as createDomainMarkdown,
  type MarkdownLink,
} from '@once-upon-a-diff/terms/html';
import { parseDiffLink, refLinkId } from '@once-upon-a-diff/terms/line-refs';
import { refAttrs } from './ref-attrs.ts';
import type { PanelContext } from '../host/context.ts';

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

  return createDomainMarkdown({ link });
}

export type Markdown = ReturnType<typeof createMarkdown>;
