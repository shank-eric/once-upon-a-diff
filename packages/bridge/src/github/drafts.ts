/**
 * What's become of each drafted comment: posted on GitHub, waiting in the
 * reviewer's pending review, dismissed by them, or still a draft.
 *
 * Posted and pending come from read-only `gh api` GETs (as the logged-in gh
 * user, with GITHUB_TOKEN unset when config.json asks for it), cached for
 * 60s:
 *   repos/{o}/{r}/pulls/{n}/comments                 posted review comments
 *   repos/{o}/{r}/pulls/{n}/reviews                  reviews (a PENDING one is their unsubmitted review)
 *   repos/{o}/{r}/pulls/{n}/reviews/{id}/comments    that pending review's comments
 *   repos/{o}/{r}/issues/{n}/comments                general PR comments
 * A draft matches a comment of theirs on the same file within 3 lines (or a
 * general draft a general comment) whose text is at least 0.75 similar, since
 * a draft is often edited before it's posted.
 *
 * "Dismiss" / "Restore" is the reviewer's call, kept by
 * the bridge in <home>/state/<key>/drafts.json, where the key is the PR (so a
 * re-rendered or regenerated story keeps them) or the local story's id.
 * Dismissals match by path, line and text too, so a regenerated story doesn't
 * suggest the same comment again. Nothing is ever written to GitHub here.
 *
 * "Add to my review" (review.ts, the one write to GitHub) leaves an `added`
 * mark here too: GitHub doesn't redraw an open Files changed page for it, so
 * the panel shows the draft as added until a reload, a match from gh or the
 * page itself confirms it. A confirmed mark is dropped ("settle").
 */
import { createHash } from 'node:crypto';
import { runGh } from '../util/gh.ts';
import { prKey } from '@once-upon-a-diff/shared/util/github-paths';
import { readJson, writeJson } from '../util/json-file.ts';
import { noteState } from '../inbox/fixes.ts';
import { stateFile } from '../config/settings.ts';
import type { Chapter, DraftRow, LocalNote, StoryData } from '@once-upon-a-diff/shared/types';
import type { StoryStore } from '../stories/store.ts';
import type { StoryMeta } from '../types.ts';

/** A drafted comment, or a comment on GitHub, as the matching reads it. */
export interface CommentLike {
  path?: string | null;
  line?: number | string | null;
  original_line?: number | null;
  body?: string | null;
}

/** One of the gh user's comments on a PR. */
export interface GithubComment {
  state: 'posted' | 'pending';
  path: string | null;
  line: number;
  body: string;
  url: string | null;
}

/** What `gh api` gives back for a comment or a review: just what's read here. */
interface GhItem {
  id?: number;
  user?: { login?: string } | null;
  state?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  html_url?: string;
}

/** A dismissal (or an Add to my review) the bridge keeps for a draft. */
export interface MarkEntry {
  path: string;
  line: number;
  body: string;
  at: string;
  side?: 'L' | 'R';
  url?: string | null;
  started?: boolean;
}

/** drafts.json: the reviewer's own calls on the story's drafts. */
export interface DraftMarks {
  dismissed: MarkEntry[];
  added: MarkEntry[];
}

const TTL_MS = 60000;
const LINE_SLACK = 3;
export const SIMILAR = 0.75; // drafts get edited before posting: a lightly reworded real one scored 0.80 against its draft

export const stateKeyOf = (id: string, meta: StoryMeta | null | undefined): string =>
  meta && meta.kind === 'github' && meta.repo && meta.number
    ? `pr-${meta.repo.replace('/', '-')}-${meta.number}`.toLowerCase()
    : id;
export const draftKey = (comment: CommentLike): string =>
  createHash('sha1')
    .update(`${comment.path || ''}\n${Number(comment.line) || 0}\n${normalize(comment.body)}`)
    .digest('hex')
    .slice(0, 12);

export function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, ' ')
    .replace(/[`*_>#~[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** 0..1: Dice similarity of character trigrams, or 1 when one text contains the other. */
export function similarity(first: unknown, second: unknown): number {
  const left = normalize(first);
  const right = normalize(second);
  if (!left || !right) {
    return 0;
  }
  if (
    left === right ||
    (left.length > 20 && right.includes(left)) ||
    (right.length > 20 && left.includes(right))
  ) {
    return 1;
  }
  const grams = (text: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < text.length - 2; i++) {
      const gram = text.slice(i, i + 3);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let both = 0;
  for (const [gram, count] of leftGrams) {
    both += Math.min(count, rightGrams.get(gram) || 0);
  }
  const total =
    [...leftGrams.values()].reduce((sum, count) => sum + count, 0) +
    [...rightGrams.values()].reduce((sum, count) => sum + count, 0);
  return total ? (2 * both) / total : 0;
}

const isGeneral = (comment: CommentLike) =>
  !Number(comment.line) || /^\(/.test(comment.path || '') || !comment.path;
const samePath = (draft: string, posted: string) =>
  draft === posted || posted.endsWith('/' + draft) || draft.endsWith('/' + posted);
/** The best match for a draft among comments [{path, line, body, ...}], or null. */
export function bestMatch<C extends CommentLike>(
  draft: CommentLike,
  comments: C[],
): (C & { score: number }) | null {
  let best: (C & { score: number }) | null = null;
  for (const posted of comments) {
    if (isGeneral(draft) !== !posted.path) {
      continue;
    }
    if (posted.path) {
      if (!samePath(draft.path as string, posted.path)) {
        continue;
      }
      const line = Number(posted.line || posted.original_line || 0);
      if (line && Math.abs(line - Number(draft.line)) > LINE_SLACK) {
        continue;
      }
    }
    const score = similarity(draft.body, posted.body);
    if (score >= SIMILAR && (!best || score > best.score)) {
      best = { ...posted, score };
    }
  }
  return best;
}

function ghApi(args: string[]): Promise<string> {
  return runGh(['api', ...args]);
}
const ghJson = async (args: string[]): Promise<GhItem[]> => {
  const out = await ghApi(args);
  // --paginate prints one JSON array per page
  return JSON.parse(`[${out.trim().replace(/\]\s*\[/g, '],[')}]`).flat();
};

let login: string | null = null;
const cache = new Map<
  string,
  { at: number; value: { login: string; comments: GithubComment[] } }
>();
/** The gh user's comments on a PR: [{state: 'posted'|'pending', path, line, body, url}], cached 60s. */
export async function githubComments(
  repo: string,
  number: number | string,
): Promise<{ login: string; comments: GithubComment[] }> {
  const key = prKey(repo, number);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  if (!login) {
    login = JSON.parse(await ghApi(['user'])).login;
  }
  const base = `repos/${repo}/pulls/${Number(number)}`;
  const [reviewComments, reviews, issueComments] = await Promise.all([
    ghJson([`${base}/comments?per_page=100`, '--paginate']),
    ghJson([`${base}/reviews?per_page=100`, '--paginate']),
    ghJson([`repos/${repo}/issues/${Number(number)}/comments?per_page=100`, '--paginate']),
  ]);
  const mine = (item: GhItem) => item && item.user && item.user.login === login;
  const out: GithubComment[] = [];
  for (const comment of reviewComments.filter(mine)) {
    out.push({
      state: 'posted',
      path: comment.path as string,
      line: comment.line || comment.original_line || 0,
      body: comment.body as string,
      url: comment.html_url as string,
    });
  }
  for (const comment of issueComments.filter(mine)) {
    out.push({
      state: 'posted',
      path: null,
      line: 0,
      body: comment.body as string,
      url: comment.html_url as string,
    });
  }
  for (const review of reviews.filter(mine)) {
    if (review.state === 'PENDING') {
      const pending = await ghJson([
        `${base}/reviews/${review.id}/comments?per_page=100`,
        '--paginate',
      ]);
      for (const comment of pending) {
        out.push({
          state: 'pending',
          path: comment.path as string,
          line: comment.line || comment.original_line || 0,
          body: comment.body as string,
          url: review.html_url || null,
        });
      }
      if (review.body) {
        out.push({
          state: 'pending',
          path: null,
          line: 0,
          body: review.body,
          url: review.html_url || null,
        });
      }
    } else if (review.body) {
      out.push({
        state: 'posted',
        path: null,
        line: 0,
        body: review.body,
        url: review.html_url as string,
      });
    }
  }
  const value = { login: login as string, comments: out };
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearCache = () => {
  cache.clear();
  login = null;
};
/** Drop one PR's cached comments, e.g. right after adding one to the pending review. */
export const forgetComments = (repo: string, number: number | string): void => {
  cache.delete(prKey(repo, number));
};

// ---------- the reviewer's own calls, kept by the bridge
const file = (home: string, key: string) => stateFile(home, key, 'drafts.json');
const EMPTY = (): DraftMarks => ({ dismissed: [], added: [] });
export function readMarks(home: string, key: string): DraftMarks {
  return { ...EMPTY(), ...readJson<Partial<DraftMarks>>(file(home, key), {}) };
}
function writeMarks(home: string, key: string, marks: DraftMarks): void {
  writeJson(file(home, key), marks);
}

const entryOf = (draft: CommentLike): MarkEntry => ({
  path: draft.path || '',
  line: Number(draft.line) || 0,
  body: String(draft.body || ''),
  at: new Date().toISOString(),
});
const sameAs = (entry: CommentLike) => (e: CommentLike) =>
  bestMatch(entry, [{ ...e, path: isGeneral(e) ? null : e.path }]) !== null;

/** action: dismiss | restore | settle (drop an `added` mark once it's confirmed), for one draft {path, line, body}. */
export function mark(home: string, key: string, action: string, draft: CommentLike): DraftMarks {
  const marks = readMarks(home, key);
  const entry = entryOf(draft);
  const same = sameAs(entry);
  const drop = (list: MarkEntry[]) => list.filter((e) => !same(e));
  if (action === 'dismiss') {
    marks.dismissed = [...drop(marks.dismissed), entry];
  } else if (action === 'restore') {
    marks.dismissed = drop(marks.dismissed);
  } else if (action === 'settle') {
    marks.added = drop(marks.added);
  } else {
    throw Object.assign(new Error('action must be dismiss, restore or settle'), {
      status: 400,
    });
  }
  writeMarks(home, key, marks);
  return marks;
}

/** The `added` mark for a draft, if Add to my review already put it in their pending review. */
export const addedMark = (marks: DraftMarks, draft: CommentLike): MarkEntry | null =>
  (marks.added || []).find(sameAs(entryOf(draft))) || null;

/** Add to my review worked: remember it until the page, or gh after a reload, shows it. */
export function noteAdded(
  home: string,
  key: string,
  draft: CommentLike & { side?: string },
  added: { url?: string | null; started?: boolean } = {},
): MarkEntry {
  const marks = readMarks(home, key);
  const entry: MarkEntry = {
    ...entryOf(draft),
    side: draft.side === 'L' ? 'L' : 'R',
    url: added.url || null,
    started: !!added.started,
  };
  marks.added = [...marks.added.filter((e) => !sameAs(entry)(e)), entry];
  writeMarks(home, key, marks);
  return entry;
}

/**
 * Status of every draft in the story's chapters:
 * [{chapter, index, key, status: 'draft'|'posted'|'pending', dismissed, source, url, score, added, fix}]
 * added is {at, url, started} while an Add to my review is waiting to show on the page, else null.
 * fix is {id, done, path, side, line}, the fix-before-push note a local story's draft became, else null.
 */
export function draftStatus(
  chapters: Pick<Chapter, 'comments'>[],
  marks: DraftMarks,
  github: { comments: GithubComment[] } | null = null,
  notes: LocalNote[] | null = null,
): DraftRow[] {
  const asPosted = (list: MarkEntry[]) =>
    list.map((e) => ({ ...e, path: isGeneral(e) ? null : e.path }));
  const out: DraftRow[] = [];
  chapters.forEach((chapter, chapterIndex) =>
    (chapter.comments || []).forEach((comment, i) => {
      const draft = {
        path: comment.path || '',
        line: Number(comment.line) || 0,
        body: comment.body || '',
      };
      const add = bestMatch(draft, asPosted(marks.added || []));
      const row: DraftRow = {
        chapter: chapterIndex + 1,
        index: i,
        key: draftKey(draft),
        status: 'draft',
        dismissed: !!bestMatch(draft, asPosted(marks.dismissed)),
        source: null,
        url: null,
        score: null,
      };
      row.added = add ? { at: add.at, url: add.url || null, started: !!add.started } : null;
      // a draft that Add to fix before push made into a note, and how far that note has got (../inbox/fixes.ts)
      const note = notes ? notes.find((note) => note.draft === row.key) : null;
      row.fix = note
        ? {
            id: note.id,
            done: !!note.done,
            path: note.path,
            side: note.side,
            line: note.line,
            state: noteState(note),
            sent_to: note.sent ? note.sent.to : null,
            sha: note.fixed ? note.fixed.sha : null,
          }
        : null;
      const auto = github ? bestMatch(draft, github.comments) : null;
      if (auto) {
        Object.assign(row, {
          status: auto.state,
          source: 'github',
          url: auto.url,
          score: Math.round(auto.score * 100) / 100,
        });
      }
      out.push(row);
    }),
  );
  return out;
}

/**
 * Every draft's state for one story, as the panel's Draft comments and
 * `once-upon drafts` both show it: the reviewer's marks, what gh finds on
 * the PR, and the fix-before-push notes its drafts became.
 * A gh failure comes back as `error` with the rest still filled in.
 */
export async function draftsOf(home: string, stories: StoryStore, id: string, meta: StoryMeta) {
  const { chapters } = stories.load(id) as StoryData; // the story's routes found it first
  let github: { login: string; comments: GithubComment[] } | null = null;
  let error: string | null = null;
  if (meta.kind === 'github' && meta.repo && meta.number) {
    try {
      github = await githubComments(meta.repo, meta.number);
    } catch (e) {
      error = `couldn't read the PR's comments with gh: ${(e as Error).message}`;
    }
  }
  const notes = stories.readState<LocalNote[]>(id, 'notes.json', []);
  return {
    chapters,
    rows: draftStatus(chapters, readMarks(home, stateKeyOf(id, meta)), github, notes),
    login: github ? github.login : null,
    error,
  };
}
