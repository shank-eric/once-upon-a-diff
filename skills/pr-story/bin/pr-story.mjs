#!/usr/bin/env node
/**
 * pr-story: a pull request told as a story, chapter by chapter, with the
 * pinned session-story renderer drawing the page (diffs per chapter).
 *
 * Works on a folder that bin/gather.sh filled (pr.json, pr.diff,
 * threads.json, checks.json, viewed.tsv). Only `viewed --refresh` makes a
 * network call, and that one is a read (bin/viewed.sh).
 *
 *   pr-story.mjs brief   --dir D                 what Claude reads to plan: files, commits, reviews, threads, CI, viewed
 *   pr-story.mjs build   --dir D                 D/chapters.json -> D/story.json + D/file-map.json; fails if a file is unplaced
 *   pr-story.mjs render  --dir D [--open]        validate + render with the pinned renderer to D/pr-story.html
 *   pr-story.mjs viewed  --dir D --through N [--refresh]   viewed-files check at a chapter break
 *   pr-story.mjs links   --dir D --chapter N [--view files|changes]   GitHub URLs for chapter N's files (GitHub mode)
 *   pr-story.mjs handoff --dir D --chapter N     D/chapter-N.md, a brief for another Claude session
 *   pr-story.mjs overlay --dir D [--chapter N] [--out FILE]   JS snippet: story panel + chapter filter on the PR page (GitHub mode); no --chapter starts at the Overview
 *   pr-story.mjs publish --dir D                 copy the story to ~/.diff-story/<owner>-<repo>-<N>/ for Diff Story Mode (render does this too)
 *   pr-story.mjs backstory --dir D [--repo CHECKOUT]   find the Claude Code sessions that made the PR's commits (Diff Story Mode's
 *                                                matcher over session-story's extractor): D/backstory.json + D/backstory-brief.json
 *
 * The renderer is never modified. SESSION_STORY_DIR overrides where it lives.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = process.env.SESSION_STORY_DIR || path.join(os.homedir(), '.claude/skills/session-story');
const PINNED_SHA = 'b432256';
// This skill ships in the Diff Story Mode repo (skills/pr-story/bin), and Node
// resolves the skill link, so the repo is three folders up.
const DSM = process.env.DIFF_STORY_MODE_DIR || path.resolve(HERE, '../../..');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[a.slice(2)] = next; i++; } else opts[a.slice(2)] = true;
    }
  }
  return { command, opts };
}

/** Unified diff -> Map(rel -> {rel, hunks, stats, kind}). */
export function parseUnifiedDiff(text) {
  const files = new Map();
  let cur = null;
  let hunk = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { rel: m ? m[2] : line.slice(11), hunks: [], stats: { added: 0, removed: 0 }, kind: 'modified' };
      files.set(cur.rel, cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.kind = 'created'; continue; }
    if (line.startsWith('deleted file mode')) { cur.kind = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.renamed_from = line.slice(12); continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hunk = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push(line); cur.stats.added++; }
    else if (line.startsWith('-')) { hunk.lines.push(line); cur.stats.removed++; }
    else if (line.startsWith(' ')) hunk.lines.push(line);
  }
  return files;
}

const LANG = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', rb: 'ruby', erb: 'erb', scss: 'scss', css: 'css', sh: 'bash', py: 'python', sql: 'sql', html: 'html' };
function language(rel) {
  const ext = rel.includes('.') ? rel.split('.').pop() : '';
  return LANG[ext] ?? null;
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readViewed(dir) {
  const file = path.join(dir, 'viewed.tsv');
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const [state, rel] = line.split('\t');
    if (rel) out.set(rel, state);
  }
  return out;
}

async function load(dir) {
  const pr = await readJson(path.join(dir, 'pr.json'));
  const diff = parseUnifiedDiff(await readFile(path.join(dir, 'pr.diff'), 'utf8'));
  const threads = await readJson(path.join(dir, 'threads.json'), []);
  const checks = await readJson(path.join(dir, 'checks.json'), []);
  const viewed = await readViewed(dir);
  return { pr, diff, threads, checks, viewed };
}

const repoOf = (pr) => (pr.url || '').split('/').slice(3, 5).join('/');
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

async function cmdBrief(opts) {
  const { pr, diff, threads, checks, viewed } = await load(opts.dir);
  const byPath = {};
  for (const t of threads) (byPath[t.path] ||= []).push(t);
  const ci = {};
  for (const c of checks) ci[c.bucket] = (ci[c.bucket] || 0) + 1;
  const brief = {
    pr: {
      repo: repoOf(pr), number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login,
      base: pr.baseRefName, head: pr.headRefName, base_oid: pr.baseRefOid, head_oid: pr.headRefOid,
      state: pr.state, draft: pr.isDraft, decision: pr.reviewDecision, merge_state: pr.mergeStateStatus,
      created: pr.createdAt, updated: pr.updatedAt, merged: pr.mergedAt, body: pr.body,
      requested: (pr.reviewRequests || []).map((r) => r.login || r.name || r.slug),
    },
    totals: { files: diff.size, added: [...diff.values()].reduce((n, f) => n + f.stats.added, 0), removed: [...diff.values()].reduce((n, f) => n + f.stats.removed, 0) },
    files: [...diff.values()].map((f) => ({ rel: f.rel, kind: f.kind, stats: f.stats, threads: (byPath[f.rel] || []).length, viewed: viewed.get(f.rel) || null })),
    commits: (pr.commits || []).map((c) => ({ sha: c.oid.slice(0, 9), at: c.committedDate, subject: c.messageHeadline, body: clip(c.messageBody, 400) })),
    reviews: (pr.reviews || []).map((r) => ({ by: r.author?.login, state: r.state, at: r.submittedAt, body: clip(r.body, 400) })),
    threads: threads.map((t) => ({ path: t.path, line: t.line, resolved: t.resolved, outdated: t.outdated, posts: t.posts.map((p) => ({ by: p.by, at: p.at, body: clip(p.body, 500) })) })),
    ci: { counts: ci, failing: checks.filter((c) => c.bucket === 'fail').map((c) => ({ name: c.name, link: c.link })) },
  };
  process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
}

/** chapters.json file entries: "path" (covered here) or {rel, partial: true, note}. */
function entryOf(e) {
  if (typeof e === 'string') return { rel: e, partial: false, note: null };
  const out = { rel: e.rel, partial: !!e.partial, note: e.note || null };
  if (Array.isArray(e.lines) && e.lines.length) out.lines = e.lines.map((l) => ({ side: l.side === 'L' ? 'L' : 'R', start: +l.start, end: +(l.end || l.start), label: l.label || '' }));
  return out;
}

/**
 * The files a chapter's text points at lines of (`path:45`, `path:40-58`, a bare `:45` after a name, or a diff link with
 * a line anchor) and doesn't list. They count as that chapter telling the file, as partial entries, so the last chapter
 * to point at a file finishes it. Names resolve to the chapter's files first, then to one PR file (an ambiguous one is
 * skipped). "Since you read it" chapters are left alone. Diff Story Mode's bridge/lib/refs.mjs applies the same rule.
 */
function textRefsOf(ch, rels) {
  if (ch.since) return [];
  const listed = (ch.files || []).map((raw) => entryOf(raw).rel);
  const bySha = new Map(rels.map((rel) => [createHash('sha256').update(rel).digest('hex'), rel]));
  const find = (name, scope) => scope.find((r) => r === name) || scope.filter((r) => r.endsWith('/' + name));
  const resolve = (name) => {
    if (!name || /\s/.test(name) || !/[./]/.test(name)) return null;
    const own = find(name, listed);
    if (typeof own === 'string') return own;
    if (own.length) return own[0];
    const any = find(name, rels);
    return typeof any === 'string' ? any : any.length === 1 ? any[0] : null;
  };
  const found = new Set();
  let last = null;
  const text = [ch.headline, ch.scenario, ch.summary, ch.narrative].filter(Boolean).join('\n\n').replace(/```[\s\S]*?```/g, ' ');
  const re = /`([^`\n]+)`|\[[^\]]*\]\((https?:[^)\s]+)\)/g;
  for (let m; (m = re.exec(text)); ) {
    if (m[2]) {
      const hit = /#diff-([0-9a-f]{64})(?:[LR](\d+))?/.exec(m[2]);
      const rel = hit && bySha.get(hit[1]);
      if (rel) { last = rel; if (hit[2]) found.add(rel); }
      continue;
    }
    const lm = /^(.*?):[LR]?\d+(?:-[LR]?\d+)?$/.exec(m[1].trim().replace(/^\.\//, ''));
    const name = lm ? lm[1] : m[1].trim().replace(/^\.\//, '');
    const rel = name ? resolve(name) : last || (listed.length === 1 ? listed[0] : null);
    if (name && rel) last = rel;
    if (rel && lm) found.add(rel);
  }
  return [...found].filter((rel) => !listed.includes(rel)).map((rel) => ({ rel, partial: true, note: 'its lines are pointed at in the text', ref: true }));
}

function buildMap(chapters, diff) {
  const files = {};
  for (const rel of diff.keys()) files[rel] = { chapters: [], partial_in: [], finished_in: null };
  const problems = [];
  const rels = [...diff.keys()];
  const entriesOf = (ch) => [...(ch.files || []).map(entryOf), ...textRefsOf(ch, rels)];
  chapters.forEach((ch, i) => {
    const n = i + 1;
    for (const e of entriesOf(ch)) {
      const f = files[e.rel];
      if (!f) { problems.push(`chapter ${n} names ${e.rel}, which is not in the PR diff`); continue; }
      f.chapters.push(n);
      if (e.partial) f.partial_in.push(n);
      // marked viewed in the LAST chapter that lists it or points at its lines (Diff Story Mode reads the same rule)
      f.finished_in = n;
    }
  });
  // a "Since you read it" chapter (one with `since`, put first by a story update) finishes its files, though the
  // chapters they already read follow it; the newest (first) one wins (Diff Story Mode reads the same rule)
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (!chapters[i].since) continue;
    for (const raw of chapters[i].files || []) { const f = files[entryOf(raw).rel]; if (f) f.finished_in = i + 1; }
  }
  const missing = Object.keys(files).filter((rel) => files[rel].chapters.length === 0);
  const unfinished = Object.keys(files).filter((rel) => files[rel].chapters.length && files[rel].finished_in === null);
  if (missing.length) problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  if (unfinished.length) problems.push(`${unfinished.length} files are only ever partial, so no chapter finishes them: ${unfinished.join(', ')}`);
  const perChapter = chapters.map((ch, i) => {
    const n = i + 1;
    const entries = entriesOf(ch);
    return {
      n, title: ch.title,
      finishes: entries.filter((e) => files[e.rel]?.finished_in === n).map((e) => e.rel),
      partial: entries.filter((e) => e.partial).map((e) => ({ rel: e.rel, finished_in: files[e.rel]?.finished_in ?? null })),
      revisits: entries.filter((e) => !e.partial && files[e.rel] && files[e.rel].finished_in !== n).map((e) => e.rel),
    };
  });
  return { files, chapters: perChapter, problems };
}

function chapterReply(ch) {
  let text = ch.narrative || '';
  for (const c of ch.comments || []) {
    text += `\n\n**Suggested comment on \`${c.path}\`${c.line ? ` line ${c.line}` : ''}:**\n\n\`\`\`\n${c.body}\n\`\`\``;
  }
  return text.trim();
}

async function cmdBuild(opts) {
  const dir = opts.dir;
  const { pr, diff } = await load(dir);
  const plan = await readJson(opts.chapters || path.join(dir, 'chapters.json'));
  const chapters = plan.chapters || [];
  const map = buildMap(chapters, diff);
  if (map.problems.length && !opts['allow-missing']) {
    throw new Error(`file placement:\n  - ${map.problems.join('\n  - ')}`);
  }

  const turns = chapters.map((ch, i) => {
    const index = i + 1;
    const edits = (ch.files || []).map(entryOf).filter((e) => diff.has(e.rel)).map((e) => {
      const f = diff.get(e.rel);
      return { id: `ch${index}:${e.rel}`, tool: 'PR', file: e.rel, rel: e.rel, outside_cwd: false, kind: f.kind, result: 'ok', error: null, hunks: f.hunks, stats: f.stats };
    });
    const reply = chapterReply(ch);
    const held = map.chapters[i].partial.map((p) => `${p.rel} (finished in chapter ${p.finished_in})`);
    let summary = ch.summary || '';
    if (held.length && !ch.summary_has_partials) summary += ` Partly covered here: ${held.join(', ')}.`;
    return {
      index, id: `chapter-${index}`, at: null,
      prompt: ch.scenario ? `${ch.title}\n\n${ch.scenario}` : ch.title,
      summary: summary.trim(),
      answer: ch.answer || null,
      replies: reply ? [{ at: null, text: reply }] : [],
      edits, bash: [], errors: [], skills: [], plan: null,
    };
  });

  const all = [...diff.values()];
  const files = all.map((f) => ({
    rel: f.rel, language: language(f.rel), outside_cwd: false,
    turns: map.files[f.rel].chapters, churn: map.files[f.rel].chapters.length > 1, stats: f.stats,
  }));
  const created = pr.createdAt ? Date.parse(pr.createdAt) : null;
  const ended = pr.mergedAt || pr.closedAt || null;
  const blind = ['Each chapter shows the PR\'s net diff for its files, as fetched, not what each commit looked like.'];
  const split = files.filter((f) => f.churn).length;
  if (split) blind.push(`${split} files appear in more than one chapter; each shows the whole file diff and the chapter text says which part it covers.`);
  if (map.problems.length) blind.push(...map.problems);

  const repo = repoOf(pr);
  const story = {
    schema_version: 1,
    kind: 'pr',
    session: {
      id: `pr-${repo.replace('/', '-')}-${pr.number}`,
      chain: [],
      cwd: `${repo}#${pr.number}`,
      git_branch: `${pr.headRefName} → ${pr.baseRefName}`,
      title: plan.title || clip(pr.title, 60),
      ai_title: pr.title,
      started_at: pr.createdAt || null,
      ended_at: ended,
      duration_ms: created && ended ? Math.max(0, Date.parse(ended) - created) : 0,
      summary: plan.summary || '',
      blind_spots: blind,
    },
    turns,
    files,
    totals: {
      turns: turns.length, files: all.length,
      added: all.reduce((n, f) => n + f.stats.added, 0),
      removed: all.reduce((n, f) => n + f.stats.removed, 0),
      edits: turns.reduce((n, t) => n + t.edits.length, 0),
    },
    report: {
      plan: plan.plan || '',
      decisions: plan.decisions || [],
      outcome: plan.outcome || (pr.state === 'MERGED' ? 'completed' : 'partial'),
      outcome_note: plan.outcome_note || null,
      dependencies: { manifests: [], installs: [], config_files: [] },
      git: {
        branch: pr.headRefName, start_commit: pr.baseRefOid || null, end_commit: pr.headRefOid || null,
        commits: (pr.commits || []).map((c) => ({ sha: c.oid, subject: c.messageHeadline, turn: null })),
        status: null,
      },
    },
    generator: { name: 'pr-story', version: '1.0.0', renderer: `session-story@${PINNED_SHA}` },
  };
  await writeFile(path.join(dir, 'story.json'), JSON.stringify(story, null, 2));
  await writeFile(path.join(dir, 'file-map.json'), JSON.stringify({ pr: `${repo}#${pr.number}`, mode: plan.mode || 'journey', files: map.files, chapters: map.chapters }, null, 2));
  const partials = Object.values(map.files).filter((f) => f.partial_in.length).length;
  process.stderr.write(`Wrote story.json and file-map.json: ${turns.length} chapters, ${all.length} files, ${all.length - Object.values(map.files).filter((f) => !f.chapters.length).length} placed, ${partials} partial\n`);
}

/**
 * "Turn" -> "chapter" in what the reader sees: whole text nodes that are only
 * a turn label ("Turn 3", "6 turns", "turns"), tooltip and aria labels.
 * Scripts, styles and class names are left alone.
 */
export function relabel(html) {
  const word = (w) => ({ Turn: 'Chapter', turn: 'chapter', Turns: 'Chapters', turns: 'chapters' })[w];
  return html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/>(\s*)(Turns?|turns?)(\s+\d+\s*)</g, (m, a, w, b) => `>${a}${word(w)}${b}<`)
      .replace(/>(\s*\d+\s+)(turns?)(\s*)</g, (m, a, w, b) => `>${a}${word(w)}${b}<`)
      .replace(/>(\s*)(Turns|turns)(\s*)</g, (m, a, w, b) => `>${a}${word(w)}${b}<`)
      .replace(/(title|aria-label)="Turn (\d+)/g, '$1="Chapter $2')
      .replace(/aria-label="([^"]*?)\bturns?\b/g, (m, a) => m.replace(/\bturn(s?)\b(?=[^"]*$)/, 'chapter$1'));
  }).join('');
}

async function cmdRender(opts) {
  const dir = opts.dir;
  const storyMjs = path.join(RENDERER_DIR, 'bin/story.mjs');
  const pinned = path.join(RENDERER_DIR, 'PINNED.txt');
  const pinText = existsSync(pinned) ? await readFile(pinned, 'utf8') : '';
  if (!pinText.includes(PINNED_SHA)) process.stderr.write(`warning: ${RENDERER_DIR} is not the pinned session-story ${PINNED_SHA}\n`);
  const storyJson = path.join(dir, 'story.json');
  const out = path.join(dir, 'pr-story.html');
  execFileSync('node', [storyMjs, 'validate', storyJson, '--strict'], { stdio: 'inherit' });
  execFileSync('node', [storyMjs, 'render', storyJson, '-o', out], { stdio: 'inherit' });
  // Relabel the header for a PR. This edits the rendered page, not the renderer.
  let html = await readFile(out, 'utf8');
  // Both swaps are exact strings from the pinned page; if a renderer update
  // changes them they just stop applying.
  html = relabel(html.replace('<span>Session story</span>', '<span>PR story</span>'));
  await writeFile(out, html);
  if (opts.open) {
    // open_command in ~/.diff-story/config.json, else the platform's opener (Diff Story Mode's config.mjs)
    let argv = [process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', out];
    try { argv = (await import(pathToFileURL(path.join(DSM, 'bridge/lib/config.mjs')).href)).openArgv(out); } catch { /* no Diff Story Mode beside it */ }
    execFile(argv[0], argv.slice(1), () => {});
  }
  process.stderr.write(`Page: ${out}${opts.open ? ' (opened)' : ''}\n`);
  if (!opts['no-bridge']) await cmdPublish(opts);
}

/**
 * Diff Story Mode: copy chapters.json and file-map.json, plus a meta.json
 * naming the PR, to where its bridge serves stories
 * (DIFF_STORY_HOME, default ~/.diff-story/<owner>-<repo>-<N>/). The
 * extension then shows the panel on the PR page by itself, and picks up
 * each re-render within a few seconds.
 */
async function cmdPublish(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const repo = repoOf(pr);
  if (!repo || !pr.number) throw new Error('pr.json does not name the PR');
  const home = process.env.DIFF_STORY_HOME || path.join(os.homedir(), '.diff-story');
  const dest = path.join(home, `${repo.replace('/', '-')}-${pr.number}`.replace(/[^A-Za-z0-9._-]+/g, '-'));
  await mkdir(dest, { recursive: true });
  for (const f of ['chapters.json', 'file-map.json', 'backstory.json']) if (existsSync(path.join(dir, f))) await copyFile(path.join(dir, f), path.join(dest, f));
  await writeFile(path.join(dest, 'meta.json'), JSON.stringify({ kind: 'github', repo, number: pr.number, url: pr.url, pr_title: pr.title, head_oid: pr.headRefOid || null, base_oid: pr.baseRefOid || null, source: path.resolve(dir), published_at: new Date().toISOString() }, null, 2));
  process.stderr.write(`Diff Story Mode: ${dest}\n`);
}

/**
 * Backstory: the Claude Code sessions that made this PR's commits, if any.
 * Needs the commits in a local checkout (the first in checkouts.txt, or
 * --repo). A PR nobody made in Claude Code, or one whose commits aren't
 * local, gets backstory.json with found: false, and the story goes on without it.
 */
async function cmdBackstory(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const out = path.join(dir, 'backstory.json');
  const skip = async (reason) => {
    await writeFile(out, JSON.stringify({ found: false, reason, sessions: [], moments: [], files: {}, timeline: [] }, null, 2));
    process.stderr.write(`No backstory: ${reason}\n`);
  };
  const cli = path.join(DSM, 'bridge/bin/diff-story.mjs');
  if (!existsSync(cli)) return skip(`Diff Story Mode isn't at ${DSM}`);
  let repo = opts.repo;
  if (!repo && existsSync(path.join(dir, 'checkouts.txt'))) repo = ((await readFile(path.join(dir, 'checkouts.txt'), 'utf8')).split('\n')[0] || '').split('\t')[1];
  if (!repo) return skip('no local checkout of the repo');
  const has = (oid) => { try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${oid}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!has(pr.baseRefOid) || !has(pr.headRefOid)) return skip(`the PR's commits aren't in ${repo} (fetch the head into refs/tmp/pr-${pr.number} first if they were made here)`);
  const brief = execFileSync('node', [cli, 'backstory', '--repo', repo, '--base', pr.baseRefOid, '--head', pr.headRefOid, '-o', out, '--brief', ...(opts['exclude-agent'] ? ['--exclude-agent', opts['exclude-agent']] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  await writeFile(path.join(dir, 'backstory-brief.json'), brief);
  process.stderr.write(`Brief: ${path.join(dir, 'backstory-brief.json')}\n`);
}

/** Viewed-files check at a chapter break: what should be ticked by now. */
async function cmdViewed(opts) {
  const dir = opts.dir;
  const map = await readJson(path.join(dir, 'file-map.json'));
  if (opts.refresh) {
    const pr = await readJson(path.join(dir, 'pr.json'));
    const tsv = execFileSync(path.join(HERE, 'viewed.sh'), [String(pr.number), repoOf(pr)], { encoding: 'utf8' });
    await writeFile(path.join(dir, 'viewed.tsv'), tsv);
  }
  const viewed = await readViewed(dir);
  const n = Number(opts.through);
  const rels = Object.keys(map.files);
  const isViewed = (rel) => viewed.get(rel) === 'VIEWED';
  const due = rels.filter((rel) => map.files[rel].finished_in !== null && map.files[rel].finished_in <= n);
  const result = {
    through_chapter: n,
    viewed: rels.filter(isViewed).length,
    total: rels.length,
    missed: due.filter((rel) => !isViewed(rel)).map((rel) => ({ rel, finished_in: map.files[rel].finished_in, state: viewed.get(rel) || 'UNKNOWN' })),
    held_partials: rels.filter((rel) => map.files[rel].chapters.some((c) => c <= n) && map.files[rel].finished_in > n)
      .map((rel) => ({ rel, finished_in: map.files[rel].finished_in, viewed: isViewed(rel) })),
    ahead: rels.filter((rel) => isViewed(rel) && map.files[rel].finished_in > n && !map.files[rel].chapters.some((c) => c <= n)).map((rel) => ({ rel, finished_in: map.files[rel].finished_in })),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/**
 * GitHub "Files changed" anchors are diff- + sha256 of the file path. `view`
 * is the PR tab: "files" (classic) or "changes" (the newer review UI).
 */
export function fileUrl(prUrl, rel, view = 'changes') {
  return `${prUrl}/${view}#diff-${createHash('sha256').update(rel).digest('hex')}`;
}

async function chapterOf(dir, n) {
  const plan = await readJson(path.join(dir, 'chapters.json'));
  const ch = plan.chapters[n - 1];
  if (!ch) throw new Error(`no chapter ${n}`);
  return { plan, ch };
}

/** GitHub mode: where to point the browser for chapter N. Prints only. */
async function cmdLinks(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const n = Number(opts.chapter);
  const { ch } = await chapterOf(dir, n);
  const view = opts.view === 'files' ? 'files' : 'changes';
  const links = (ch.files || []).map(entryOf).map((e) => ({ rel: e.rel, partial: e.partial, url: fileUrl(pr.url, e.rel, view) }));
  process.stdout.write(JSON.stringify({ chapter: n, title: ch.title, tab: `${pr.url}/${view}`, links }, null, 2) + '\n');
}

/**
 * A chapter brief for another Claude session (the Chrome side panel, or a
 * fresh terminal): the story map, this chapter's text, its files and the
 * drafted comments. Writes D/chapter-N.md and prints the path.
 */
async function cmdHandoff(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const n = Number(opts.chapter);
  const { plan, ch } = await chapterOf(dir, n);
  const map = plan.chapters.map((c, i) => `${i + 1}. ${c.title.replace(/^Chapter \d+: /, '')}${i + 1 === n ? ' (this chapter)' : ''}`).join('\n');
  const files = (ch.files || []).map(entryOf).map((e) => `- ${e.rel}${e.partial ? ' (partly, finished later)' : ''}`).join('\n');
  const md = [
    `# ${pr.title} (${repoOf(pr)}#${pr.number})`, '',
    `${pr.url}`, '',
    'You are helping a reviewer walk through this PR as a story. Answer questions about this chapter from the diff on the page. Do not click Viewed, comment, approve or submit anything.', '',
    '## Story map', map, '',
    (ch.narrative || '').startsWith('#') ? '' : `## ${ch.title}`, ch.scenario ? `Scenario: ${ch.scenario}` : '', '', ch.narrative || ch.summary || '', '',
    '## Files in this chapter', files, '',
  ].join('\n');
  const out = path.join(dir, `chapter-${n}.md`);
  await writeFile(out, md);
  process.stdout.write(out + '\n');
}

/**
 * GitHub overlay: a self-contained JS snippet (bin/overlay.js plus every
 * chapter's data) to run in the PR's /changes page. It docks the story in a
 * side panel and hides the other chapters' files. Prints the snippet, or
 * writes it to --out FILE and prints the path.
 */
async function cmdOverlay(opts) {
  const dir = opts.dir;
  const { pr, diff } = await load(dir);
  const plan = await readJson(path.join(dir, 'chapters.json'));
  const sha = (rel) => createHash('sha256').update(rel).digest('hex');
  const data = {
    pr: { repo: repoOf(pr), number: pr.number, title: pr.title, url: pr.url },
    start: opts.chapter === undefined || opts.chapter === 'overview' ? 0 : Number(opts.chapter),
    overview: plan.overview || '', summary: plan.summary || '', plan: plan.plan || '',
    files: [...diff.keys()].map((rel) => ({ rel, sha: sha(rel) })),
    chapters: (plan.chapters || []).map((ch) => ({
      title: ch.title, headline: ch.headline || '', scenario: ch.scenario || '', summary: ch.summary || '',
      narrative: ch.narrative || '',
      files: (ch.files || []).map(entryOf),
      comments: (ch.comments || []).map((c) => ({ path: c.path || '', line: c.line || 0, body: c.body || '' })),
    })),
  };
  if (!(data.start >= 0 && data.start <= data.chapters.length)) throw new Error(`no chapter ${opts.chapter} (0 or overview is the Overview step)`);
  const src = await readFile(path.join(HERE, 'overlay.js'), 'utf8');
  const snippet = `${src}\nprStoryOverlay(${JSON.stringify(data)});\n`;
  if (opts.out) { await writeFile(opts.out, snippet); process.stdout.write(opts.out + '\n'); }
  else process.stdout.write(snippet);
}

const COMMANDS = { brief: cmdBrief, build: cmdBuild, render: cmdRender, viewed: cmdViewed, links: cmdLinks, handoff: cmdHandoff, overlay: cmdOverlay, publish: cmdPublish, backstory: cmdBackstory };
const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command];
if (!run || !opts.dir) {
  process.stderr.write('usage: pr-story.mjs <brief|build|render|viewed|links|handoff|overlay|publish|backstory> --dir <scratch-dir> [--open] [--no-bridge] [--through N] [--refresh] [--chapter N] [--view files|changes] [--out FILE]\n');
  process.exitCode = 1;
} else {
  run(opts).catch((err) => { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1; });
}
