/**
 * Finding and loading stories.
 *
 * A story is a folder holding chapters.json (pr-story's format) and either
 * file-map.json, meta.json or pr.json saying what it is a story of. The bridge
 * only reads story folders. What it records (viewed files, notes, position,
 * the panel's step) goes under <home>/state/<story id>/.
 *
 * Roots, searched in order (the first story with a given id wins):
 *   1. <home> itself (~/.diff-story/<owner>-<repo>-<N>/, local-*), or the --root folders
 *   2. pr-story's scratch folders, newest first
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff, pathSha } from './diff.mjs';
import { revParse, diffText, commitsBetween } from './git.mjs';
import { scratchBases } from './config.mjs';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};
const mtime = file => { try { return statSync(file).mtimeMs; } catch { return 0; } };
const isStoryDir = dir => existsSync(path.join(dir, 'chapters.json')) && ['file-map.json', 'meta.json', 'pr.json'].some(f => existsSync(path.join(dir, f)));

function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name));
  } catch { return []; }
}

/** pr-story scratch story folders: <base>/<project>/<session>/scratchpad/pr-story/<name>/ */
export function scratchStoryDirs(bases = scratchBases()) {
  const out = [];
  for (const base of bases) {
    for (const project of childDirs(base)) {
      for (const session of childDirs(project)) {
        for (const dir of childDirs(path.join(session, 'scratchpad', 'pr-story'))) if (isStoryDir(dir)) out.push(dir);
      }
    }
  }
  return out.sort((a, b) => mtime(path.join(b, 'chapters.json')) - mtime(path.join(a, 'chapters.json')));
}

/** What a story folder is about: {kind, id, repo, number, title, url, ...}. */
export function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), {}) || {};
  const pr = readJson(path.join(dir, 'pr.json'), null);
  const map = readJson(path.join(dir, 'file-map.json'), null);
  const plan = readJson(path.join(dir, 'chapters.json'), {}) || {};
  const out = { kind: meta.kind || 'github', ...meta };
  if (out.kind === 'github') {
    if (pr && pr.url) {
      const [owner, repo] = pr.url.split('/').slice(3, 5);
      out.repo ||= `${owner}/${repo}`;
      out.number ||= pr.number;
      out.url ||= pr.url;
      out.pr_title ||= pr.title;
      out.head_oid ||= pr.headRefOid || null; // the commit the story was told from
      out.base_oid ||= pr.baseRefOid || null;
    }
    if (map && typeof map.pr === 'string' && !out.repo) {
      const m = /^(.+)#(\d+)$/.exec(map.pr);
      if (m) { out.repo = m[1]; out.number = +m[2]; }
    }
    if (out.repo && out.number && !out.url) out.url = `https://github.com/${out.repo}/pull/${out.number}`;
  }
  out.title = plan.title || out.title || out.pr_title || path.basename(dir);
  return out;
}

export function storyVersion(dir) {
  const files = ['chapters.json', 'file-map.json', 'meta.json', 'local.diff', 'backstory.json'];
  return String(Math.max(...files.map(f => mtime(path.join(dir, f)))));
}

export class StoryStore {
  /** @param {{home: string, roots?: string[], scratch?: boolean|string[]}} opts */
  constructor({ home, roots, scratch = true }) {
    this.home = home;
    this.roots = roots && roots.length ? roots : [home];
    this.scratch = scratch;
  }

  /** [{id, dir}] in priority order, ids unique. */
  dirs() {
    const seen = new Map();
    const add = dir => {
      const id = path.basename(dir);
      if (ID_RE.test(id) && !seen.has(id)) seen.set(id, dir);
    };
    for (const root of this.roots) for (const dir of childDirs(root)) if (isStoryDir(dir)) add(dir);
    if (this.scratch) for (const dir of scratchStoryDirs(Array.isArray(this.scratch) ? this.scratch : undefined)) add(dir);
    return [...seen].map(([id, dir]) => ({ id, dir }));
  }

  dirOf(id) {
    if (!ID_RE.test(String(id))) return null;
    const hit = this.dirs().find(d => d.id === id);
    return hit ? hit.dir : null;
  }

  list() {
    return this.dirs().map(({ id, dir }) => {
      const m = readMeta(dir);
      return { id, kind: m.kind, title: m.title, repo: m.repo || null, number: m.number || null, url: m.url || null, dir, version: storyVersion(dir) };
    });
  }

  /** The newest GitHub story for owner/repo#number. Repo names compare case-insensitively, as GitHub's do. */
  find(repo, number) {
    const want = String(repo).toLowerCase();
    const hits = this.list().filter(s => s.kind === 'github' && String(s.repo).toLowerCase() === want && Number(s.number) === Number(number));
    hits.sort((a, b) => Number(b.version) - Number(a.version));
    return hits[0] || null;
  }

  stateDir(id) {
    const dir = path.join(this.home, 'state', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  readState(id, name, fallback) { return readJson(path.join(this.stateDir(id), name), fallback); }
  writeState(id, name, value) { writeFileSync(path.join(this.stateDir(id), name), JSON.stringify(value, null, 2)); }

  /** The story as the panel takes it (the overlay's data), plus the diff and bridge state for a local story. */
  load(id) {
    const dir = this.dirOf(id);
    if (!dir) return null;
    let meta = readMeta(dir);
    if (meta.kind === 'local') {
      refreshLocal(dir, readJson(path.join(dir, 'meta.json'), {}));
      meta = readMeta(dir);
    }
    const plan = readJson(path.join(dir, 'chapters.json'), {}) || {};
    const diff = loadDiff(dir, meta);
    const map = readJson(path.join(dir, 'file-map.json'), null);
    const rels = map && map.files ? Object.keys(map.files) : diff ? [...diff.keys()] : [];
    const chapters = (plan.chapters || []).map(ch => ({
      title: ch.title || '', headline: ch.headline || '', scenario: ch.scenario || '', summary: ch.summary || '',
      narrative: ch.narrative || '',
      backstory: backstoryOf(ch.backstory),
      files: (ch.files || []).map(entryOf),
      comments: (ch.comments || []).map(c => ({ path: c.path || '', line: c.line || 0, body: c.body || '' })),
    }));
    // a local diff is the truth: a file that has left it (say, reverted) leaves its chapters too
    if (diff) for (const ch of chapters) ch.files = ch.files.filter(f => diff.has(f.rel));
    for (const ch of chapters) for (const f of ch.files) if (!rels.includes(f.rel)) rels.push(f.rel);
    // anything in the diff that no chapter places goes in a last chapter, so no file is hidden from every step
    const placed = new Set(chapters.flatMap(ch => ch.files.map(f => f.rel)));
    const unplaced = rels.filter(rel => !placed.has(rel));
    if (unplaced.length) {
      chapters.push({
        title: `Chapter ${chapters.length + 1}: Not in a chapter yet`, headline: '', scenario: '', summary: '',
        narrative: `### Chapter ${chapters.length + 1}: Not in a chapter yet\n\nThe story doesn't place these ${unplaced.length} files. They're here so nothing in the diff is missed.`,
        files: unplaced.map(rel => ({ rel, partial: false, note: null })), comments: [], auto: true,
      });
    }
    const data = {
      id, kind: meta.kind, version: storyVersion(dir),
      pr: { repo: meta.repo || null, number: meta.number || null, title: meta.pr_title || meta.title, url: meta.url || null },
      title: meta.title,
      overview: plan.overview || '', summary: plan.summary || '', plan: plan.plan || '',
      files: rels.map(rel => ({ rel, sha: pathSha(rel) })),
      chapters,
      backstory: storyBackstory(plan.backstory, readJson(path.join(dir, 'backstory.json'), null)),
    };
    if (meta.kind === 'local') {
      const viewed = this.readState(id, 'viewed.json', {});
      data.local = {
        repo: meta.repo_path, base: meta.base, head: meta.head, base_oid: meta.base_oid, head_oid: meta.head_oid, branch: meta.branch || null,
        commits: meta.commits || [],
        files: rels.map(rel => {
          const f = diff && diff.get(rel);
          const v = viewed[rel];
          return {
            rel, sha: pathSha(rel), kind: f ? f.kind : 'modified', stats: f ? f.stats : { added: 0, removed: 0 }, hunks: f ? f.hunks : [],
            renamed_from: f && f.renamed_from ? f.renamed_from : null, binary: !!(f && f.binary), hash: f ? f.hash : null,
            viewed: !!(v && f && v.hash === f.hash), viewed_changed: !!(v && f && v.hash !== f.hash),
          };
        }),
        notes: this.readState(id, 'notes.json', []),
      };
    }
    return data;
  }
}

export function entryOf(e) {
  if (typeof e === 'string') return { rel: e, partial: false, note: null };
  const out = { rel: e.rel, partial: !!e.partial, note: e.note || null };
  if (Array.isArray(e.lines) && e.lines.length) {
    out.lines = e.lines.map(l => {
      const line = { side: l.side === 'L' ? 'L' : 'R', start: +l.start, end: +(l.end || l.start), label: l.label || '' };
      if (typeof l.backstory === 'string' && l.backstory) line.backstory = l.backstory;
      return line;
    });
  }
  const bs = backstoryOf(e.backstory);
  if (bs) out.backstory = bs;
  return out;
}

// ---------- backstory: optional, always secondary to the result story
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const turnOf = t => (t !== null && t !== '' && Number.isFinite(+t) ? +t : null);
const stepOf = s => (s && typeof s === 'object'
  ? { at: str(s.at, 40) || null, text: str(s.text, 2000), session: str(s.session, 80) || null, turn: turnOf(s.turn), agent: str(s.agent, 80) || null }
  : null);

/** A chapter's or a file's backstory: {summary|text, steps: [{at, text, session, turn, agent}]}. A string is a summary. */
export function backstoryOf(b) {
  if (!b) return null;
  if (typeof b === 'string') return { summary: b, text: b, steps: [] };
  if (typeof b !== 'object') return null;
  const out = { summary: str(b.summary, 4000), text: str(b.text || b.summary, 4000), steps: (Array.isArray(b.steps) ? b.steps : []).map(stepOf).filter(s => s && s.text) };
  return out.summary || out.text || out.steps.length ? out : null;
}

/**
 * The story-level backstory: chapters.json's `backstory` ({summary, sessions, timeline}),
 * with the timeline and sessions falling back to the draft in backstory.json
 * (written by `diff-story backstory`) when the story doesn't give its own.
 */
export function storyBackstory(plan, found) {
  const p = plan && typeof plan === 'object' ? plan : typeof plan === 'string' ? { summary: plan } : {};
  const f = found && found.found ? found : null;
  const momentLines = id => {
    const m = f && f.moments ? f.moments.find(x => x.id === id) : null;
    return m ? m.lines : null;
  };
  const timeline = (Array.isArray(p.timeline) && p.timeline.length ? p.timeline : f && Array.isArray(f.timeline) ? f.timeline : []).map(t => ({
    ...stepOf(t), title: str(t.title, 200), asked: str(t.asked, 1000),
    files: Array.isArray(t.files) ? t.files.filter(x => typeof x === 'string') : [],
    lines: t.lines && typeof t.lines === 'object' ? t.lines : momentLines(t.moment) || {},
  })).filter(t => t.title || t.text);
  const sessions = (Array.isArray(p.sessions) && p.sessions.length ? p.sessions : f ? f.sessions : []).map(x => ({ id: str(x.id, 80), label: str(x.label || x.title, 200) })).filter(x => x.id);
  const summary = str(p.summary, 6000);
  return summary || timeline.length || sessions.length ? { summary, sessions, timeline } : null;
}

function loadDiff(dir, meta) {
  const file = ['local.diff', 'pr.diff'].map(f => path.join(dir, f)).find(f => existsSync(f));
  if (!file) return null;
  if (meta.kind !== 'local' && file.endsWith('pr.diff') && existsSync(path.join(dir, 'file-map.json'))) return null; // GitHub draws the diff
  return parseUnifiedDiff(readFileSync(file, 'utf8'));
}

/**
 * `meta` is the raw meta.json. A local story follows its refs: when `head` (say HEAD or a branch) has moved
 * since the diff was made, remake local.diff. Viewed marks are kept per file
 * diff, so a file whose diff changed shows as unviewed again.
 */
export function refreshLocal(dir, meta) {
  let baseOid, headOid;
  try {
    baseOid = revParse(meta.repo_path, meta.base);
    headOid = revParse(meta.repo_path, meta.head);
  } catch {
    return meta; // repo or ref gone: keep the last diff
  }
  if (baseOid === meta.base_oid && headOid === meta.head_oid && existsSync(path.join(dir, 'local.diff'))) return meta;
  writeFileSync(path.join(dir, 'local.diff'), diffText(meta.repo_path, baseOid, headOid));
  const next = { ...meta, base_oid: baseOid, head_oid: headOid, commits: commitsBetween(meta.repo_path, baseOid, headOid), updated_at: new Date().toISOString() };
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
  return next;
}
