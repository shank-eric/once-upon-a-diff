/*
 * Line references in a chapter's text count as the chapter telling that file.
 *
 * A file is marked viewed in the last chapter that tells it. A chapter tells a
 * file by listing it, or by pointing at its lines in its text: `path:45`,
 * `path:40-58`, `path:L12`, a bare `:45` after a file is named, or a link to
 * the file's diff with a line anchor (#diff-<sha>R45). A file a chapter points
 * at without listing it joins that chapter's files as a partial entry, with the
 * referenced lines as its `lines`, so the panel filters it in, links the
 * reference, and puts "Mark viewed" there when it's the last chapter to tell
 * it. A bare name with no line ("the tests in `a.test.ts`") doesn't count.
 *
 * "Since you read it" chapters are left alone: they show GitHub's diff of just
 * their commits, which may not have the file, and they already finish what
 * they list.
 *
 * The pr-story skill's `build` applies the same rule to file-map.json.
 */
import { pathSha } from './diff.mjs';

export const REF_NOTE = 'its lines are pointed at in the text';
const REF_LABEL = 'pointed at in the text';

/** One backticked reference: {name, line} (name '' for a bare `:45`), or null. */
function parseCode(code) {
  const t = String(code).trim().replace(/^\.\//, '');
  const m = /^(.*?):([LR])?(\d+)(?:-[LR]?(\d+))?$/.exec(t);
  if (!m) return { name: t, line: null };
  const start = +m[3];
  const end = +(m[4] || m[3]);
  return { name: m[1], line: { side: m[2] || 'R', start: Math.min(start, end), end: Math.max(start, end) } };
}

/**
 * The files a chapter's text points at lines of: [{rel, lines: [{side, start, end}]}] in order of first mention.
 * Names resolve as the panel resolves them: the chapter's own files first (exact path, then a path suffix such as
 * `Combobox/component.tsx` or a basename), then the rest of the PR's files, where a name that fits more than one is skipped.
 * @param {string} text the chapter's markdown
 * @param {string[]} listed the chapter's own files
 * @param {string[]} rels every file in the story
 */
export function lineRefsOf(text, listed, rels) {
  const bySha = new Map(rels.map(rel => [pathSha(rel), rel]));
  const find = (name, scope) => scope.find(r => r === name) || scope.filter(r => r.endsWith('/' + name));
  const resolve = name => {
    if (!name || /\s/.test(name) || !/[./]/.test(name)) return null;
    const own = find(name, listed);
    if (typeof own === 'string') return own;
    if (own.length) return own[0];
    const any = find(name, rels);
    if (typeof any === 'string') return any;
    return any.length === 1 ? any[0] : null;
  };
  const out = new Map();
  const add = (rel, line) => {
    if (!out.has(rel)) out.set(rel, []);
    const ls = out.get(rel);
    if (!ls.some(l => l.side === line.side && l.start === line.start && l.end === line.end)) ls.push(line);
  };
  let last = null;
  const src = String(text || '').replace(/```[\s\S]*?```/g, ' '); // code blocks aren't references
  const re = /`([^`\n]+)`|\[[^\]]*\]\((https?:[^)\s]+)\)/g;
  for (let m; (m = re.exec(src)); ) {
    if (m[2]) {
      const hit = /#diff-([0-9a-f]{64})(?:([LR])(\d+)(?:-[LR]?(\d+))?)?$/.exec(m[2]);
      const rel = hit && bySha.get(hit[1]);
      if (!rel) continue;
      last = rel;
      if (hit[3]) add(rel, { side: hit[2], start: +hit[3], end: +(hit[4] || hit[3]) });
      continue;
    }
    const { name, line } = parseCode(m[1]);
    if (!name) {
      const rel = last || (listed.length === 1 ? listed[0] : null);
      if (rel && line) add(rel, line);
      continue;
    }
    const rel = resolve(name);
    if (!rel) continue;
    last = rel;
    if (line) add(rel, line);
  }
  return [...out].map(([rel, lines]) => ({ rel, lines }));
}

/** The text of a chapter the panel draws as markdown. */
const textOf = ch => [ch.headline, ch.scenario, ch.summary, ch.narrative].filter(Boolean).join('\n\n');

/**
 * Adds, to each chapter (but "Since you read it" ones), the files its text points at lines of and doesn't list.
 * Changes the chapters in place and returns them. Entries are entryOf()'s shape plus `ref: true`.
 */
export function addTextRefs(chapters, rels) {
  for (const ch of chapters) {
    if (ch.since) continue;
    const listed = ch.files.map(f => f.rel);
    for (const { rel, lines } of lineRefsOf(textOf(ch), listed, rels)) {
      if (listed.includes(rel)) continue;
      ch.files.push({ rel, partial: true, note: REF_NOTE, ref: true, lines: lines.map(l => ({ ...l, label: REF_LABEL })) });
    }
  }
  return chapters;
}
