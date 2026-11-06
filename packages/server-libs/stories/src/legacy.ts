/*
 * Older stories, read in the new shape. A story told before chapters carried `refs` pointed at files and lines by text:
 * `lines` ranges on file entries, and backticked `path:45`, `:45` or `name.ts` and diff links in the narrative, resolved by
 * path suffix and "the file named just before". upgradePlan reads such a plan as a new one, in memory (nothing on disk is
 * rewritten): each `lines` range and each text reference becomes a ref, each resolved mention in the text becomes a
 * `[text](ref:<id>)` link, a file the text pointed at lines of without listing joins as a partial entry (so where a file
 * is finished does not move), a chapter with no key gets the one the panel always derived from its title (so what the
 * reviewer read stays read), and a comment's path suffix becomes the full path.
 *
 * Only the chapters with no `refs` list are upgraded; a plan told now is returned as it is.
 */
import { chapterKeyOf } from '@once-upon-a-diff/terms/chapters';
import { parseDiffLink, parseLineRef, toSide } from '@once-upon-a-diff/terms/line-refs';
import type { LineRef } from '@once-upon-a-diff/terms/line-refs';
import { pathSha, relOfPath } from './diff.ts';
import { findIn, mayBeFile } from './text-refs.ts';
import type { Plan, PlanChapter, PlanFile, PlanRef } from './chapters.ts';
import { baseName } from '@once-upon-a-diff/terms/text';

export const REF_NOTE = 'its lines are pointed at in the text';
const REF_LABEL = 'pointed at in the text';
const TEXT_FIELDS = ['headline', 'scenario', 'summary', 'narrative'] as const;

const relOfEntry = (entry: PlanFile) => (typeof entry === 'string' ? entry : entry.rel);

function upgradeChapter(chapter: PlanChapter, rels: string[]): PlanChapter {
  const files = chapter.files || [];
  const listed = files.map(relOfEntry);
  const bySha = new Map(rels.map((rel) => [pathSha(rel), rel]));
  const refs: PlanRef[] = [];
  const ids = new Map<string, string>();
  const extra: PlanFile[] = [];
  let lineCount = 0;
  let textCount = 0;

  const upgraded: PlanFile[] = files.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    const { lines, ...rest } = entry;
    for (const range of lines || []) {
      const start = +range.start;
      const end = +(range.end || range.start);
      refs.push({
        id: `l${++lineCount}`,
        path: entry.rel,
        side: toSide(range.side),
        start,
        end,
        ...(range.label ? { label: range.label } : {}),
      });
    }
    return rest;
  });

  // a name is a file when it is one of the chapter's (exact path, else a path suffix), or (with lines) any file of the story
  const pick = (found: string | string[], last: string | null) => {
    if (typeof found === 'string') {
      return found;
    }
    if (found.length === 1) {
      return found[0];
    }
    return last && found.includes(last) ? last : null;
  };
  const resolve = (name: string, last: string | null, withLine: boolean) => {
    if (!mayBeFile(name)) {
      return null;
    }
    const own = findIn(name, listed);
    if (typeof own === 'string' || own.length) {
      return pick(own, last);
    }
    return withLine && !chapter.since ? pick(findIn(name, rels), last) : null;
  };
  /** The id of the ref for rel at line (null: the file), made on first use. */
  const refFor = (rel: string, line: LineRef | null): string => {
    const key = `${rel}|${line ? `${line.side}${line.start}-${line.end}` : 'file'}`;
    const known = ids.get(key);
    if (known) {
      return known;
    }
    const id = `t${++textCount}`;
    ids.set(key, id);
    const unlisted = !listed.includes(rel);
    refs.push({
      id,
      path: rel,
      ...(line ? { side: line.side, start: line.start, end: line.end } : {}),
      ...(unlisted ? { label: REF_LABEL } : {}),
      text: true,
    });
    if (unlisted && !chapter.since && !extra.some((entry) => relOfEntry(entry) === rel)) {
      extra.push({ rel, partial: true, note: REF_NOTE, ref: true });
    }
    return id;
  };

  let last: string | null = null;
  const upgradeText = (text: string): string =>
    text
      .split(/(```[\s\S]*?```)/g) // code blocks aren't references
      .map((part, index) =>
        index % 2
          ? part
          : part.replace(
              /`([^`\n]+)`|\[[^\]]*\]\((https?:[^)\s]+)\)/g,
              (match, code: string | undefined, url: string | undefined) => {
                if (url) {
                  const link = parseDiffLink(url);
                  const rel = link && bySha.get(link.sha);
                  if (!rel) {
                    return match;
                  }
                  last = rel;
                  return link.line
                    ? match.replace(/\(https?:[^)\s]+\)$/, `(ref:${refFor(rel, link.line)})`)
                    : match;
                }
                const { name, line } = parseLineRef(code as string);
                if (!name) {
                  const rel = last || (listed.length === 1 ? listed[0] : null);
                  if (!rel || !line) {
                    return match;
                  }
                  const label = `${baseName(rel)}${code}`;
                  return `[\`${label}\`](ref:${refFor(rel, line)})`;
                }
                const rel = resolve(name, last, !!line);
                if (!rel) {
                  return match;
                }
                last = rel;
                return `[\`${code}\`](ref:${refFor(rel, line)})`;
              },
            ),
      )
      .join('');

  const out: PlanChapter = { ...chapter, key: chapterKeyOf(chapter) };
  for (const field of TEXT_FIELDS) {
    if (typeof chapter[field] === 'string' && chapter[field]) {
      out[field] = upgradeText(chapter[field]);
    }
  }
  out.files = [...upgraded, ...extra];
  out.refs = refs;
  if (Array.isArray(chapter.comments)) {
    out.comments = chapter.comments.map((comment) => {
      const rel = comment.path ? relOfPath(comment.path, rels) : null;
      return rel ? { ...comment, path: rel } : comment;
    });
  }
  return out;
}

/**
 * An older story's overview, summary and plan, whose backticked file names and lines the panel linked among every file of
 * the story: read as one chapter that lists every file, and its refs become the plan's `refs`.
 */
function upgradeOverview(plan: Plan, rels: string[]): Plan {
  const text = [plan.overview, plan.summary, plan.plan].some(
    (field) => field && field.includes('`'),
  );
  if (Array.isArray(plan.refs) || !text) {
    return plan;
  }
  const pseudo = upgradeChapter(
    {
      files: rels,
      narrative: plan.overview || '',
      summary: plan.summary || '',
      scenario: plan.plan || '',
      since: true, // so that a name is only resolved among the story's own files, and no file is added
    },
    rels,
  );
  return {
    ...plan,
    ...(plan.overview ? { overview: pseudo.narrative } : {}),
    ...(plan.summary ? { summary: pseudo.summary } : {}),
    ...(plan.plan ? { plan: pseudo.scenario } : {}),
    refs: pseudo.refs,
  };
}

/**
 * The plan with every chapter that has no `refs` list upgraded (see the top of this file), and its overview too when it
 * has no `refs`; rels are the story's files.
 */
export function upgradePlan(plan: Plan, rels: string[]): Plan {
  const upgradedOverview = upgradeOverview(plan, rels);
  if (!(plan.chapters || []).some((chapter) => !Array.isArray(chapter.refs))) {
    return upgradedOverview;
  }
  return {
    ...upgradedOverview,
    chapters: (plan.chapters || []).map((chapter) =>
      Array.isArray(chapter.refs) ? chapter : upgradeChapter(chapter, rels),
    ),
  };
}
