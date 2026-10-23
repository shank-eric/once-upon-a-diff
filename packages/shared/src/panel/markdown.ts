// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * A tiny markdown renderer for the story's text: escape first, then a block
 * pass (code fences, quotes, headings, lists, paragraphs) and an inline pass
 * (code, bold, italics, links). Backticked file names and links to the PR's
 * files become jump links (file-refs.js). It works on strings, so html``
 * isn't used inside; what it returns is raw() markup for html`` to take.
 */
import { escapeHtml, raw } from '../util/html.ts';
import { parseDiffLink } from '../util/line-refs.ts';
import { refAttrs } from './file-refs.ts';

// eslint-disable-next-line no-control-regex -- the placeholder markers are control characters on purpose
const CODE_MARK = /\u0000(\d+)\u0000/g;
const LIST_ITEM = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/;

export function createMarkdown(context) {
  const { story, refs } = context;

  function inline(source) {
    const codes = [];
    let html = escapeHtml(source).replace(
      /`([^`]+)`/g,
      (match, code) => `\u0000${codes.push(code) - 1}\u0000`,
    );
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (match, text, url) => {
        // links to this PR's files (and lines) scroll the page instead of navigating
        const link = parseDiffLink(url);
        const rel = link && story.shaToPath.get(link.sha);
        if (rel && refs.inScope(rel)) {
          refs.noteMention(rel);
          return `<span ${refAttrs(rel, link.line)}>${text}</span>${refs.pill(rel)}`;
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      });
    html = html.replace(CODE_MARK, (match, index) => {
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

  function markdown(source) {
    const lines = String(source || '')
      .replace(/\r/g, '')
      .split('\n');
    let html = '';
    let paragraph = [];
    let lists = null; // stack of {type, indent}
    const flushParagraph = () => {
      if (paragraph.length) {
        html += `<p>${inline(paragraph.join(' '))}</p>`;
      }
      paragraph = [];
    };
    const closeLists = (toIndent = -1) => {
      while (lists && lists.length && lists[lists.length - 1].indent > toIndent) {
        html += `</li></${lists.pop().type}>`;
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
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) {
          body.push(lines[i]);
        }
        html += `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushParagraph();
        closeLists();
        const body = [];
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
            html += `</li></${lists.pop().type}>`;
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
