/*
 * Markup built as strings: escaping, and the html`` tag that escapes every
 * value it's given unless it's markup already. Used by the panel, the content
 * scripts, the local page and the bridge's server, so it has no DOM or Node
 * dependencies. It also holds the markdown renderer (createMarkdown, below), which turns a story's or an
 * answer's text into this markup.
 */

/** Escapes &, <, >, " and ' so the text is safe in element content and in a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The reverse of escapeHtml, for text that was escaped before a pass that needs the raw characters. */
export function unescapeHtml(value: unknown): string {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Markup that html`` puts in as is: what html`` returns, and what raw() marks. It turns into its markup wherever a
 * string is wanted (String(), a plain template literal, +), so string-built markup can take it too.
 */
export class Html {
  declare markup: string;
  constructor(markup: string) {
    this.markup = markup;
  }
  toString(): string {
    return this.markup;
  }
}

/** What a ${value} in html`` can be: anything else would print as text you didn't mean (an object as [object Object]). */
export type HtmlValue = Html | string | number | boolean | null | undefined | readonly HtmlValue[];

/** Marks markup our own code built as a string (the markdown renderer's, a regex pass's) as safe to put in as is. */
export function raw(markup: unknown): Html {
  return markup instanceof Html ? markup : new Html(String(markup ?? ''));
}

/** One ${value}: markup as is, an array's items one after another, nothing for null, undefined or false, else escaped text. */
function interpolate(value: HtmlValue): string {
  if (value instanceof Html) {
    return value.markup;
  }
  if (Array.isArray(value)) {
    return value.map(interpolate).join('');
  }
  if (value === null || value === undefined || value === false) {
    return '';
  }
  return escapeHtml(value);
}

/**
 * A tagged template for markup: every ${value} is escaped, so text from a story, a PR or a person can't add
 * elements or attributes. html`` results and raw() go in as is, arrays are joined, and null, undefined and false
 * give nothing (so ${cond && html`...`} works). Attribute values go in quotes.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let markup = strings[0];
  for (let i = 0; i < values.length; i++) {
    markup += interpolate(values[i]) + strings[i + 1];
  }
  return new Html(markup);
}

/*
 * A tiny markdown renderer for a story's or an answer's text: escape first, then a block
 * pass (code fences, quotes, headings, lists, paragraphs) and an inline pass
 * (code, bold, italics, links: http(s) or relative only, built with html``
 * so the href is escaped once, and never one with a code span inside its URL).
 * A host that has links of its own (the panel's jump links to the PR's files) passes `link`, which is asked about each
 * `[text](url)` first. It works on strings, so html``
 * isn't used inside; what it returns is raw() markup for html`` to take.
 */

/**
 * A host's own handling of a link: `url` is as written (escaped markup, like `text`) and `text` is the link's words with their
 * emphasis done. Answer the markup to use in the link's place (the words themselves when the link points at nothing the host
 * knows), or null when it is not one of the host's links and the safe-href rule should decide.
 */
export type MarkdownLink = (url: string, text: string) => string | null;

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
  return String(html`<a href="${href}" target="_blank" rel="noopener noreferrer">${raw(text)}</a>`);
}

/** Bold and italics, on text that's escaped already. */
const emphasis = (text: string): string =>
  text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');

export function createMarkdown({ link: hostLink }: { link?: MarkdownLink } = {}) {
  function inline(source: string): Html {
    const codes: string[] = [];
    let html = escapeHtml(source).replace(
      /`([^`]+)`/g,
      (match, code: string) => `\u0000${codes.push(code) - 1}\u0000`,
    );
    // links first, each kept aside whole, so the emphasis pass can't reach into a URL
    const links: string[] = [];
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
      // a link the host owns (a jump to a file of the PR), else a safe web link
      const markup = hostLink?.(url, emphasis(text)) ?? linkHtml(emphasis(text), url);
      return markup === null ? match : `\u0002${links.push(markup) - 1}\u0002`;
    });
    html = emphasis(html).replace(
      LINK_MARK,
      (match, indexText: string) => links[Number(indexText)],
    );
    html = html.replace(CODE_MARK, (match, indexText: string) => {
      const index = Number(indexText);
      return `<code>${codes[index]}</code>`;
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
