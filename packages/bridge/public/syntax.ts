// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Syntax highlighting for the local page's diff. Each hunk's old side
 * (context and removed lines) and new side (context and added lines) is
 * highlighted as one piece of code, so a token that runs over several lines
 * (a template string, a block comment) is coloured right. The result is then
 * cut back into lines, closing the open spans at each line end and opening
 * them again on the next line.
 *
 * Big files are left plain, so a huge diff stays quick. No DOM here, so node
 * can test it.
 */

export const LIMITS = { fileLines: 3000, lineLength: 1000, pageLines: 20000 };

const BY_EXT = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  ru: 'ruby',
  erb: 'erb',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
};
const BY_NAME = {
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  Guardfile: 'ruby',
  Podfile: 'ruby',
  Brewfile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
};

/** The highlight.js language for a path, by its extension (or a few well-known names), or null. */
export function langOf(rel) {
  const name = String(rel).split('/').pop();
  if (BY_NAME[name]) {
    return BY_NAME[name];
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXT[name.slice(dot + 1).toLowerCase()] || null : null;
}

/** Cuts highlighted HTML (text plus <span class="…"> and </span> only) into lines, each with balanced spans. */
export function splitHtmlLines(html) {
  const lines = [];
  const open = [];
  let cur = '';
  let last = 0;
  const pattern = /(<span class="[^"]*">)|(<\/span>)|(\n)/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    cur += html.slice(last, match.index);
    last = pattern.lastIndex;
    if (match[1]) {
      open.push(match[1]);
      cur += match[1];
    } else if (match[2]) {
      open.pop();
      cur += match[2];
    } else {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    }
  }
  lines.push(cur + html.slice(last));
  return lines;
}

/**
 * One hunk: the highlighted HTML for each of hunk.lines (same index), or null for a line it doesn't cover
 * (the "\ No newline at end of file" marker). Context lines take the new side's colouring.
 * @param {{lines: string[]}} hunk
 * @param {(code: string) => string} highlight returns escaped, highlighted HTML
 */
export function hunkHtml(hunk, highlight) {
  const sides = { old: { idx: [], text: [] }, new: { idx: [], text: [] } };
  hunk.lines.forEach((line, i) => {
    const sign = line[0];
    if (sign === ' ' || sign === '-') {
      sides.old.idx.push(i);
      sides.old.text.push(line.slice(1));
    }
    if (sign === ' ' || sign === '+') {
      sides.new.idx.push(i);
      sides.new.text.push(line.slice(1));
    }
  });
  const out = new Array(hunk.lines.length).fill(null);
  for (const key of ['new', 'old']) {
    const sideLines = sides[key];
    if (!sideLines.idx.length) {
      continue;
    }
    const html = splitHtmlLines(highlight(sideLines.text.join('\n')));
    sideLines.idx.forEach((i, k) => {
      if (out[i] === null) {
        out[i] = html[k] ?? null;
      }
    });
  }
  return out;
}

/**
 * A file's hunks highlighted: an array (one per hunk) of arrays (one per line), or null to draw it plain:
 * no known language, too big, a very long (minified) line, or highlight.js not loaded.
 * @param {{rel: string, hunks: Array<{lines: string[]}>}} file
 * @param {object|null} hljs highlight.js
 */
export function highlightFile(file, hljs) {
  const lang = langOf(file.rel);
  if (!hljs || !lang || !hljs.getLanguage(lang)) {
    return null;
  }
  let count = 0;
  for (const hunk of file.hunks) {
    count += hunk.lines.length;
    if (count > LIMITS.fileLines || hunk.lines.some((line) => line.length > LIMITS.lineLength)) {
      return null;
    }
  }
  try {
    return file.hunks.map((hunk) =>
      hunkHtml(
        hunk,
        (code) => hljs.highlight(code, { language: lang, ignoreIllegals: true }).value,
      ),
    );
  } catch {
    return null;
  }
}
