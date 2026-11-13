/**
 * once-upon: a pull request told as a story, chapter by chapter, for Once Upon a Diff's panel.
 *
 * Works on a folder that bin/gather.sh filled (pr.json, pr.diff,
 * threads.json, checks.json, viewed.tsv). It makes no network calls.
 *
 *   story.ts brief   --dir D                 what Claude reads to plan: files, commits, reviews, threads, CI, viewed, and each hunk's id
 *                                             (also written to D/hunks.txt, the numbered diff); a local story passes --repo R --base B --head H
 *                                             in place of pr.json. A chapter says `"hunks": ["h7"]` and build makes refs of the ids
 *   story.ts build   --dir D [--no-bridge] [--agent NAME]   D/chapters.json -> D/file-map.json, then publish; gives each chapter a key
 *                                             (written back to D/chapters.json); fails if a file is unplaced, a chapter
 *                                             has no refs list, a ref or comment is wrong, or a hunk is told by no
 *                                             chapter (--allow-uncovered publishes anyway)
 *   story.ts check   --dir D [--chapters F] [--final]   the story's quality findings (packages/server-libs/stories/src/quality.ts), one per line; exit 1 on any `fail`.
 *                                             A chapter with no narrative is counted as still being written, not failed, until --final.
 *                                             Works on a built story, published or not; build prints the same as a summary
 *   story.ts publish --dir D [--agent NAME]    publish the story for Once Upon a Diff through `once-upon publish` (build does this too)
 *   story.ts slice   --dir D --chapter K     what one chapter's writer reads: map, neighbours, key points (D/points.json), numbered diff
 *   story.ts merge   --dir D                 lay D/fragments/*.json (one per chapter) onto D/chapters.json; never publishes (--clear: delete them instead)
 *                                             Every command appends its time to D/timings.jsonl
 *                                             slice and merge read D/pr.diff, or --diff F, or a local story's --repo R --base B --head H
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// This skill ships in the Once Upon a Diff repo (skills/once-upon/bin), and Node resolves the skill link, so it
// imports the bridge's and the panel's own helpers from the checkout it's linked from.
import { parseArgs } from '../../../packages/server/cli/src/args.ts';
import {
  commitsBetween,
  diffText,
  revParse,
} from '../../../packages/server-libs/adapters/src/git.ts';
import { parseUnifiedDiff } from '../../../packages/server-libs/stories/src/diff.ts';
import { chaptersOf } from '../../../packages/server-libs/stories/src/chapters.ts';
import {
  mergeFragments,
  numberedHunk,
  sliceOf,
  type Points,
} from '../../../packages/server-libs/stories/src/fragments.ts';
import {
  findingsReport,
  findingsSummary,
  hasFails,
} from '../../../packages/server-libs/stories/src/story-report.ts';
import { storyFindings, type Finding } from '../../../packages/server-libs/stories/src/quality.ts';
import { partialProblems } from '../../../packages/server-libs/stories/src/gate.ts';
import { lintTextRefs } from '../../../packages/server-libs/stories/src/text-refs.ts';
import { upgradePlan } from '../../../packages/server-libs/stories/src/legacy.ts';
import {
  assignKeys,
  chapterProblems,
  keptChapters,
} from '../../../packages/server-libs/stories/src/validate.ts';
import { StoryStore } from '../../../packages/server-libs/stories/src/store.ts';
import { homeDir } from '../../../packages/server-libs/foundation/src/settings.ts';
import { storyIdForPr } from '../../../packages/domain/terms/src/ids.ts';
import {
  expandHunks,
  hunkIdsOf,
  type HunkEntry,
} from '../../../packages/server-libs/stories/src/hunk-ids.ts';
import {
  LOCKFILES,
  thinHunks,
  uncoveredHunks,
  SMALL_FILE_LINES,
} from '../../../packages/server-libs/stories/src/hunk-coverage.ts';
import { noteTiming, type TimingExtra } from '../../../packages/server-libs/stories/src/timings.ts';
import {
  writeFileAtomic,
  writeJsonAtomic,
} from '../../../packages/server-libs/adapters/src/stores/fs/json-file.ts';
import { finishedInOf } from '../../../packages/domain/terms/src/chapters.ts';

import type {
  DiffFile,
  DiffHunk,
  UncoveredFile,
} from '../../../packages/domain/contracts/src/types.ts';
import type { Plan } from '../../../packages/server-libs/stories/src/chapters.ts';
import type { CliOpts } from '../../../packages/server/cli/src/types.ts';

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

/** What the timings line of the running command adds (see noteTiming); the commands fill it. */
const extra: TimingExtra = {};

const changedLines = (hunk: DiffHunk) => ({
  added: hunk.lines.filter((line) => line.startsWith('+')).length,
  removed: hunk.lines.filter((line) => line.startsWith('-')).length,
});

/** The hunks of a diff for the brief: [{id, path, side, start, end, added, removed, header}], and ids by file. */
function hunkList(diff: ReturnType<typeof parseUnifiedDiff>) {
  const entries = hunkIdsOf(diff);
  const hunks = entries.map((entry) => ({
    id: entry.id,
    path: entry.rel,
    side: entry.side,
    start: entry.start,
    end: entry.end,
    ...changedLines(entry.hunk),
    header: entry.hunk.header,
  }));
  const idsOf = (rel: string) =>
    entries.filter((entry) => entry.rel === rel).map((entry) => entry.id);
  return { entries, hunks, idsOf };
}

/**
 * hunks.txt: the diff as the storyteller reads it, one block per hunk under its id with the line numbers to cite (R new
 * side, L old side). A deleted file or a lockfile needs no refs (listing it covers it), so it prints only its header.
 */
function hunksText(diff: ReturnType<typeof parseUnifiedDiff>, entries: HunkEntry[]): string {
  const out: string[] = [
    'Hunk ids for chapters.json: a chapter lists `"hunks": ["h7", "h8"]` and each id becomes a ref on that hunk (the file must be in the chapter\'s `files`).',
    '',
  ];
  for (const file of diff.values()) {
    const own = entries.filter((entry) => entry.rel === file.rel);
    const head = `### ${file.rel} (${file.binary ? 'binary' : file.kind}, +${file.stats.added} -${file.stats.removed})`;
    if (file.binary || !own.length) {
      out.push(head, '');
    } else if (file.kind === 'deleted' || LOCKFILES.test(file.rel)) {
      out.push(
        `${head} ${own[0].id}-${own[own.length - 1].id}: listing the file covers it, no refs needed`,
        '',
      );
    } else {
      out.push(head);
      for (const entry of own) {
        const { added, removed } = changedLines(entry.hunk);
        out.push(
          `## ${entry.id}  ${entry.side}${entry.start}-${entry.end}  +${added} -${removed}  ${entry.hunk.header}`.trimEnd(),
          ...numberedHunk(entry.hunk),
        );
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * The brief of a local story (no pr.json): `--repo <checkout> --base <ref> --head <ref>`, the range `once-upon local`
 * tells. The commits and the diff are the range's, as the local flow makes them.
 */
function localBrief(opts: CliOpts) {
  const repo = path.resolve(opts.repo as string);
  const baseOid = revParse(repo, opts.base as string);
  const headOid = revParse(repo, opts.head as string);
  if (!baseOid || !headOid) {
    throw new Error(`can't resolve ${opts.base}..${opts.head} in ${repo}`);
  }
  return {
    diff: parseUnifiedDiff(diffText(repo, baseOid, headOid)),
    local: {
      repo,
      base: opts.base,
      head: opts.head,
      base_oid: baseOid,
      head_oid: headOid,
      title: `${path.basename(repo)}: ${opts.base}..${opts.head}`,
    },
    commits: commitsBetween(repo, baseOid, headOid).map((commit) => ({
      sha: commit.sha.slice(0, 9),
      at: commit.at,
      subject: commit.subject,
    })),
  };
}

async function cmdBrief(opts: CliOpts) {
  const dir = opts.dir as string;
  if (
    !existsSync(path.join(dir, 'pr.json')) &&
    !(
      typeof opts.repo === 'string' &&
      typeof opts.base === 'string' &&
      typeof opts.head === 'string'
    )
  ) {
    throw new Error(
      `no pr.json in ${dir}: for a local story pass --repo <checkout> --base <ref> --head <ref>`,
    );
  }
  if (!existsSync(path.join(dir, 'pr.json'))) {
    const local = localBrief(opts);
    const { entries, hunks, idsOf } = hunkList(local.diff);
    writeFileAtomic(path.join(dir, 'hunks.txt'), hunksText(local.diff, entries));
    extra.hunks = hunks.length;
    const files = [...local.diff.values()];
    process.stdout.write(
      `${JSON.stringify(
        {
          local: local.local,
          totals: {
            files: files.length,
            added: files.reduce((sum, file) => sum + file.stats.added, 0),
            removed: files.reduce((sum, file) => sum + file.stats.removed, 0),
          },
          files: files.map((file) => ({
            rel: file.rel,
            kind: file.kind,
            stats: file.stats,
            hunks: idsOf(file.rel),
          })),
          commits: local.commits,
          hunks,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const { pr, diff, threads, checks, viewed } = await load(dir);
  const { entries, hunks, idsOf } = hunkList(diff);
  writeFileAtomic(path.join(dir, 'hunks.txt'), hunksText(diff, entries));
  extra.hunks = hunks.length;
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
      hunks: idsOf(file.rel),
    })),
    hunks,
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
 * Where each file is told and finished, by the panel's own rules: a chapter tells a file by listing it, and finishes it
 * when it's the last chapter to list it or the newest "Since you read it" chapter that lists it (finishedInOf). Pointing
 * at a file's lines is a ref (`refs`), which needs the file listed: it moves nothing. A chapter an older story kept
 * as it was is read as it is on the panel (legacy.ts).
 */
function buildMap(plan: Plan, diff: Map<string, DiffFile>, served?: Plan | null) {
  const rels = [...diff.keys()];
  const chapters = chaptersOf(upgradePlan(plan, rels));
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
  const missing = rels.filter((rel) => files[rel].chapters.length === 0);
  if (missing.length) {
    problems.push(`${missing.length} files are in no chapter: ${missing.join(', ')}`);
  }
  problems.push(...partialProblems(chapters, diff));
  // a chapter left as it was published counts every ref, as the rebuild's vet does
  const kept = keptChapters(plan, served);
  const uncovered = uncoveredHunks(chapters, diff, { linked: true, kept });
  const thin = thinHunks(chapters, diff, { linked: true, kept });
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
  return { files, chapters: perChapter, problems, uncovered, thin };
}

/** The build's report of hunks no chapter tells, with the ways to fix it. */
function hunksNotCovered(uncovered: UncoveredFile[]): string {
  const count = uncovered.reduce((sum, file) => sum + file.hunks.length, 0);
  const lines = uncovered.map((file) => `  - ${file.hunks.map((hunk) => hunk.ref).join(', ')}`);
  return [
    `hunks not covered: ${count} in ${uncovered.length} files (bigger than ${SMALL_FILE_LINES} changed lines) that no chapter points at`,
    ...lines,
    "Give the chapter that tells each one a ref on it (`refs`: {id, path, side, start, end}) and link it in the chapter's text ([text](ref:id): a ref the text never links counts for nothing) or a comment on it,",
    'or mark the file\'s entry "whole": true where one chapter tells all of it. --allow-uncovered publishes anyway.',
  ].join('\n');
}

/**
 * The chapters.json the bridge already serves for the PR in `dir` (its pr.json), whose unchanged chapters a telling may
 * leave as they are; null for a story not published yet, a local story, or when `dir` is the served folder itself.
 */
async function servedPlan(dir: string, given?: PrJson): Promise<Plan | null> {
  const pr = given || (await readJson<PrJson | null>(path.join(dir, 'pr.json'), null));
  const repo = pr ? repoOf(pr) : '';
  if (!pr || !repo || !pr.number) {
    return null;
  }
  const served = new StoryStore({ home: homeDir() }).dirOf(storyIdForPr(repo, pr.number));
  if (!served || path.resolve(served) === path.resolve(dir)) {
    return null;
  }
  return readJson<Plan | null>(path.join(served, 'chapters.json'), null);
}

async function cmdBuild(opts: CliOpts) {
  const dir = opts.dir as string;
  const { pr, diff } = await load(dir);
  const plan = await readJson<Plan>(
    (opts.chapters as string | undefined) || path.join(dir, 'chapters.json'),
  );
  const chapters = plan.chapters || [];
  // every chapter gets its key now, and keeps it: the bridge assigns what is missing, and it is written back here
  const keyed = assignKeys(plan);
  if (keyed.length) {
    writeJsonAtomic((opts.chapters as string | undefined) || path.join(dir, 'chapters.json'), plan);
    process.stderr.write(`Gave ${keyed.length} chapters a key: ${keyed.join(', ')}\n`);
  }
  // a chapter's `hunks` ids become refs on those hunks, written back (before the checks below read refs)
  const hunked = expandHunks(plan, diff);
  if (hunked.problems.length) {
    throw new Error(`hunks:\n  - ${hunked.problems.join('\n  - ')}`);
  }
  extra.expanded = hunked.expanded;
  if (hunked.expanded) {
    writeJsonAtomic((opts.chapters as string | undefined) || path.join(dir, 'chapters.json'), plan);
    process.stderr.write(`Expanded ${hunked.expanded} hunk ids into refs\n`);
  }
  const served = await servedPlan(dir, pr);
  if (opts['no-bridge']) {
    // the bridge checks the plan itself when it publishes, against what it published before; this is the same check without that
    const refused = chapterProblems(plan, { diff, served });
    if (refused.length && !opts['allow-missing']) {
      throw new Error(`chapters:\n  - ${refused.join('\n  - ')}`);
    }
  }
  for (const warning of lintTextRefs(plan)) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  const map = buildMap(plan, diff, served);
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
    ...(map.thin.length ? { thin_hunks: map.thin.length } : {}),
  });
  const all = [...diff.values()];
  const placed =
    all.length - Object.values(map.files).filter((file) => !file.chapters.length).length;
  const partials = Object.values(map.files).filter((file) => file.partial_in.length).length;
  const hunks = all.reduce((sum, file) => sum + file.hunks.length, 0);
  extra.chapters = chapters.length;
  extra.hunks = hunks;
  const missed = map.uncovered.reduce((sum, file) => sum + file.hunks.length, 0);
  process.stderr.write(
    `Wrote file-map.json: ${chapters.length} chapters, ${all.length} files, ${placed} placed, ${partials} partial, ${hunks - missed} of ${hunks} hunks covered${map.thin.length ? `, ${map.thin.length} told thinly` : ''}\n`,
  );
  if (missed) {
    process.stderr.write(`${hunksNotCovered(map.uncovered)}\n`);
  }
  if (!opts['no-bridge']) {
    await cmdPublish(opts);
  }
  // the quality rules the gate does not refuse; the exit status is the gate's alone
  for (const line of findingsSummary(() => countedFindings(storyFindings(plan, diff, served)))) {
    process.stderr.write(`${line}\n`);
  }
}

/** The findings, with their counts noted for the timings line. */
function countedFindings(findings: Finding[]): Finding[] {
  const fails = findings.filter((finding) => finding.level === 'fail').length;
  extra.fails = fails;
  extra.warns = findings.length - fails;
  return findings;
}

/** The story's quality findings, one per line on stdout; exits 1 when any is a `fail`, 0 for warnings or none. */
async function cmdCheck(opts: CliOpts) {
  const plan = await readJson<Plan>(
    (opts.chapters as string | undefined) || path.join(opts.dir as string, 'chapters.json'),
  );
  if (!plan) {
    throw new Error(`no chapters.json to check in ${opts.dir}`);
  }
  const served = await servedPlan(opts.dir as string);
  const findings = countedFindings(storyFindings(plan, diffOf(opts), served));
  const final = opts.final === true;
  process.stdout.write(`${findingsReport(findings, final).join('\n')}\n`);
  if (hasFails(findings, final)) {
    process.exitCode = 1;
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
  // a published local story keeps its own diff as local.diff
  const stored = existsSync(path.join(dir, 'pr.diff')) ? 'pr.diff' : 'local.diff';
  const file =
    typeof opts.diff === 'string'
      ? path.resolve(opts.diff)
      : path.join(dir, existsSync(path.join(dir, stored)) ? stored : 'pr.diff');
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
 * hunk untold, and keeps the drafts the new chapters dropped (packages/server-libs/stories/src/rebuild.ts).
 */
async function cmdPublish(opts: CliOpts) {
  const dest = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'packages/server/bridge/bin/once-upon.mjs'),
      'publish',
      '--dir',
      path.resolve(opts.dir as string),
      ...(opts['allow-uncovered'] ? ['--allow-uncovered'] : []),
      // an author's story stays bound to it through every chapter's build (a publish without --agent drops the binding)
      ...(typeof opts.agent === 'string' ? ['--agent', opts.agent] : []),
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
  check: cmdCheck,
  publish: cmdPublish,
  slice: cmdSlice,
  merge: cmdMerge,
};
const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command as string];
if (!run || !opts.dir) {
  process.stderr.write(
    'usage: story.ts <brief|build|check|publish|slice|merge> --dir <scratch-dir> [--no-bridge] [--allow-uncovered] [--agent <name>] [--chapter <key|n>] [--clear] [--final] [--diff <file> | --repo <dir> --base <ref> --head <ref>]\n',
  );
  process.exitCode = 1;
} else {
  const started = performance.now();
  let threw = false;
  run(opts)
    .catch((err: Error) => {
      threw = true;
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      // how long the command took, next to the story's files (a command that exits 1 without throwing is failed too)
      noteTiming(opts.dir as string, {
        command: command as string,
        ms: performance.now() - started,
        ...extra,
        ...(threw || process.exitCode === 1 ? { failed: true } : {}),
      });
    });
}
