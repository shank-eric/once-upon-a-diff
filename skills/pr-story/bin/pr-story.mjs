/**
 * pr-story: a pull request told as a story, chapter by chapter, for Diff
 * Story Mode's panel.
 *
 * Works on a folder that bin/gather.sh filled (pr.json, pr.diff,
 * threads.json, checks.json, viewed.tsv). It makes no network calls.
 *
 *   pr-story.mjs brief   --dir D                 what Claude reads to plan: files, commits, reviews, threads, CI, viewed
 *   pr-story.mjs build   --dir D [--no-bridge]   D/chapters.json -> D/file-map.json, then publish; fails if a file is unplaced
 *   pr-story.mjs overlay --dir D [--chapter N] [--out FILE]   JS snippet: story panel + chapter filter on the PR page (GitHub mode); no --chapter starts at the Overview
 *   pr-story.mjs publish --dir D                 publish the story for Diff Story Mode through `diff-story publish` (build does this too)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

/** Unified diff -> Map(rel -> {rel, hunks, stats, kind, renamed_from?}). */
export function parseUnifiedDiff(text) {
  const files = new Map();
  /** @type {{rel: string, hunks: object[], stats: {added: number, removed: number}, kind: string, renamed_from?: string} | null} */
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

async function cmdBuild(opts) {
  const dir = opts.dir;
  const { pr, diff } = await load(dir);
  const plan = await readJson(opts.chapters || path.join(dir, 'chapters.json'));
  const chapters = plan.chapters || [];
  const map = buildMap(chapters, diff);
  if (map.problems.length && !opts['allow-missing']) {
    throw new Error(`file placement:\n  - ${map.problems.join('\n  - ')}`);
  }
  await writeFile(
    path.join(dir, 'file-map.json'),
    JSON.stringify(
      {
        pr: `${repoOf(pr)}#${pr.number}`,
        mode: plan.mode || 'journey',
        files: map.files,
        chapters: map.chapters,
      },
      null,
      2,
    ),
  );
  const all = [...diff.values()];
  const placed =
    all.length - Object.values(map.files).filter((file) => !file.chapters.length).length;
  const partials = Object.values(map.files).filter((file) => file.partial_in.length).length;
  process.stderr.write(
    `Wrote file-map.json: ${chapters.length} chapters, ${all.length} files, ${placed} placed, ${partials} partial\n`,
  );
  if (!opts['no-bridge']) {
    await cmdPublish(opts);
  }
}

/**
 * Diff Story Mode: hand the folder to `diff-story publish`, which copies
 * chapters.json and file-map.json, with a meta.json naming the PR and the
 * commits it was told from, to where the bridge serves it (the repo's
 * checkout when it knows one, else DIFF_STORY_HOME). The extension then shows
 * the panel on the PR page by itself, and picks up each rebuild within a few
 * seconds.
 */
async function cmdPublish(opts) {
  const dest = execFileSync(
    process.execPath,
    [path.join(DSM, 'bridge/bin/diff-story.mjs'), 'publish', '--dir', path.resolve(opts.dir)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
  process.stderr.write(`Diff Story Mode: ${dest}\n`);
}

/**
 * GitHub "Files changed" anchors are diff- + sha256 of the file path. `view`
 * is the PR tab: "files" (classic) or "changes" (the newer review UI).
 */
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
  overlay: cmdOverlay,
  publish: cmdPublish,
};
const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command];
if (!run || !opts.dir) {
  process.stderr.write(
    'usage: pr-story.mjs <brief|build|overlay|publish> --dir <scratch-dir> [--no-bridge] [--chapter N] [--out FILE]\n',
  );
  process.exitCode = 1;
} else {
  run(opts).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
