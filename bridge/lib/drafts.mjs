/**
 * What's become of each drafted comment: posted on GitHub, waiting in Eric's
 * pending review, dismissed by him, or still a draft.
 *
 * Posted and pending come from read-only `gh api` GETs (as the logged-in gh
 * user, with GITHUB_TOKEN unset so the keychain login is used), cached for
 * 60s:
 *   repos/{o}/{r}/pulls/{n}/comments                 posted review comments
 *   repos/{o}/{r}/pulls/{n}/reviews                  reviews (a PENDING one is his unsubmitted review)
 *   repos/{o}/{r}/pulls/{n}/reviews/{id}/comments    that pending review's comments
 *   repos/{o}/{r}/issues/{n}/comments                general PR comments
 * A draft matches a comment of his on the same file within 3 lines (or a
 * general draft a general comment) whose text is at least 0.75 similar, since
 * he often edits a draft before posting it.
 *
 * "Mark posted" / "Unmark" and "Dismiss" / "Restore" are his calls, kept by
 * the bridge in <home>/state/<key>/drafts.json, where the key is the PR (so a
 * re-rendered or regenerated story keeps them) or the local story's id.
 * Dismissals match by path, line and text too, so a regenerated story doesn't
 * suggest the same comment again. Nothing is ever written to GitHub.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GH = () => process.env.DIFF_STORY_GH || 'gh';
const TTL_MS = 60000;
const LINE_SLACK = 3;
export const SIMILAR = 0.75; // he edits drafts before posting: #6943's pending Combobox comment scores 0.80 against its draft

export const stateKeyOf = (id, meta) => (meta && meta.kind === 'github' && meta.repo && meta.number ? `pr-${meta.repo.replace('/', '-')}-${meta.number}`.toLowerCase() : id);
export const draftKey = c => createHash('sha1').update(`${c.path || ''}\n${Number(c.line) || 0}\n${normalize(c.body)}`).digest('hex').slice(0, 12);

export function normalize(text) {
  return String(text || '').toLowerCase().replace(/```[a-z]*\n?/g, ' ').replace(/[`*_>#~[\]()]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
/** 0..1: Dice similarity of character trigrams, or 1 when one text contains the other. */
export function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y || (x.length > 20 && y.includes(x)) || (y.length > 20 && x.includes(y))) return 1;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 2; i++) { const g = s.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(x);
  const B = grams(y);
  let both = 0;
  for (const [g, n] of A) both += Math.min(n, B.get(g) || 0);
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return total ? (2 * both) / total : 0;
}

const isGeneral = c => !Number(c.line) || /^\(/.test(c.path || '') || !c.path;
const samePath = (draft, posted) => draft === posted || posted.endsWith('/' + draft) || draft.endsWith('/' + posted);
/** The best match for a draft among comments [{path, line, body, ...}], or null. */
export function bestMatch(draft, comments) {
  let best = null;
  for (const p of comments) {
    if (isGeneral(draft) !== !p.path) continue;
    if (p.path) {
      if (!samePath(draft.path, p.path)) continue;
      const line = Number(p.line || p.original_line || 0);
      if (line && Math.abs(line - Number(draft.line)) > LINE_SLACK) continue;
    }
    const score = similarity(draft.body, p.body);
    if (score >= SIMILAR && (!best || score > best.score)) best = { ...p, score };
  }
  return best;
}

function gh(args) {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN; // the keychain login has repo scope; GITHUB_TOKEN here is a yarn-only token
  return new Promise((resolve, reject) => {
    execFile(GH(), ['api', ...args], { env, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}
const ghJson = async args => {
  const out = await gh(args);
  // --paginate prints one JSON array per page
  return JSON.parse(`[${out.trim().replace(/\]\s*\[/g, '],[')}]`).flat();
};

let login = null;
const cache = new Map();
/** Eric's comments on a PR: [{state: 'posted'|'pending', path, line, body, url}], cached 60s. */
export async function githubComments(repo, number) {
  const key = `${repo}#${number}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (!login) login = JSON.parse(await gh(['user'])).login;
  const base = `repos/${repo}/pulls/${Number(number)}`;
  const [reviewComments, reviews, issueComments] = await Promise.all([
    ghJson([`${base}/comments?per_page=100`, '--paginate']),
    ghJson([`${base}/reviews?per_page=100`, '--paginate']),
    ghJson([`repos/${repo}/issues/${Number(number)}/comments?per_page=100`, '--paginate']),
  ]);
  const mine = x => x && x.user && x.user.login === login;
  const out = [];
  for (const c of reviewComments.filter(mine)) out.push({ state: 'posted', path: c.path, line: c.line || c.original_line || 0, body: c.body, url: c.html_url });
  for (const c of issueComments.filter(mine)) out.push({ state: 'posted', path: null, line: 0, body: c.body, url: c.html_url });
  for (const r of reviews.filter(mine)) {
    if (r.state === 'PENDING') {
      const pending = await ghJson([`${base}/reviews/${r.id}/comments?per_page=100`, '--paginate']);
      for (const c of pending) out.push({ state: 'pending', path: c.path, line: c.line || c.original_line || 0, body: c.body, url: r.html_url || null });
      if (r.body) out.push({ state: 'pending', path: null, line: 0, body: r.body, url: r.html_url || null });
    } else if (r.body) out.push({ state: 'posted', path: null, line: 0, body: r.body, url: r.html_url });
  }
  const value = { login, comments: out };
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearCache = () => { cache.clear(); login = null; };

// ---------- his own calls, kept by the bridge
function file(home, key) {
  const dir = path.join(home, 'state', key);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'drafts.json');
}
export function readMarks(home, key) {
  try { return { posted: [], unposted: [], dismissed: [], ...JSON.parse(readFileSync(file(home, key), 'utf8')) }; } catch { return { posted: [], unposted: [], dismissed: [] }; }
}
function writeMarks(home, key, marks) { writeFileSync(file(home, key), JSON.stringify(marks, null, 2)); }

/** action: posted | unposted | dismiss | restore, for one draft {path, line, body}. */
export function mark(home, key, action, draft) {
  const marks = readMarks(home, key);
  const entry = { path: draft.path || '', line: Number(draft.line) || 0, body: String(draft.body || ''), at: new Date().toISOString() };
  const same = e => bestMatch(entry, [{ ...e, path: isGeneral(e) ? null : e.path }]) !== null;
  const drop = list => list.filter(e => !same(e));
  if (action === 'posted') { marks.posted = [...drop(marks.posted), entry]; marks.unposted = drop(marks.unposted); }
  else if (action === 'unposted') { marks.unposted = [...drop(marks.unposted), entry]; marks.posted = drop(marks.posted); }
  else if (action === 'dismiss') marks.dismissed = [...drop(marks.dismissed), entry];
  else if (action === 'restore') marks.dismissed = drop(marks.dismissed);
  else throw Object.assign(new Error('action must be posted, unposted, dismiss or restore'), { status: 400 });
  writeMarks(home, key, marks);
  return marks;
}

/**
 * Status of every draft in the story's chapters:
 * [{chapter, index, key, status: 'draft'|'posted'|'pending', dismissed, source, url, score}]
 */
export function draftStatus(chapters, marks, gh = null) {
  const asPosted = list => list.map(e => ({ ...e, path: isGeneral(e) ? null : e.path }));
  const out = [];
  chapters.forEach((ch, ci) => (ch.comments || []).forEach((c, i) => {
    const d = { path: c.path || '', line: Number(c.line) || 0, body: c.body || '' };
    const row = { chapter: ci + 1, index: i, key: draftKey(d), status: 'draft', dismissed: !!bestMatch(d, asPosted(marks.dismissed)), source: null, url: null, score: null };
    const unmarked = bestMatch(d, asPosted(marks.unposted));
    const manual = bestMatch(d, asPosted(marks.posted));
    const auto = gh && !unmarked ? bestMatch(d, gh.comments) : null;
    if (auto) Object.assign(row, { status: auto.state, source: 'github', url: auto.url, score: Math.round(auto.score * 100) / 100 });
    else if (manual) Object.assign(row, { status: 'posted', source: 'manual' });
    out.push(row);
  }));
  return out;
}

export const hasGh = () => existsSync('/opt/homebrew/bin/gh') || existsSync('/usr/local/bin/gh') || existsSync('/usr/bin/gh') || !!process.env.DIFF_STORY_GH;
