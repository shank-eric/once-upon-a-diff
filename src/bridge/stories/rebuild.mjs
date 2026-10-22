/*
 * Rebuilding a story the reviewer already has: the panel's "Rebuild story"
 * (mode 'rebuild', the whole story re-told on the current diff) and "Rebuild
 * from here" (mode 'rebuild_from' with from_step N: chapters 1..N-1 stay
 * exactly as published, N and later are re-told).
 *
 * The story keeps its id and URL. When the new chapters.json is published
 * (`once-upon publish` for a PR, `once-upon local --chapters` for a local
 * story) while a rebuild request is pending:
 *   - rebuildProblems() refuses it when a kept chapter changed, a file of the
 *     diff has no chapter, or a hunk isn't covered (the whole story's coverage,
 *     not only the re-told part)
 *   - carryDrafts() keeps every drafted comment of the re-told chapters the new
 *     ones dropped: a draft whose line is still in the diff moves to the chapter
 *     that now tells that line or file (`carried`), and one whose line isn't is
 *     kept and flagged (`unmapped`), so nothing is dropped silently
 *   - questionMoves() points each question asked on a re-told chapter at the
 *     chapter that now tells its file (or the Overview), and retireReads() sets
 *     aside a read of a chapter whose files changed in the rebuild
 */
import { chaptersOf, entryOf } from './chapters.mjs';
import { readReads, retireReads } from './reads.mjs';
import { chapterKeyOf } from '../../shared/panel/story-model.js';
import { Inbox } from '../inbox/inbox.mjs';
import { moveQuestions } from '../inbox/conversation.mjs';
import { addTextRefs } from './text-refs.mjs';
import { uncoveredHunks, sidesOf } from './hunk-coverage.mjs';

export const REBUILD_MODES = ['rebuild', 'rebuild_from'];
export const isRebuild = (build) => !!build && REBUILD_MODES.includes(build.mode);

/** The first step a rebuild re-tells: from_step for rebuild_from, 1 for a whole rebuild. */
export const firstRetold = (build) =>
  build && build.mode === 'rebuild_from' && Number(build.from_step) > 1
    ? Number(build.from_step)
    : 1;

/** JSON with sorted keys, so two chapters compare by content whatever order their keys were written in. */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The kept chapters (1..from-1) that the new plan changed or lost: problem lines. */
function keptChapterProblems(before, after, from) {
  const problems = [];
  const old = (before.chapters || []).slice(0, from - 1);
  const now = after.chapters || [];
  old.forEach((chapter, i) => {
    if (!now[i]) {
      problems.push(`chapter ${i + 1} is gone; chapters 1-${from - 1} must stay as published`);
    } else if (canonical(chapter) !== canonical(now[i])) {
      problems.push(
        `chapter ${i + 1} ("${chapter.title || ''}") changed; chapters 1-${from - 1} must stay exactly as published (copy them from the published chapters.json)`,
      );
    }
  });
  if (now.length < from) {
    problems.push(
      `there's no chapter ${from}: a rebuild from chapter ${from} re-tells it and what follows`,
    );
  }
  return problems;
}

/** Placement and hunk coverage over the whole story: problem lines. */
function coverageProblems(after, diff, { allowUncovered = false } = {}) {
  const rels = [...diff.keys()];
  const chapters = addTextRefs(chaptersOf(after), rels);
  const problems = [];
  const placed = new Set();
  chapters.forEach((chapter, i) => {
    for (const entry of chapter.files) {
      if (!diff.has(entry.rel)) {
        problems.push(`chapter ${i + 1} names ${entry.rel}, which is not in the diff`);
      } else {
        placed.add(entry.rel);
      }
    }
  });
  const missing = rels.filter((rel) => !placed.has(rel));
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  const uncovered = allowUncovered ? [] : uncoveredHunks(chapters, diff);
  if (uncovered.length) {
    const refs = uncovered.flatMap((file) => file.hunks.map((hunk) => hunk.ref));
    problems.push(`hunks not covered: ${refs.join(', ')} (--allow-uncovered publishes anyway)`);
  }
  return problems;
}

/**
 * Why a rebuild can't be published as it is: [] when it can.
 * @param {object} build the pending request ({mode, from_step})
 * @param {object} before chapters.json as published before the rebuild
 * @param {object} after the new chapters.json
 * @param {Map<string, import('../util/diff.mjs').DiffFile>} diff the diff the story tells now
 */
export function rebuildProblems(build, before, after, diff, { allowUncovered = false } = {}) {
  const from = firstRetold(build);
  return [
    ...(from > 1 ? keptChapterProblems(before, after, from) : []),
    ...coverageProblems(after, diff, { allowUncovered }),
  ];
}

const isGeneral = (comment) => !(Number(comment.line) > 0) || /^\(/.test(comment.path || '');
const commentId = (comment) =>
  `${comment.path || ''}\n${Number(comment.line) || 0}\n${String(comment.body || '').trim()}`;

/** The diff file a comment's path names: exact, else the one file it's a suffix of. */
function relOf(name, rels) {
  const wanted = String(name || '').replace(/^\.\//, '');
  if (rels.includes(wanted)) {
    return wanted;
  }
  const hits = rels.filter((rel) => rel.endsWith('/' + wanted));
  return hits.length === 1 ? hits[0] : null;
}

/** Is the comment's line inside one of the file's hunks (context included), on its side? */
function onDiffLine(file, comment) {
  const side = comment.side === 'L' ? 'L' : 'R';
  const line = Number(comment.line);
  return file.hunks.some((hunk) => {
    const range = sidesOf(hunk)[side];
    return line >= range.start && line <= range.end;
  });
}

/** The re-told chapter a comment belongs in now: index into after.chapters. */
function homeOf(after, from, oldKey, rel, comment) {
  const retold = after.chapters.map((chapter, index) => ({ chapter, index })).slice(from - 1);
  const entriesOf = ({ chapter }) => (chapter.files || []).map(entryOf);
  const lists = (candidate) => !!rel && entriesOf(candidate).some((entry) => entry.rel === rel);
  const sameKey = retold.find(({ chapter }) => chapterKeyOf(chapter) === oldKey);
  if (sameKey && (!rel || lists(sameKey))) {
    return sameKey.index;
  }
  if (rel && !isGeneral(comment)) {
    const line = Number(comment.line);
    const side = comment.side === 'L' ? 'L' : 'R';
    const byLines = retold.find((candidate) =>
      entriesOf(candidate).some(
        (entry) =>
          entry.rel === rel &&
          (entry.lines || []).some(
            (range) => range.side === side && line >= range.start && line <= range.end,
          ),
      ),
    );
    if (byLines) {
      return byLines.index;
    }
  }
  const listing = retold.find(lists);
  if (listing) {
    return listing.index;
  }
  return (sameKey || retold[0]).index;
}

/**
 * Keeps the drafts of the re-told chapters (from `from` on) that the new chapters dropped. Changes `after` in place.
 * A general draft, or a line draft whose line is still in the diff, is `carried` to the chapter that tells it now;
 * a line draft whose file or line has left the diff is kept too, `unmapped`, for the reviewer to check.
 * @returns {{carried: number, unmapped: number}}
 */
export function carryDrafts(before, after, diff, from = 1) {
  const rels = [...diff.keys()];
  const present = new Set(
    (after.chapters || []).flatMap((chapter) => (chapter.comments || []).map(commentId)),
  );
  const counts = { carried: 0, unmapped: 0 };
  if (!(after.chapters || []).length || after.chapters.length < from) {
    return counts;
  }
  for (const chapter of (before.chapters || []).slice(from - 1)) {
    for (const comment of chapter.comments || []) {
      const id = commentId(comment);
      if (present.has(id)) {
        continue;
      }
      present.add(id);
      const rel = isGeneral(comment) ? null : relOf(comment.path, rels);
      const maps = isGeneral(comment) || (!!rel && onDiffLine(diff.get(rel), comment));
      const target = after.chapters[homeOf(after, from, chapterKeyOf(chapter), rel, comment)];
      target.comments = Array.isArray(target.comments) ? target.comments : [];
      const { carried, unmapped, ...draft } = comment;
      target.comments.push({ ...draft, ...(maps ? { carried: true } : { unmapped: true }) });
      counts[maps ? 'carried' : 'unmapped'] += 1;
    }
  }
  return counts;
}

/**
 * Where each question asked on a re-told chapter shows now: {<question id>: step}, 0 for the Overview (which shows
 * every question). The chapter with the same key while it still lists the question's file, else the first re-told
 * one that does, else the one with the same key.
 * @param {{id: string, step: number|null, file: string|null}[]} questions the story's questions
 */
export function questionMoves(questions, before, after, from = 1) {
  const moves = {};
  const rels = (chapter) => (chapter.files || []).map((entry) => entryOf(entry).rel);
  const now = (after.chapters || []).map((chapter, index) => ({ chapter, step: index + 1 }));
  for (const question of questions) {
    const step = Number(question.step);
    if (!(step >= from)) {
      continue;
    }
    const old = (before.chapters || [])[step - 1];
    const sameKey = old && now.find(({ chapter }) => chapterKeyOf(chapter) === chapterKeyOf(old));
    const tellsFile = ({ chapter }) =>
      rels(chapter).some(
        (rel) => rel === question.file || String(question.file).endsWith('/' + rel),
      );
    const file = question.file ? now.slice(from - 1).find(tellsFile) : null;
    // the same chapter while it still tells the question's file, else the one that does
    const keep = sameKey && (!question.file || tellsFile(sameKey)) ? sameKey : null;
    const target = (keep || file || sameKey || { step: 0 }).step;
    if (target !== step) {
      moves[question.id] = target;
    }
  }
  return moves;
}

/**
 * The read records to set aside: the keys of chapters the rebuild re-told with a different set of files. A chapter
 * kept as it was, or re-told over the same files, keeps its read.
 */
export function readsToRetire(reads, before, after) {
  const filesOf = (chapter) =>
    (chapter.files || [])
      .map((entry) => entryOf(entry).rel)
      .sort()
      .join('\n');
  const old = new Map((before.chapters || []).map((chapter) => [chapterKeyOf(chapter), chapter]));
  return (after.chapters || [])
    .filter((chapter) => {
      const key = chapterKeyOf(chapter);
      return reads[key] && (!old.has(key) || filesOf(old.get(key)) !== filesOf(chapter));
    })
    .map(chapterKeyOf);
}

/** One line on what a rebuild kept, for the request's note and the panel. */
export function rebuildNote(build, { carried = 0, unmapped = 0, moved = 0, retired = 0 } = {}) {
  const from = firstRetold(build);
  const what = from > 1 ? `Re-told from chapter ${from}` : 'Re-told the whole story';
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [
    carried ? `kept ${plural(carried, 'draft')}` : '',
    unmapped ? `flagged ${plural(unmapped, 'draft')} whose line left the diff` : '',
    moved ? `moved ${plural(moved, 'question')}` : '',
    retired ? `${plural(retired, 'chapter')} to read again` : '',
  ].filter(Boolean);
  return parts.length ? `${what}: ${parts.join(', ')}.` : `${what}.`;
}

/**
 * Before a rebuild is published: refuses it (throws, with every problem) unless it keeps what it must and tells the
 * whole diff, then carries the dropped drafts into `after`. Returns the counts for afterRebuild.
 */
export function vetRebuild(build, before, after, diff, { allowUncovered = false } = {}) {
  const problems = rebuildProblems(build, before, after, diff, { allowUncovered });
  if (problems.length) {
    throw new Error(`this rebuild can't be published:\n  - ${problems.join('\n  - ')}`);
  }
  return carryDrafts(before, after, diff, firstRetold(build));
}

/**
 * Once a rebuild is published: moves the questions asked on re-told chapters and sets aside the reads of chapters
 * re-told over other files. `stateKey` is where the story's read.json lives (stateKeyOf). Returns rebuildNote's line.
 */
export function afterRebuild(home, { id, stateKey, build, before, after, counts }) {
  const from = firstRetold(build);
  const moves = questionMoves(new Inbox(home).questions(id), before, after, from);
  moveQuestions(home, id, moves);
  const retired = retireReads(
    home,
    stateKey,
    readsToRetire(readReads(home, stateKey), before, after),
  );
  return rebuildNote(build, { ...counts, moved: Object.keys(moves).length, retired });
}
