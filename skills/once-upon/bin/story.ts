/**
 * once-upon: a pull request told as a story, chapter by chapter, for Once Upon a Diff's panel.
 *
 * Works on a folder that bin/gather.sh filled (pr.json, pr.diff,
 * threads.json, checks.json, viewed.tsv). It makes no network calls.
 *
 *   story.ts brief   --dir D                 what Claude reads to plan: files, commits, reviews, threads, CI, viewed
 *   story.ts build   --dir D [--no-bridge]   D/chapters.json -> D/file-map.json, then publish; fails if a file is
 *                                             unplaced or a hunk is told by no chapter (--allow-uncovered publishes anyway)
 *   story.ts publish --dir D                 publish the story for Once Upon a Diff through `once-upon publish` (build does this too)
 *   story.ts slice   --dir D --chapter K     what one chapter's writer reads: map, neighbours, key points (D/points.json), numbered diff
 *   story.ts merge   --dir D                 lay D/fragments/*.json (one per chapter) onto D/chapters.json; never publishes (--clear: delete them instead)
 *                                             slice and merge read D/pr.diff, or --diff F, or a local story's --repo R --base B --head H
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// This skill ships in the Once Upon a Diff repo (skills/once-upon/bin), and Node resolves the skill link, so it
// imports the bridge's and the panel's own helpers from the checkout it's linked from.
import { parseArgs } from '../../../packages/bridge/src/cli/args.ts';
import { diffText } from '../../../packages/bridge/src/adapters/git.ts';
import { parseUnifiedDiff } from '../../../packages/bridge/src/services/stories/diff.ts';
import { writeJsonAtomic } from '../../../packages/bridge/src/adapters/stores/json-file.ts';
import { chaptersOf } from '../../../packages/bridge/src/services/stories/chapters.ts';
import {
  mergeFragments,
  sliceOf,
  type Points,
} from '../../../packages/bridge/src/services/stories/fragments.ts';
import {
  addTextRefs,
  ambiguousRefsOf,
  textOf,
} from '../../../packages/bridge/src/services/stories/text-refs.ts';
import {
  uncoveredHunks,
  SMALL_FILE_LINES,
} from '../../../packages/bridge/src/services/stories/hunk-coverage.ts';
import { finishedInOf } from '../../../packages/shared/src/util/story-model.ts';

import type { DiffFile, UncoveredFile } from '../../../packages/shared/src/types.ts';
import type { Plan } from '../../../packages/bridge/src/services/stories/chapters.ts';
import type { CliOpts } from '../../../packages/bridge/src/cli/types.ts';

/** pr.json, from `gh pr view --json` in gather.sh: just what's read here. */
interface PrJson {
  url?: string;
  number: number;
  title?: string;
  author?: { login?: string } | null;
  baseRefName?: string;
  headRefName?: string;
  baseRefOid?: string;
  headRefOid?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeStateStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  body?: string;
  reviewRequests?: { login?: string; name?: string; slug?: string }[];
  commits?: { oid: string; committedDate: string; messageHeadline: string; messageBody: string }[];
  reviews?: {
    author?: { login?: string } | null;
    state: string;
    submittedAt: string;
    body: string;
  }[];
}

/** threads.json, from gather.sh. */
interface Thread {
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  posts: { by: string; at: string; body: string }[];
}

/** checks.json, from `gh pr checks --json`. */
interface Check {
  name: string;
  bucket: string;
  link?: string;
}

/** One file's line in file-map.json. */
interface MapFile {
  chapters: number[];
  partial_in: number[];
  finished_in: number | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

async function readJson<T>(file: string, fallback?: T): Promise<T> {
  if (!existsSync(file)) {
    return fallback as T;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readViewed(dir: string): Promise<Map<string, string>> {
  const file = path.join(dir, 'viewed.tsv');
  const out = new Map<string, string>();
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

async function load(dir: string) {
  const pr = await readJson<PrJson>(path.join(dir, 'pr.json'));
  const diff = parseUnifiedDiff(await readFile(path.join(dir, 'pr.diff'), 'utf8'));
  const threads = await readJson<Thread[]>(path.join(dir, 'threads.json'), []);
  const checks = await readJson<Check[]>(path.join(dir, 'checks.json'), []);
  const viewed = await readViewed(dir);
  return { pr, diff, threads, checks, viewed };
}

const repoOf = (pr: PrJson) => (pr.url || '').split('/').slice(3, 5).join('/');
const clip = (text: string | undefined, max: number) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

async function cmdBrief(opts: CliOpts) {
  const { pr, diff, threads, checks, viewed } = await load(opts.dir as string);
  const byPath: Record<string, Thread[]> = {};
  for (const thread of threads) {
    (byPath[thread.path] ||= []).push(thread);
  }
  const checksByState: Record<string, number> = {};
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

/**
 * Where each file is told and finished, by the panel's own rules: a chapter tells a file by listing it or by pointing
 * at its lines in its text (packages/bridge/src/services/stories/text-refs.ts), and finishes it when it's the last chapter to tell it or
 * the newest "Since you read it" chapter that lists it (finishedInOf).
 */
function buildMap(plan: Plan, diff: Map<string, DiffFile>) {
  const rels = [...diff.keys()];
  const chapters = addTextRefs(chaptersOf(plan), rels);
  const finishedIn = finishedInOf(chapters);
  const files: Record<string, MapFile> = {};
  for (const rel of rels) {
    files[rel] = { chapters: [], partial_in: [], finished_in: finishedIn[rel] ?? null };
  }
  const problems: string[] = [];
  chapters.forEach((chapter, i) => {
    const step = i + 1;
    for (const entry of chapter.files) {
      const file = files[entry.rel];
      if (!file) {
        problems.push(`chapter ${step} names ${entry.rel}, which is not in the PR diff`);
        continue;
      }
      file.chapters.push(step);
      if (entry.partial) {
        file.partial_in.push(step);
      }
    }
  });
  chapters.forEach((chapter, i) => {
    const own = chapter.files.map((entry) => entry.rel);
    for (const { name, rels: fits } of ambiguousRefsOf(textOf(chapter), own)) {
      problems.push(
        `chapter ${i + 1} names \`${name}\`, which fits ${fits.join(' and ')}: write the full path`,
      );
    }
  });
  const missing = rels.filter((rel) => files[rel].chapters.length === 0);
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  const uncovered = uncoveredHunks(chapters, diff);
  const perChapter = chapters.map((chapter, i) => {
    const step = i + 1;
    return {
      n: step,
      title: chapter.title,
      finishes: chapter.files
        .filter((entry) => files[entry.rel]?.finished_in === step)
        .map((entry) => entry.rel),
      partial: chapter.files
        .filter((entry) => entry.partial)
        .map((entry) => ({ rel: entry.rel, finished_in: files[entry.rel]?.finished_in ?? null })),
      revisits: chapter.files
        .filter(
          (entry) => !entry.partial && files[entry.rel] && files[entry.rel].finished_in !== step,
        )
        .map((entry) => entry.rel),
    };
  });
  return { files, chapters: perChapter, problems, uncovered };
}

/** The build's report of hunks no chapter tells, with the ways to fix it. */
function hunksNotCovered(uncovered: UncoveredFile[]): string {
  const count = uncovered.reduce((sum, file) => sum + file.hunks.length, 0);
  const lines = uncovered.map((file) => `  - ${file.hunks.map((hunk) => hunk.ref).join(', ')}`);
  return [
    `hunks not covered: ${count} in ${uncovered.length} files (bigger than ${SMALL_FILE_LINES} changed lines) that no chapter points at`,
    ...lines,
    'Give the chapter that tells each one a `lines` range on it, a `path:N-M` reference in its narrative or a comment on it,',
    'or mark the file\'s entry "whole": true where one chapter tells all of it. --allow-uncovered publishes anyway.',
  ].join('\n');
}

async function cmdBuild(opts: CliOpts) {
  const dir = opts.dir as string;
  const { pr, diff } = await load(dir);
  const plan = await readJson<Plan>(
    (opts.chapters as string | undefined) || path.join(dir, 'chapters.json'),
  );
  const chapters = plan.chapters || [];
  const map = buildMap(plan, diff);
  if (map.problems.length && !opts['allow-missing']) {
    throw new Error(`file placement:\n  - ${map.problems.join('\n  - ')}`);
  }
  if (map.uncovered.length && !opts['allow-uncovered']) {
    throw new Error(hunksNotCovered(map.uncovered));
  }
  writeJsonAtomic(path.join(dir, 'file-map.json'), {
    pr: `${repoOf(pr)}#${pr.number}`,
    mode: plan.mode || 'journey',
    files: map.files,
    chapters: map.chapters,
    ...(map.uncovered.length ? { uncovered_hunks: map.uncovered } : {}),
  });
  const all = [...diff.values()];
  const placed =
    all.length - Object.values(map.files).filter((file) => !file.chapters.length).length;
  const partials = Object.values(map.files).filter((file) => file.partial_in.length).length;
  const hunks = all.reduce((sum, file) => sum + file.hunks.length, 0);
  const missed = map.uncovered.reduce((sum, file) => sum + file.hunks.length, 0);
  process.stderr.write(
    `Wrote file-map.json: ${chapters.length} chapters, ${all.length} files, ${placed} placed, ${partials} partial, ${hunks - missed} of ${hunks} hunks covered\n`,
  );
  if (missed) {
    process.stderr.write(`${hunksNotCovered(map.uncovered)}\n`);
  }
  if (!opts['no-bridge']) {
    await cmdPublish(opts);
  }
}

/**
 * The diff `slice` and `merge` read: `--diff <file>`, else a local story's range (`--repo <checkout> --base <ref> --head <ref>`,
 * made as the local flow makes its diff), else D/pr.diff.
 */
function diffOf(opts: CliOpts): ReturnType<typeof parseUnifiedDiff> {
  const dir = opts.dir as string;
  if (
    typeof opts.repo === 'string' &&
    typeof opts.base === 'string' &&
    typeof opts.head === 'string'
  ) {
    return parseUnifiedDiff(diffText(path.resolve(opts.repo), opts.base, opts.head));
  }
  const file = typeof opts.diff === 'string' ? path.resolve(opts.diff) : path.join(dir, 'pr.diff');
  if (!existsSync(file)) {
    throw new Error(
      `no diff to read: ${file} is missing. For a local story pass --repo <checkout> --base <ref> --head <branch> (or --diff <file>)`,
    );
  }
  return parseUnifiedDiff(readFileSync(file, 'utf8'));
}

/** The packet one chapter's writer reads (fragments.ts sliceOf): `--chapter` is the chapter's key or its number. */
async function cmdSlice(opts: CliOpts) {
  const dir = opts.dir as string;
  const diff = diffOf(opts);
  const plan = await readJson<Plan>(path.join(dir, 'chapters.json'));
  const points = await readJson<Points>(path.join(dir, 'points.json'), {});
  const which = typeof opts.chapter === 'string' ? opts.chapter : '';
  const text = which ? sliceOf(plan, which, diff, points) : null;
  if (text === null) {
    throw new Error(
      `slice needs --chapter <key or number> naming a chapter of ${dir}/chapters.json`,
    );
  }
  process.stdout.write(text + '\n');
}

/**
 * Lays the chapter writers' fragments (D/fragments/*.json) onto D/chapters.json, filling only chapters with no text yet
 * (fragments.ts). The file is read and written in one synchronous step, so it is the one writer of chapters.json while
 * it runs. It prints a line per fragment and exits 1 when any was refused. Publishing is a separate step: `build`,
 * or `once-upon local --chapters` for a local story.
 */
async function cmdMerge(opts: CliOpts) {
  const dir = opts.dir as string;
  const fragmentDir = path.join(dir, 'fragments');
  if (opts.clear) {
    // a new telling starts with no fragments, so none from an earlier one fills (or orphans) its chapters
    const old = existsSync(fragmentDir)
      ? readdirSync(fragmentDir).filter((name) => name.endsWith('.json'))
      : [];
    old.forEach((name) => unlinkSync(path.join(fragmentDir, name)));
    process.stderr.write(`cleared ${old.length} fragments\n`);
    return;
  }
  const diff = diffOf(opts);
  const names = existsSync(fragmentDir)
    ? readdirSync(fragmentDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const fragments = names.map((name) => {
    try {
      return JSON.parse(readFileSync(path.join(fragmentDir, name), 'utf8')) as unknown;
    } catch {
      return { __unreadable: name };
    }
  });
  const file = path.join(dir, 'chapters.json');
  const plan = JSON.parse(readFileSync(file, 'utf8')) as Plan;
  const { plan: merged, outcomes } = mergeFragments(plan, fragments, diff);
  if (outcomes.some((outcome) => outcome.status === 'merged')) {
    writeJsonAtomic(file, merged);
  }
  outcomes.forEach((outcome, i) => {
    const name = names[i] || '';
    process.stderr.write(
      `${outcome.status.padEnd(8)} ${name}${outcome.key ? ` (${outcome.key})` : ''}: ${outcome.why}\n`,
    );
  });
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected').length;
  const unwritten = (merged.chapters || []).filter(
    (chapter) => !String(chapter.narrative || '').trim() && !chapter.since,
  ).length;
  process.stderr.write(
    `${outcomes.filter((outcome) => outcome.status === 'merged').length} merged, ${rejected} refused, ${unwritten} chapters still without text\n`,
  );
  if (rejected) {
    process.exitCode = 1;
  }
}

/**
 * Once Upon a Diff: hand the folder to `once-upon publish`, which copies
 * chapters.json and file-map.json, with a meta.json naming the PR and the
 * commits it was told from, to where the bridge serves it (the repo's
 * checkout when it knows one, else ONCE_UPON_HOME). The extension then shows
 * the panel on the PR page by itself, and picks up each rebuild within a few
 * seconds. It also prints the story id, and the line that makes this session
 * the story's own listener. While the panel's Rebuild is pending for the story,
 * publish refuses chapters that change the ones it keeps or leave a file or
 * hunk untold, and keeps the drafts the new chapters dropped (packages/bridge/src/services/stories/rebuild.ts).
 */
async function cmdPublish(opts: CliOpts) {
  const dest = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'packages/bridge/bin/once-upon.mjs'),
      'publish',
      '--dir',
      path.resolve(opts.dir as string),
      ...(opts['allow-uncovered'] ? ['--allow-uncovered'] : []),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
  process.stderr.write(`Once Upon a Diff: ${dest}\n`);
  // this session can keep answering the story's questions, ahead of the repo's listener
  process.stderr.write(
    `Story ${path.basename(dest)}. To answer its panel questions from this session: /once-upon-listen --story ${path.basename(dest)}\n`,
  );
}

const COMMANDS: Record<string, (opts: CliOpts) => Promise<void>> = {
  brief: cmdBrief,
  build: cmdBuild,
  publish: cmdPublish,
  slice: cmdSlice,
  merge: cmdMerge,
};
const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command as string];
if (!run || !opts.dir) {
  process.stderr.write(
    'usage: story.ts <brief|build|publish|slice|merge> --dir <scratch-dir> [--no-bridge] [--allow-uncovered] [--chapter <key|n>] [--clear] [--diff <file> | --repo <dir> --base <ref> --head <ref>]\n',
  );
  process.exitCode = 1;
} else {
  run(opts).catch((err: Error) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
