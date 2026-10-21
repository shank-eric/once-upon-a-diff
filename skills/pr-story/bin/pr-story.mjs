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
const RENDERER_DIR =
  process.env.SESSION_STORY_DIR || path.join(os.homedir(), '.claude/skills/session-story');
const PINNED_SHA = 'b432256';
// This skill ships in the Diff Story Mode repo (skills/pr-story/bin), and Node
// resolves the skill link, so the repo is three folders up.
const DSM = process.env.DIFF_STORY_MODE_DIR || path.resolve(HERE, '../../..');
// a chapter's file entries, read the way the bridge reads them (bridge/stories/chapters.mjs)
const { entryOf } = await import(pathToFileURL(path.join(DSM, 'bridge/stories/chapters.mjs')).href);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[arg.slice(2)] = next;
        i++;
      } else {
        opts[arg.slice(2)] = true;
      }
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
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = {
        rel: names ? names[2] : line.slice(11),
        hunks: [],
        stats: { added: 0, removed: 0 },
        kind: 'modified',
      };
      files.set(cur.rel, cur);
      hunk = null;
      continue;
    }
    if (!cur) {
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.kind = 'created';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.kind = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.renamed_from = line.slice(12);
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      hunk = {
        oldStart: +hunkHeader[1],
        oldLines: hunkHeader[2] === undefined ? 1 : +hunkHeader[2],
        newStart: +hunkHeader[3],
        newLines: hunkHeader[4] === undefined ? 1 : +hunkHeader[4],
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push(line);
      cur.stats.added++;
    } else if (line.startsWith('-')) {
      hunk.lines.push(line);
      cur.stats.removed++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push(line);
    }
  }
  return files;
}

const LANG = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  rb: 'ruby',
  erb: 'erb',
  scss: 'scss',
  css: 'css',
  sh: 'bash',
  py: 'python',
  sql: 'sql',
  html: 'html',
};
function language(rel) {
  const ext = rel.includes('.') ? rel.split('.').pop() : '';
  return LANG[ext] ?? null;
}

async function readJson(file, fallback) {
  if (!existsSync(file)) {
    return fallback;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readViewed(dir) {
  const file = path.join(dir, 'viewed.tsv');
  const out = new Map();
  if (!existsSync(file)) {
    return out;
  }
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const [state, rel] = line.split('\t');
    if (rel) {
      out.set(rel, state);
    }
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
const clip = (text, max) => (text && text.length > max ? `${text.slice(0, max)}…` : text);

async function cmdBrief(opts) {
  const { pr, diff, threads, checks, viewed } = await load(opts.dir);
  const byPath = {};
  for (const thread of threads) {
    (byPath[thread.path] ||= []).push(thread);
  }
  const checksByState = {};
  for (const check of checks) {
    checksByState[check.bucket] = (checksByState[check.bucket] || 0) + 1;
  }
  const brief = {
    pr: {
      repo: repoOf(pr),
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login,
      base: pr.baseRefName,
      head: pr.headRefName,
      base_oid: pr.baseRefOid,
      head_oid: pr.headRefOid,
      state: pr.state,
      draft: pr.isDraft,
      decision: pr.reviewDecision,
      merge_state: pr.mergeStateStatus,
      created: pr.createdAt,
      updated: pr.updatedAt,
      merged: pr.mergedAt,
      body: pr.body,
      requested: (pr.reviewRequests || []).map(
        (reviewer) => reviewer.login || reviewer.name || reviewer.slug,
      ),
    },
    totals: {
      files: diff.size,
      added: [...diff.values()].reduce((sum, file) => sum + file.stats.added, 0),
      removed: [...diff.values()].reduce((sum, file) => sum + file.stats.removed, 0),
    },
    files: [...diff.values()].map((file) => ({
      rel: file.rel,
      kind: file.kind,
      stats: file.stats,
      threads: (byPath[file.rel] || []).length,
      viewed: viewed.get(file.rel) || null,
    })),
    commits: (pr.commits || []).map((commit) => ({
      sha: commit.oid.slice(0, 9),
      at: commit.committedDate,
      subject: commit.messageHeadline,
      body: clip(commit.messageBody, 400),
    })),
    reviews: (pr.reviews || []).map((review) => ({
      by: review.author?.login,
      state: review.state,
      at: review.submittedAt,
      body: clip(review.body, 400),
    })),
    threads: threads.map((thread) => ({
      path: thread.path,
      line: thread.line,
      resolved: thread.resolved,
      outdated: thread.outdated,
      posts: thread.posts.map((post) => ({ by: post.by, at: post.at, body: clip(post.body, 500) })),
    })),
    ci: {
      counts: checksByState,
      failing: checks
        .filter((check) => check.bucket === 'fail')
        .map((check) => ({ name: check.name, link: check.link })),
    },
  };
  process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
}

/** chapters.json file entries: "path" (covered here) or {rel, partial: true, note}. */

/**
 * The files a chapter's text points at lines of (`path:45`, `path:40-58`, a bare `:45` after a name, or a diff link with
 * a line anchor) and doesn't list. They count as that chapter telling the file, as partial entries, so the last chapter
 * to point at a file finishes it. Names resolve to the chapter's files first, then to one PR file (an ambiguous one is
 * skipped). "Since you read it" chapters are left alone. Diff Story Mode's bridge/stories/text-refs.mjs applies the same rule.
 */
function textRefsOf(chapter, rels) {
  if (chapter.since) {
    return [];
  }
  const listed = (chapter.files || []).map((raw) => entryOf(raw).rel);
  const bySha = new Map(rels.map((rel) => [createHash('sha256').update(rel).digest('hex'), rel]));
  const find = (name, scope) =>
    scope.find((rel) => rel === name) || scope.filter((rel) => rel.endsWith('/' + name));
  const resolve = (name) => {
    if (!name || /\s/.test(name) || !/[./]/.test(name)) {
      return null;
    }
    const own = find(name, listed);
    if (typeof own === 'string') {
      return own;
    }
    if (own.length) {
      return own[0];
    }
    const any = find(name, rels);
    if (typeof any === 'string') {
      return any;
    }
    return any.length === 1 ? any[0] : null;
  };
  const found = new Set();
  let last = null;
  const text = [chapter.headline, chapter.scenario, chapter.summary, chapter.narrative]
    .filter(Boolean)
    .join('\n\n')
    .replace(/```[\s\S]*?```/g, ' ');
  const pattern = /`([^`\n]+)`|\[[^\]]*\]\((https?:[^)\s]+)\)/g;
  for (let match; (match = pattern.exec(text));) {
    if (match[2]) {
      const hit = /#diff-([0-9a-f]{64})(?:[LR](\d+))?/.exec(match[2]);
      const rel = hit && bySha.get(hit[1]);
      if (rel) {
        last = rel;
        if (hit[2]) {
          found.add(rel);
        }
      }
      continue;
    }
    const lineMatch = /^(.*?):[LR]?\d+(?:-[LR]?\d+)?$/.exec(match[1].trim().replace(/^\.\//, ''));
    const name = lineMatch ? lineMatch[1] : match[1].trim().replace(/^\.\//, '');
    const rel = name ? resolve(name) : last || (listed.length === 1 ? listed[0] : null);
    if (name && rel) {
      last = rel;
    }
    if (rel && lineMatch) {
      found.add(rel);
    }
  }
  return [...found]
    .filter((rel) => !listed.includes(rel))
    .map((rel) => ({
      rel,
      partial: true,
      note: 'its lines are pointed at in the text',
      ref: true,
    }));
}

function buildMap(chapters, diff) {
  const files = {};
  for (const rel of diff.keys()) {
    files[rel] = { chapters: [], partial_in: [], finished_in: null };
  }
  const problems = [];
  const rels = [...diff.keys()];
  const entriesOf = (chapter) => [
    ...(chapter.files || []).map(entryOf),
    ...textRefsOf(chapter, rels),
  ];
  chapters.forEach((chapter, i) => {
    const step = i + 1;
    for (const e of entriesOf(chapter)) {
      const file = files[e.rel];
      if (!file) {
        problems.push(`chapter ${step} names ${e.rel}, which is not in the PR diff`);
        continue;
      }
      file.chapters.push(step);
      if (e.partial) {
        file.partial_in.push(step);
      }
      // marked viewed in the LAST chapter that lists it or points at its lines (Diff Story Mode reads the same rule)
      file.finished_in = step;
    }
  });
  // a "Since you read it" chapter (one with `since`, put first by a story update) finishes its files, though the
  // chapters they already read follow it; the newest (first) one wins (Diff Story Mode reads the same rule)
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (!chapters[i].since) {
      continue;
    }
    for (const raw of chapters[i].files || []) {
      const file = files[entryOf(raw).rel];
      if (file) {
        file.finished_in = i + 1;
      }
    }
  }
  const missing = Object.keys(files).filter((rel) => files[rel].chapters.length === 0);
  const unfinished = Object.keys(files).filter(
    (rel) => files[rel].chapters.length && files[rel].finished_in === null,
  );
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  if (unfinished.length) {
    problems.push(
      `${unfinished.length} files are only ever partial, so no chapter finishes them: ${unfinished.join(', ')}`,
    );
  }
  const perChapter = chapters.map((chapter, i) => {
    const step = i + 1;
    const entries = entriesOf(chapter);
    return {
      n: step,
      title: chapter.title,
      finishes: entries.filter((e) => files[e.rel]?.finished_in === step).map((e) => e.rel),
      partial: entries
        .filter((e) => e.partial)
        .map((e) => ({ rel: e.rel, finished_in: files[e.rel]?.finished_in ?? null })),
      revisits: entries
        .filter((e) => !e.partial && files[e.rel] && files[e.rel].finished_in !== step)
        .map((e) => e.rel),
    };
  });
  return { files, chapters: perChapter, problems };
}

function chapterReply(chapter) {
  let text = chapter.narrative || '';
  for (const comment of chapter.comments || []) {
    text += `\n\n**Suggested comment on \`${comment.path}\`${comment.line ? ` line ${comment.line}` : ''}:**\n\n\`\`\`\n${comment.body}\n\`\`\``;
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

  const turns = chapters.map((chapter, i) => {
    const index = i + 1;
    const edits = (chapter.files || [])
      .map(entryOf)
      .filter((e) => diff.has(e.rel))
      .map((e) => {
        const file = diff.get(e.rel);
        return {
          id: `ch${index}:${e.rel}`,
          tool: 'PR',
          file: e.rel,
          rel: e.rel,
          outside_cwd: false,
          kind: file.kind,
          result: 'ok',
          error: null,
          hunks: file.hunks,
          stats: file.stats,
        };
      });
    const reply = chapterReply(chapter);
    const held = map.chapters[i].partial.map(
      (part) => `${part.rel} (finished in chapter ${part.finished_in})`,
    );
    let summary = chapter.summary || '';
    if (held.length && !chapter.summary_has_partials) {
      summary += ` Partly covered here: ${held.join(', ')}.`;
    }
    return {
      index,
      id: `chapter-${index}`,
      at: null,
      prompt: chapter.scenario ? `${chapter.title}\n\n${chapter.scenario}` : chapter.title,
      summary: summary.trim(),
      answer: chapter.answer || null,
      replies: reply ? [{ at: null, text: reply }] : [],
      edits,
      bash: [],
      errors: [],
      skills: [],
      plan: null,
    };
  });

  const all = [...diff.values()];
  const files = all.map((file) => ({
    rel: file.rel,
    language: language(file.rel),
    outside_cwd: false,
    turns: map.files[file.rel].chapters,
    churn: map.files[file.rel].chapters.length > 1,
    stats: file.stats,
  }));
  const created = pr.createdAt ? Date.parse(pr.createdAt) : null;
  const ended = pr.mergedAt || pr.closedAt || null;
  const blind = [
    "Each chapter shows the PR's net diff for its files, as fetched, not what each commit looked like.",
  ];
  const split = files.filter((file) => file.churn).length;
  if (split) {
    blind.push(
      `${split} files appear in more than one chapter; each shows the whole file diff and the chapter text says which part it covers.`,
    );
  }
  if (map.problems.length) {
    blind.push(...map.problems);
  }

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
      turns: turns.length,
      files: all.length,
      added: all.reduce((sum, file) => sum + file.stats.added, 0),
      removed: all.reduce((sum, file) => sum + file.stats.removed, 0),
      edits: turns.reduce((sum, turn) => sum + turn.edits.length, 0),
    },
    report: {
      plan: plan.plan || '',
      decisions: plan.decisions || [],
      outcome: plan.outcome || (pr.state === 'MERGED' ? 'completed' : 'partial'),
      outcome_note: plan.outcome_note || null,
      dependencies: { manifests: [], installs: [], config_files: [] },
      git: {
        branch: pr.headRefName,
        start_commit: pr.baseRefOid || null,
        end_commit: pr.headRefOid || null,
        commits: (pr.commits || []).map((commit) => ({
          sha: commit.oid,
          subject: commit.messageHeadline,
          turn: null,
        })),
        status: null,
      },
    },
    generator: { name: 'pr-story', version: '1.0.0', renderer: `session-story@${PINNED_SHA}` },
  };
  await writeFile(path.join(dir, 'story.json'), JSON.stringify(story, null, 2));
  await writeFile(
    path.join(dir, 'file-map.json'),
    JSON.stringify(
      {
        pr: `${repo}#${pr.number}`,
        mode: plan.mode || 'journey',
        files: map.files,
        chapters: map.chapters,
      },
      null,
      2,
    ),
  );
  const partials = Object.values(map.files).filter((file) => file.partial_in.length).length;
  process.stderr.write(
    `Wrote story.json and file-map.json: ${turns.length} chapters, ${all.length} files, ${all.length - Object.values(map.files).filter((file) => !file.chapters.length).length} placed, ${partials} partial\n`,
  );
}

/**
 * "Turn" -> "chapter" in what the reader sees: whole text nodes that are only
 * a turn label ("Turn 3", "6 turns", "turns"), tooltip and aria labels.
 * Scripts, styles and class names are left alone.
 */
export function relabel(html) {
  const word = (label) =>
    ({ Turn: 'Chapter', turn: 'chapter', Turns: 'Chapters', turns: 'chapters' })[label];
  return html
    .split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/)
    .map((part, i) => {
      if (i % 2) {
        return part;
      }
      return part
        .replace(
          />(\s*)(Turns?|turns?)(\s+\d+\s*)</g,
          (match, before, label, after) => `>${before}${word(label)}${after}<`,
        )
        .replace(
          />(\s*\d+\s+)(turns?)(\s*)</g,
          (match, before, label, after) => `>${before}${word(label)}${after}<`,
        )
        .replace(
          />(\s*)(Turns|turns)(\s*)</g,
          (match, before, label, after) => `>${before}${word(label)}${after}<`,
        )
        .replace(/(title|aria-label)="Turn (\d+)/g, '$1="Chapter $2')
        .replace(/aria-label="([^"]*?)\bturns?\b/g, (match) =>
          match.replace(/\bturn(s?)\b(?=[^"]*$)/, 'chapter$1'),
        );
    })
    .join('');
}

async function cmdRender(opts) {
  const dir = opts.dir;
  const storyMjs = path.join(RENDERER_DIR, 'bin/story.mjs');
  const pinned = path.join(RENDERER_DIR, 'PINNED.txt');
  const pinText = existsSync(pinned) ? await readFile(pinned, 'utf8') : '';
  if (!pinText.includes(PINNED_SHA)) {
    process.stderr.write(
      `warning: ${RENDERER_DIR} is not the pinned session-story ${PINNED_SHA}\n`,
    );
  }
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
    // open_command in ~/.diff-story/config.json, else the platform's opener (Diff Story Mode's config/settings.mjs)
    let argv = [{ darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open', out];
    try {
      argv = (
        await import(pathToFileURL(path.join(DSM, 'bridge/config/settings.mjs')).href)
      ).openArgv(out);
    } catch {
      /* no Diff Story Mode beside it */
    }
    execFile(argv[0], argv.slice(1), () => {});
  }
  process.stderr.write(`Page: ${out}${opts.open ? ' (opened)' : ''}\n`);
  if (!opts['no-bridge']) {
    await cmdPublish(opts);
  }
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
  if (!repo || !pr.number) {
    throw new Error('pr.json does not name the PR');
  }
  const home = process.env.DIFF_STORY_HOME || path.join(os.homedir(), '.diff-story');
  const dest = path.join(
    home,
    `${repo.replace('/', '-')}-${pr.number}`.replace(/[^A-Za-z0-9._-]+/g, '-'),
  );
  await mkdir(dest, { recursive: true });
  for (const name of ['chapters.json', 'file-map.json', 'backstory.json']) {
    if (existsSync(path.join(dir, name))) {
      await copyFile(path.join(dir, name), path.join(dest, name));
    }
  }
  await writeFile(
    path.join(dest, 'meta.json'),
    JSON.stringify(
      {
        kind: 'github',
        repo,
        number: pr.number,
        url: pr.url,
        pr_title: pr.title,
        head_oid: pr.headRefOid || null,
        base_oid: pr.baseRefOid || null,
        source: path.resolve(dir),
        published_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
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
    await writeFile(
      out,
      JSON.stringify(
        { found: false, reason, sessions: [], moments: [], files: {}, timeline: [] },
        null,
        2,
      ),
    );
    process.stderr.write(`No backstory: ${reason}\n`);
  };
  const cli = path.join(DSM, 'bridge/bin/diff-story.mjs');
  if (!existsSync(cli)) {
    return skip(`Diff Story Mode isn't at ${DSM}`);
  }
  let repo = opts.repo;
  if (!repo && existsSync(path.join(dir, 'checkouts.txt'))) {
    repo = ((await readFile(path.join(dir, 'checkouts.txt'), 'utf8')).split('\n')[0] || '').split(
      '\t',
    )[1];
  }
  if (!repo) {
    return skip('no local checkout of the repo');
  }
  const has = (oid) => {
    try {
      execFileSync('git', ['-C', repo, 'cat-file', '-e', `${oid}^{commit}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!has(pr.baseRefOid) || !has(pr.headRefOid)) {
    return skip(
      `the PR's commits aren't in ${repo} (fetch the head into refs/tmp/pr-${pr.number} first if they were made here)`,
    );
  }
  const brief = execFileSync(
    'node',
    [
      cli,
      'backstory',
      '--repo',
      repo,
      '--base',
      pr.baseRefOid,
      '--head',
      pr.headRefOid,
      '-o',
      out,
      '--brief',
      ...(opts['exclude-agent'] ? ['--exclude-agent', opts['exclude-agent']] : []),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  await writeFile(path.join(dir, 'backstory-brief.json'), brief);
  process.stderr.write(`Brief: ${path.join(dir, 'backstory-brief.json')}\n`);
}

/** Viewed-files check at a chapter break: what should be ticked by now. */
async function cmdViewed(opts) {
  const dir = opts.dir;
  const map = await readJson(path.join(dir, 'file-map.json'));
  if (opts.refresh) {
    const pr = await readJson(path.join(dir, 'pr.json'));
    const tsv = execFileSync(path.join(HERE, 'viewed.sh'), [String(pr.number), repoOf(pr)], {
      encoding: 'utf8',
    });
    await writeFile(path.join(dir, 'viewed.tsv'), tsv);
  }
  const viewed = await readViewed(dir);
  const through = Number(opts.through);
  const rels = Object.keys(map.files);
  const isViewed = (rel) => viewed.get(rel) === 'VIEWED';
  const due = rels.filter(
    (rel) => map.files[rel].finished_in !== null && map.files[rel].finished_in <= through,
  );
  const result = {
    through_chapter: through,
    viewed: rels.filter(isViewed).length,
    total: rels.length,
    missed: due
      .filter((rel) => !isViewed(rel))
      .map((rel) => ({
        rel,
        finished_in: map.files[rel].finished_in,
        state: viewed.get(rel) || 'UNKNOWN',
      })),
    held_partials: rels
      .filter(
        (rel) =>
          map.files[rel].chapters.some((chapterNumber) => chapterNumber <= through) &&
          map.files[rel].finished_in > through,
      )
      .map((rel) => ({ rel, finished_in: map.files[rel].finished_in, viewed: isViewed(rel) })),
    ahead: rels
      .filter(
        (rel) =>
          isViewed(rel) &&
          map.files[rel].finished_in > through &&
          !map.files[rel].chapters.some((chapterNumber) => chapterNumber <= through),
      )
      .map((rel) => ({ rel, finished_in: map.files[rel].finished_in })),
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

async function chapterOf(dir, step) {
  const plan = await readJson(path.join(dir, 'chapters.json'));
  const chapter = plan.chapters[step - 1];
  if (!chapter) {
    throw new Error(`no chapter ${step}`);
  }
  return { plan, ch: chapter };
}

/** GitHub mode: where to point the browser for chapter N. Prints only. */
async function cmdLinks(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const step = Number(opts.chapter);
  const { ch: chapter } = await chapterOf(dir, step);
  const view = opts.view === 'files' ? 'files' : 'changes';
  const links = (chapter.files || [])
    .map(entryOf)
    .map((e) => ({ rel: e.rel, partial: e.partial, url: fileUrl(pr.url, e.rel, view) }));
  process.stdout.write(
    JSON.stringify(
      { chapter: step, title: chapter.title, tab: `${pr.url}/${view}`, links },
      null,
      2,
    ) + '\n',
  );
}

/**
 * A chapter brief for another Claude session (the Chrome side panel, or a
 * fresh terminal): the story map, this chapter's text, its files and the
 * drafted comments. Writes D/chapter-N.md and prints the path.
 */
async function cmdHandoff(opts) {
  const dir = opts.dir;
  const pr = await readJson(path.join(dir, 'pr.json'));
  const step = Number(opts.chapter);
  const { plan, ch: chapter } = await chapterOf(dir, step);
  const map = plan.chapters
    .map(
      (other, i) =>
        `${i + 1}. ${other.title.replace(/^Chapter \d+: /, '')}${i + 1 === step ? ' (this chapter)' : ''}`,
    )
    .join('\n');
  const files = (chapter.files || [])
    .map(entryOf)
    .map((e) => `- ${e.rel}${e.partial ? ' (partly, finished later)' : ''}`)
    .join('\n');
  const markdown = [
    `# ${pr.title} (${repoOf(pr)}#${pr.number})`,
    '',
    `${pr.url}`,
    '',
    'You are helping a reviewer walk through this PR as a story. Answer questions about this chapter from the diff on the page. Do not click Viewed, comment, approve or submit anything.',
    '',
    '## Story map',
    map,
    '',
    (chapter.narrative || '').startsWith('#') ? '' : `## ${chapter.title}`,
    chapter.scenario ? `Scenario: ${chapter.scenario}` : '',
    '',
    chapter.narrative || chapter.summary || '',
    '',
    '## Files in this chapter',
    files,
    '',
  ].join('\n');
  const out = path.join(dir, `chapter-${step}.md`);
  await writeFile(out, markdown);
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
    overview: plan.overview || '',
    summary: plan.summary || '',
    plan: plan.plan || '',
    files: [...diff.keys()].map((rel) => ({ rel, sha: sha(rel) })),
    chapters: (plan.chapters || []).map((chapter) => ({
      title: chapter.title,
      headline: chapter.headline || '',
      scenario: chapter.scenario || '',
      summary: chapter.summary || '',
      narrative: chapter.narrative || '',
      files: (chapter.files || []).map(entryOf),
      comments: (chapter.comments || []).map((comment) => ({
        path: comment.path || '',
        line: comment.line || 0,
        body: comment.body || '',
      })),
    })),
  };
  if (!(data.start >= 0 && data.start <= data.chapters.length)) {
    throw new Error(`no chapter ${opts.chapter} (0 or overview is the Overview step)`);
  }
  const src = await readFile(path.join(HERE, 'overlay.js'), 'utf8');
  const snippet = `${src}\nprStoryOverlay(${JSON.stringify(data)});\n`;
  if (opts.out) {
    await writeFile(opts.out, snippet);
    process.stdout.write(opts.out + '\n');
  } else {
    process.stdout.write(snippet);
  }
}

const COMMANDS = {
  brief: cmdBrief,
  build: cmdBuild,
  render: cmdRender,
  viewed: cmdViewed,
  links: cmdLinks,
  handoff: cmdHandoff,
  overlay: cmdOverlay,
  publish: cmdPublish,
  backstory: cmdBackstory,
};
const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command];
if (!run || !opts.dir) {
  process.stderr.write(
    'usage: pr-story.mjs <brief|build|render|viewed|links|handoff|overlay|publish|backstory> --dir <scratch-dir> [--open] [--no-bridge] [--through N] [--refresh] [--chapter N] [--view files|changes] [--out FILE]\n',
  );
  process.exitCode = 1;
} else {
  run(opts).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
