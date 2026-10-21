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
 * "Mark posted" / "Unmark" and "Dismiss" / "Restore" are the reviewer's calls, kept by
 * the bridge in <home>/state/<key>/drafts.json, where the key is the PR (so a
 * re-rendered or regenerated story keeps them) or the local story's id.
 * Dismissals match by path, line and text too, so a regenerated story doesn't
 * suggest the same comment again. Nothing is ever written to GitHub here.
 *
 * "Add to my review" (review.mjs, the one write to GitHub) leaves an `added`
 * mark here too: GitHub doesn't redraw an open Files changed page for it, so
 * the panel shows the draft as added until a reload, a match from gh or the
 * page itself confirms it. A confirmed mark is dropped ("settle").
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runGh } from '../util/gh.mjs';
import { readJson, writeJson } from '../util/json-file.mjs';

const TTL_MS = 60000;
const LINE_SLACK = 3;
export const SIMILAR = 0.75; // drafts get edited before posting: a lightly reworded real one scored 0.80 against its draft

export const stateKeyOf = (id, meta) =>
  meta && meta.kind === 'github' && meta.repo && meta.number
    ? `pr-${meta.repo.replace('/', '-')}-${meta.number}`.toLowerCase()
    : id;
export const draftKey = (c) =>
  createHash('sha1')
    .update(`${c.path || ''}\n${Number(c.line) || 0}\n${normalize(c.body)}`)
    .digest('hex')
    .slice(0, 12);

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, ' ')
    .replace(/[`*_>#~[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** 0..1: Dice similarity of character trigrams, or 1 when one text contains the other. */
export function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) {
    return 0;
  }
  if (x === y || (x.length > 20 && y.includes(x)) || (y.length > 20 && x.includes(y))) {
    return 1;
  }
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 2; i++) {
      const g = s.slice(i, i + 3);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(x);
  const B = grams(y);
  let both = 0;
  for (const [g, n] of A) {
    both += Math.min(n, B.get(g) || 0);
  }
  const total =
    [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return total ? (2 * both) / total : 0;
}

const isGeneral = (c) => !Number(c.line) || /^\(/.test(c.path || '') || !c.path;
const samePath = (draft, posted) =>
  draft === posted || posted.endsWith('/' + draft) || draft.endsWith('/' + posted);
/** The best match for a draft among comments [{path, line, body, ...}], or null. */
export function bestMatch(draft, comments) {
  let best = null;
  for (const p of comments) {
    if (isGeneral(draft) !== !p.path) {
      continue;
    }
    if (p.path) {
      if (!samePath(draft.path, p.path)) {
        continue;
      }
      const line = Number(p.line || p.original_line || 0);
      if (line && Math.abs(line - Number(draft.line)) > LINE_SLACK) {
        continue;
      }
    }
    const score = similarity(draft.body, p.body);
    if (score >= SIMILAR && (!best || score > best.score)) {
      best = { ...p, score };
    }
  }
  return best;
}

function gh(args) {
  return runGh(['api', ...args]);
}
const ghJson = async (args) => {
  const out = await gh(args);
  // --paginate prints one JSON array per page
  return JSON.parse(`[${out.trim().replace(/\]\s*\[/g, '],[')}]`).flat();
};

let login = null;
const cache = new Map();
/** The gh user's comments on a PR: [{state: 'posted'|'pending', path, line, body, url}], cached 60s. */
export async function githubComments(repo, number) {
  const key = `${repo}#${number}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  if (!login) {
    login = JSON.parse(await gh(['user'])).login;
  }
  const base = `repos/${repo}/pulls/${Number(number)}`;
  const [reviewComments, reviews, issueComments] = await Promise.all([
    ghJson([`${base}/comments?per_page=100`, '--paginate']),
    ghJson([`${base}/reviews?per_page=100`, '--paginate']),
    ghJson([`repos/${repo}/issues/${Number(number)}/comments?per_page=100`, '--paginate']),
  ]);
  const mine = (x) => x && x.user && x.user.login === login;
  const out = [];
  for (const c of reviewComments.filter(mine)) {
    out.push({
      state: 'posted',
      path: c.path,
      line: c.line || c.original_line || 0,
      body: c.body,
      url: c.html_url,
    });
  }
  for (const c of issueComments.filter(mine)) {
    out.push({ state: 'posted', path: null, line: 0, body: c.body, url: c.html_url });
  }
  for (const r of reviews.filter(mine)) {
    if (r.state === 'PENDING') {
      const pending = await ghJson([`${base}/reviews/${r.id}/comments?per_page=100`, '--paginate']);
      for (const c of pending) {
        out.push({
          state: 'pending',
          path: c.path,
          line: c.line || c.original_line || 0,
          body: c.body,
          url: r.html_url || null,
        });
      }
      if (r.body) {
        out.push({ state: 'pending', path: null, line: 0, body: r.body, url: r.html_url || null });
      }
    } else if (r.body) {
      out.push({ state: 'posted', path: null, line: 0, body: r.body, url: r.html_url });
    }
  }
  const value = { login, comments: out };
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearCache = () => {
  cache.clear();
  login = null;
};
/** Drop one PR's cached comments, e.g. right after adding one to the pending review. */
export const forgetComments = (repo, number) => {
  cache.delete(`${repo}#${number}`.toLowerCase());
};

// ---------- the reviewer's own calls, kept by the bridge
function file(home, key) {
  const dir = path.join(home, 'state', key);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'drafts.json');
}
const EMPTY = () => ({ posted: [], unposted: [], dismissed: [], added: [] });
export function readMarks(home, key) {
  return { ...EMPTY(), ...readJson(file(home, key), {}) };
}
function writeMarks(home, key, marks) {
  writeJson(file(home, key), marks);
}

const entryOf = (draft) => ({
  path: draft.path || '',
  line: Number(draft.line) || 0,
  body: String(draft.body || ''),
  at: new Date().toISOString(),
});
const sameAs = (entry) => (e) =>
  bestMatch(entry, [{ ...e, path: isGeneral(e) ? null : e.path }]) !== null;

/** action: posted | unposted | dismiss | restore | settle (drop an `added` mark once it's confirmed), for one draft {path, line, body}. */
export function mark(home, key, action, draft) {
  const marks = readMarks(home, key);
  const entry = entryOf(draft);
  const same = sameAs(entry);
  const drop = (list) => list.filter((e) => !same(e));
  if (action === 'posted') {
    marks.posted = [...drop(marks.posted), entry];
    marks.unposted = drop(marks.unposted);
  } else if (action === 'unposted') {
    marks.unposted = [...drop(marks.unposted), entry];
    marks.posted = drop(marks.posted);
  } else if (action === 'dismiss') {
    marks.dismissed = [...drop(marks.dismissed), entry];
  } else if (action === 'restore') {
    marks.dismissed = drop(marks.dismissed);
  } else if (action === 'settle') {
    marks.added = drop(marks.added);
  } else {
    throw Object.assign(new Error('action must be posted, unposted, dismiss, restore or settle'), {
      status: 400,
    });
  }
  writeMarks(home, key, marks);
  return marks;
}

/** The `added` mark for a draft, if Add to my review already put it in their pending review. */
export const addedMark = (marks, draft) => (marks.added || []).find(sameAs(entryOf(draft))) || null;

/** Add to my review worked: remember it until the page, or gh after a reload, shows it. */
export function noteAdded(home, key, draft, added = {}) {
  const marks = readMarks(home, key);
  const entry = {
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
export function draftStatus(chapters, marks, gh = null, notes = null) {
  const asPosted = (list) => list.map((e) => ({ ...e, path: isGeneral(e) ? null : e.path }));
  const out = [];
  chapters.forEach((ch, ci) =>
    (ch.comments || []).forEach((c, i) => {
      const d = { path: c.path || '', line: Number(c.line) || 0, body: c.body || '' };
      const add = bestMatch(d, asPosted(marks.added || []));
      const row = {
        chapter: ci + 1,
        index: i,
        key: draftKey(d),
        status: 'draft',
        dismissed: !!bestMatch(d, asPosted(marks.dismissed)),
        source: null,
        url: null,
        score: null,
      };
      row.added = add ? { at: add.at, url: add.url || null, started: !!add.started } : null;
      // a local story's draft that Add to fix before push made into a note
      const note = notes ? notes.find((n) => n.draft === row.key) : null;
      row.fix = note
        ? { id: note.id, done: !!note.done, path: note.path, side: note.side, line: note.line }
        : null;
      const unmarked = bestMatch(d, asPosted(marks.unposted));
      const manual = bestMatch(d, asPosted(marks.posted));
      const auto = gh && !unmarked ? bestMatch(d, gh.comments) : null;
      if (auto) {
        Object.assign(row, {
          status: auto.state,
          source: 'github',
          url: auto.url,
          score: Math.round(auto.score * 100) / 100,
        });
      } else if (manual) {
        Object.assign(row, { status: 'posted', source: 'manual' });
      }
      out.push(row);
    }),
  );
  return out;
}

export const hasGh = () =>
  existsSync('/opt/homebrew/bin/gh') ||
  existsSync('/usr/local/bin/gh') ||
  existsSync('/usr/bin/gh') ||
  !!process.env.DIFF_STORY_GH;
