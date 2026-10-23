/*
 * A tiny markdown renderer for the story's text: escape first, then a block
 * pass (code fences, quotes, headings, lists, paragraphs) and an inline pass
 * (code, bold, italics, links: http(s) or relative only, built with html``
 * so the href is escaped once, and never one with a code span inside its URL).
 * Backticked file names and links to the PR's
 * files become jump links (file-refs.js). It works on strings, so html``
 * isn't used inside; what it returns is raw() markup for html`` to take.
 */
import { escapeHtml, html as htmlTag, raw, unescapeHtml } from '../util/html.ts';
import { parseDiffLink } from '../util/line-refs.ts';
import { refAttrs } from './file-refs.ts';
import type { Html } from '../util/html.ts';
import type { PanelContext } from './context.ts';

// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const CODE_MARK = /\u0000(\d+)\u0000/g;
const LIST_ITEM = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/;
/**
 * The hrefs a link may have, as typed: http(s), or a path or #anchor on the page's own site. No other scheme, and
 * no quote, angle bracket, space or placeholder marker (a code span or pill inside the URL), so it can't leave its
 * attribute. Anything else stays text.
 */
// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const SAFE_HREF = /^(?:https?:\/\/|\/(?!\/)|\.{1,2}\/|#)[^\s"'<>`\u0000-\u0002]*$/;
// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const MARKERS = /[\u0000\u0001\u0002]/;
// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const LINK_MARK = /\u0002(\d+)\u0002/g;

/** The link's markup, or null when its URL isn't one SAFE_HREF allows. `text` is markup already. */
function linkHtml(text: string, escapedUrl: string): string | null {
  if (MARKERS.test(escapedUrl)) {
    return null;
  }
  const href = unescapeHtml(escapedUrl);
  if (!SAFE_HREF.test(href)) {
    return null;
  }
  return String(
    htmlTag`<a href="${href}" target="_blank" rel="noopener noreferrer">${raw(text)}</a>`,
  );
}

/** Bold and italics, on text that's escaped already. */
const emphasis = (text: string): string =>
  text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');

export function createMarkdown(context: PanelContext) {
  const { story, refs } = context;

  function inline(source: string): Html {
    const codes: string[] = [];
    let html = escapeHtml(source).replace(
      /`([^`]+)`/g,
      (match, code: string) => `\u0000${codes.push(code) - 1}\u0000`,
    );
    // links first, each kept aside whole, so the emphasis pass can't reach into a URL
    const links: string[] = [];
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
      // links to this PR's files (and lines) scroll the page instead of navigating
      const link = parseDiffLink(url);
      const rel = link && story.shaToPath.get(link.sha);
      let markup: string | null;
      if (rel && refs.inScope(rel)) {
        refs.noteMention(rel);
        markup = `<span ${refAttrs(rel, link.line)}>${emphasis(text)}</span>${refs.pill(rel)}`;
      } else {
        markup = linkHtml(emphasis(text), url);
      }
      return markup === null ? match : `\u0002${links.push(markup) - 1}\u0002`;
    });
    html = emphasis(html).replace(
      LINK_MARK,
      (match, indexText: string) => links[Number(indexText)],
    );
    html = html.replace(CODE_MARK, (match, indexText: string) => {
      const index = Number(indexText);
      const ref = refs.resolveRef(codes[index]);
      if (!ref) {
        return `<code>${codes[index]}</code>`;
      }
      const label = ref.bare
        ? `${escapeHtml(ref.rel.split('/').pop())}${codes[index]}`
        : codes[index];
      return `<code ${refAttrs(ref.rel, ref.line)}>${label}</code>${refs.pill(ref.rel)}`;
    });
    return raw(html);
  }

  function markdown(source: string | null | undefined): Html {
    const lines = String(source || '')
      .replace(/\r/g, '')
      .split('\n');
    let html = '';
    let paragraph: string[] = [];
    let lists: { type: 'ol' | 'ul'; indent: number }[] | null = null;
    const flushParagraph = () => {
      if (paragraph.length) {
        html += `<p>${inline(paragraph.join(' '))}</p>`;
      }
      paragraph = [];
    };
    const closeLists = (toIndent = -1) => {
      while (lists && lists.length && lists[lists.length - 1].indent > toIndent) {
        html += `</li></${lists.pop()!.type}>`;
      }
      if (lists && !lists.length) {
        lists = null;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushParagraph();
        closeLists();
        const body: string[] = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) {
          body.push(lines[i]);
        }
        html += `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushParagraph();
        closeLists();
        const body: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          body.push(lines[i++].replace(/^\s*> ?/, ''));
        }
        i--;
        html += `<blockquote>${markdown(body.join('\n'))}</blockquote>`;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeLists();
        html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
        continue;
      }
      const item = LIST_ITEM.exec(line);
      if (item) {
        flushParagraph();
        const indent = item[1].length;
        const type = /\d/.test(item[2]) ? 'ol' : 'ul';
        closeLists(indent);
        if (!lists) {
          lists = [];
        }
        const top = lists[lists.length - 1];
        if (top && top.indent === indent && top.type === type) {
          html += '</li><li>';
        } else {
          if (top && top.indent === indent) {
            html += `</li></${lists.pop()!.type}>`;
          }
          html += `<${type}><li>`;
          lists.push({ type, indent });
        }
        html += inline(item[3]);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        const next = lines[i + 1] || '';
        if (lists && !/^\s+\S/.test(next) && !/^\s*(\d+[.)]|[-*+])\s/.test(next)) {
          closeLists();
        }
        continue;
      }
      if (lists) {
        html += ' ' + inline(line.trim());
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    closeLists();
    return raw(html);
  }

  return { inline, markdown };
}

export type Markdown = ReturnType<typeof createMarkdown>;
