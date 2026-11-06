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

/** What the page uses of highlight.js. */
export interface Highlighter {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

export const LIMITS = { fileLines: 3000, lineLength: 1000, pageLines: 20000 };

const BY_EXT: Record<string, string> = {
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
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  sql: 'sql',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  less: 'less',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  mk: 'makefile',
  dockerfile: 'dockerfile',
};
const BY_NAME: Record<string, string> = {
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  Guardfile: 'ruby',
  Podfile: 'ruby',
  Brewfile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.bash_profile': 'bash',
  '.profile': 'bash',
  '.zprofile': 'bash',
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
};

/** A script's interpreter (the shebang's program, after `env` and its flags) as a highlight.js language. */
const BY_INTERPRETER: [RegExp, string][] = [
  [/^python[\d.]*$/, 'python'],
  [/^(ba|z|k|da)?sh$/, 'bash'],
  [/^ruby[\d.]*$/, 'ruby'],
  [/^(node|nodejs|deno|bun)$/, 'javascript'],
  [/^(ts-node|tsx)$/, 'typescript'],
  [/^perl[\d.]*$/, 'perl'],
  [/^php[\d.]*$/, 'php'],
];

/** The language a `#!` line names, or null: `#!/bin/bash`, `#!/usr/bin/env python3`, `#!/usr/bin/env -S node --flag`. */
export function langOfShebang(line: string): string | null {
  const match = /^#!\s*(\S+)(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  let program = match[1].split('/').pop() as string;
  if (program === 'env') {
    program = (
      match[2]
        .trim()
        .split(/\s+/)
        .find((word) => word && !word.startsWith('-')) || ''
    )
      .split('/')
      .pop() as string;
  }
  return BY_INTERPRETER.find(([pattern]) => pattern.test(program))?.[1] ?? null;
}

/** The file's first line when a hunk shows it (on the new side, else the old side for a deleted file), or null. */
function firstLineOf(
  hunks: { newStart?: number; oldStart?: number; lines: string[] }[],
): string | null {
  const top =
    hunks.find((hunk) => hunk.newStart === 1) || hunks.find((hunk) => hunk.oldStart === 1);
  if (!top) {
    return null;
  }
  const side = top.newStart === 1 ? '+ ' : '- ';
  const line = top.lines.find((one) => side.includes(one[0]));
  return line === undefined ? null : line.slice(1);
}

/**
 * The highlight.js language for a path, by its extension (or a few well-known names), or null. A file with no
 * extension (a script in bin/, say) goes by its `#!` line when `firstLine` has it.
 */
export function langOf(rel: string, firstLine: string | null = null): string | null {
  const name = String(rel).split('/').pop() as string;
  if (BY_NAME[name]) {
    return BY_NAME[name];
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    return BY_EXT[name.slice(dot + 1).toLowerCase()] || null;
  }
  return firstLine ? langOfShebang(firstLine) : null;
}

/** Cuts highlighted HTML (text plus <span class="…"> and </span> only) into lines, each with balanced spans. */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
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
 * (the "\ No newline at end of file" marker). Context lines take the new side's colouring. highlight returns
 * escaped, highlighted HTML.
 */
export function hunkHtml(
  hunk: { lines: string[] },
  highlight: (code: string) => string,
): (string | null)[] {
  const sides = {
    old: { idx: [] as number[], text: [] as string[] },
    new: { idx: [] as number[], text: [] as string[] },
  };
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
  const out: (string | null)[] = new Array(hunk.lines.length).fill(null);
  for (const key of ['new', 'old'] as const) {
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
 */
export function highlightFile(
  file: { rel: string; hunks: { newStart?: number; oldStart?: number; lines: string[] }[] },
  hljs: Highlighter | null,
): (string | null)[][] | null {
  const lang = langOf(file.rel, firstLineOf(file.hunks));
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
