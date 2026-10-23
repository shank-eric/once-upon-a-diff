/**
 * Build requests: "there's no story for this PR yet, please write one", "bring
 * it up to the PR's latest commit" (mode 'update'), and "tell it again"
 * (mode 'rebuild', or 'rebuild_from' with from_step: ../stories/rebuild.ts).
 *
 * The extension's Build story button posts {repo, number, url, requested_at}.
 * The bridge keeps the request in <home>/builds.json, the one record of it:
 * `once-upon wait` hands queued ones to a Claude session as `build_request`
 * entries, and every tab on that PR shows Queued or Building. A request is
 * finished by its story turning up (`once-upon publish`, or a status call
 * that notices the story), or by `once-upon done <id>`. A rebuild is finished
 * only by publishing the story again (publish, or `once-upon local` for a
 * local story), since the story was there all along.
 *
 * A PR has one request at a time (key owner/repo#N), whatever its mode. A local
 * story's rebuild is keyed by the story (story:<id>). A rebuild goes to the
 * story's own listener (`wait --story`) while one that takes build requests is
 * live, else to the repo's, as its questions do.
 */
import path from 'node:path';
import { newId } from './inbox.ts';
import { sameRepo, REPO_RE } from '../config/repos.ts';
import { SHA_RE, plural, shortSha } from '@once-upon-a-diff/shared/util/text';
import { prKey } from '@once-upon-a-diff/shared/util/github-paths';
import { readerOf } from '../config/settings.ts';
import { readJson, writeJson } from '../util/json-file.ts';
import { listeners } from '../listeners/listeners.ts';
import { ID_RE } from '../stories/meta.ts';
import { isRebuild, REBUILD_MODES } from '../stories/rebuild.ts';
import type { Listener } from '../listeners/listeners.ts';
import type { StoryMeta } from '../types.ts';

/** A chapter read before an update was asked for: where the reviewer's reading stopped. */
export interface BuildRead {
  chapter: string;
  title: string | null;
  sha: string | null;
  at: string;
}

/** A build request, as builds.json keeps it (one per PR, or per local story for a rebuild). */
export interface Build {
  id: string;
  repo?: string | null;
  number: number | null;
  url: string | null;
  requested_at: string;
  status: 'pending' | 'done' | 'failed';
  mode?: 'update' | 'rebuild' | 'rebuild_from';
  // an update
  base_sha?: string;
  retell?: boolean;
  since_sha?: string;
  since_source?: string | null;
  reads?: BuildRead[];
  story?: string | null;
  // a rebuild
  kind?: 'github' | 'local';
  from_step?: number;
  guidance?: string;
  told_from?: string | null;
  story_dir?: string | null;
  local?: { repo_path?: string; base?: string; head?: string };
  // its claim and how it ended
  claimed_by?: string;
  claimed_at?: string;
  done_at?: string;
  note?: string | null;
}

/** Where the reviewer's reading stopped, for an update (sinceOf() in reads.ts, plus the story id). */
export interface UpdateSince {
  since_sha?: string | null;
  source?: string | null;
  read?: { chapter: string; title: string | null; sha: string | null; at: string }[];
  story?: string | null;
}

type BuildState = Build['status'] | 'building' | 'queued' | 'none';

/** A build request as a wait hands it to a session: the request, what it asks in words, and its update or rebuild fields. */
export interface BuildRequestEntry {
  type: 'build_request';
  id: string;
  at: string;
  repo?: string | null;
  number: number | null;
  url: string | null;
  requested_at: string;
  text: string;
  story?: string | null;
  mode?: Build['mode'];
  // an update
  base_sha?: string;
  retell?: boolean;
  since_sha?: string;
  since_source?: string | null;
  reads?: BuildRead[];
  // a rebuild
  kind?: Build['kind'];
  from_step?: number;
  guidance?: string | null;
  told_from?: string | null;
  story_dir?: string | null;
  local?: Build['local'];
}

/** The Build story or Update button's request, as the page sends it: request() checks each field. */
export interface BuildAsk {
  repo: string;
  number: number | string;
  requested_at?: string;
  mode?: string;
  base_sha?: string;
  retell?: boolean;
  since?: UpdateSince | null;
}

/** A Rebuild, as the panel asks for it (requestRebuild checks it). */
export interface RebuildRequest {
  story: string;
  meta: StoryMeta | null;
  mode: string;
  from_step?: unknown;
  guidance?: unknown;
  chapters: number;
  story_dir?: string | null;
  requested_at?: unknown;
}

export const CLAIM_FRESH_MS = 30 * 60 * 1000;

/** A local story's rebuild, which has no PR to key it by. */
export const storyKey = (id: string): string => `story:${id}`;
const MAX_GUIDANCE = 2000;

/** What a rebuild is of, in words: owner/repo#N, or the local story and its range. */
const subjectOf = (build: Build) =>
  build.number
    ? `${build.repo}#${build.number}`
    : `the local story ${build.story}${build.local ? ` (${build.local.repo_path}, ${build.local.base}..${build.local.head})` : ''}`;

/** A rebuild request in a line: what to keep, what to re-tell, and the reviewer's note on what should change. */
function rebuildText(build: Build): string {
  const from = Number(build.from_step) || 1;
  const where = build.story_dir ? ` The published story: ${build.story_dir}/chapters.json.` : '';
  const why = build.guidance ? ` What should change: "${build.guidance}"` : '';
  const what =
    from > 1
      ? `Rebuild the story for ${subjectOf(build)} from chapter ${from}: keep chapters 1-${from - 1} exactly as published, re-tell chapter ${from} and the rest, and place every file and hunk they don't already tell.`
      : `Rebuild the story for ${subjectOf(build)} from scratch on its current diff, keeping its id.`;
  return `${what}${where}${why}`;
}

/**
 * What a request asks for, in a line for the inbox and `wait`. An update is an addendum by default: one new
 * "Since you read it" chapter for since_sha..the PR's head, first, with the other chapters kept. retell asks for a
 * whole new story (a rebase, or a big rework).
 */
export function buildText(build: Build, reader = "the reviewer's"): string {
  const pr = `${build.repo}#${build.number}`;
  if (isRebuild(build)) {
    return rebuildText(build);
  }
  if (build.mode !== 'update') {
    return `Build a story for ${pr}: ${build.url}`;
  }
  if (build.retell) {
    return `Re-tell the story for ${pr} from scratch at the PR's latest commit (it was told from ${shortSha(build.base_sha)}): ${build.url}`;
  }
  const since = build.since_sha || build.base_sha;
  const why = build.since_source === 'read' ? `, where ${reader} reading stopped` : '';
  return `Update the story for ${pr} (told from ${shortSha(build.base_sha)}): put a "Since you read it" chapter first for ${shortSha(since)}..the PR's head${why}, and keep the other chapters: ${build.url}`;
}
/** One line on an update: an addendum from where, or a re-tell. */
export function updateOf(build: Partial<Build>, reader = "the reviewer's"): string {
  if (isRebuild(build)) {
    const from = Number(build.from_step) || 1;
    return (
      (from > 1 ? `rebuild from chapter ${from} (1-${from - 1} kept)` : 'rebuild from scratch') +
      (build.guidance ? `: "${build.guidance}"` : '')
    );
  }
  if (build.mode !== 'update') {
    return '';
  }
  if (build.retell) {
    return `re-tell from scratch (the story was told from ${shortSha(build.base_sha)})`;
  }
  const reads = build.reads || [];
  const since = build.since_sha || build.base_sha;
  return (
    `update: "Since you read it" from ${shortSha(since)}` +
    (build.since_source === 'read'
      ? ` (where ${reader} reading stopped; ${plural(reads.length, 'chapter')} read)`
      : " (the story's old head; no chapters read)")
  );
}
/** The update fields a request carries to `wait` and `builds --json`. */
const updateFields = (build: Build) =>
  build.mode === 'update'
    ? {
        mode: 'update' as const,
        base_sha: build.base_sha,
        retell: !!build.retell,
        since_sha: build.since_sha || build.base_sha,
        since_source: build.since_source || 'story',
        reads: build.reads || [],
        story: build.story || null,
      }
    : {};
/** The rebuild fields a request carries to `wait` and `builds --json`. */
const rebuildFields = (build: Build) => ({
  mode: build.mode,
  story: build.story,
  kind: build.kind || 'github',
  ...(build.from_step ? { from_step: build.from_step } : {}),
  guidance: build.guidance || null,
  told_from: build.told_from || null,
  story_dir: build.story_dir || null,
  ...(build.local ? { local: build.local } : {}),
});

/**
 * Does a story for the PR, told from `head`, finish this request? It does unless the request is an update and the
 * story is still the one told from the commit it was asked to update from. A rebuild is finished only by publishing
 * the story again (`published`), not by the story being there.
 */
export const storyFinishes = (
  build: Build | null,
  head: string | null | undefined,
  { published = false } = {},
): build is Build =>
  !!build &&
  build.status === 'pending' &&
  (isRebuild(build) ? published : !(build.mode === 'update' && head === build.base_sha));

export class Builds {
  declare home: string;
  declare file: string;
  constructor(home: string) {
    this.home = home;
    this.file = path.join(home, 'builds.json');
  }

  all(): Record<string, Build> {
    return readJson<Record<string, Build>>(this.file, {}) as Record<string, Build>;
  }
  save(all: Record<string, Build>): void {
    writeJson(this.file, all);
  }

  get(repo: string, number: number | string): Build | null {
    return this.all()[prKey(repo, Number(number))] || null;
  }
  /** The story's rebuild request (pending or the last one), or null: a PR story's under its PR, a local one's under its id. */
  rebuildOf(id: string, meta: StoryMeta | null): Build | null {
    const build =
      meta && meta.kind === 'github' && meta.repo && meta.number
        ? this.get(meta.repo, meta.number)
        : this.all()[storyKey(id)] || null;
    return isRebuild(build) && build!.story === id ? build : null;
  }
  /** The key of the request with this id, or this key itself (any case), or null. */
  keyOf(all: Record<string, Build>, idOrKey: string): string | null {
    const wanted = String(idOrKey).toLowerCase();
    return (
      Object.keys(all).find((k) => all[k].id === idOrKey || k.toLowerCase() === wanted) || null
    );
  }
  pending(): Build[] {
    return Object.values(this.all()).filter((build) => build.status === 'pending');
  }

  /**
   * A pending request is "queued" until a listener claims it, then "building" while the claim is fresh.
   * `once-upon wait` claims each request it hands over. On a long build, `once-upon builds --start <id>`
   * refreshes the claim. A claim with no refresh for CLAIM_FRESH_MS goes back to queued, and the next wait
   * hands it out again.
   */
  stateOf(build: Build | null, now = Date.now()): BuildState {
    if (!build) {
      return 'none';
    }
    if (build.status !== 'pending') {
      return build.status;
    }
    const since = Date.parse(build.claimed_at || '') || 0;
    return since && now - since < CLAIM_FRESH_MS ? 'building' : 'queued';
  }
  /** The request with its state, for the pages. */
  view(build: Build | null) {
    return build ? { ...build, state: this.stateOf(build) } : null;
  }

  claim(idOrKey: string, consumer: string | null): Build | null {
    const all = this.all();
    const key = this.keyOf(all, idOrKey);
    if (!key || all[key].status !== 'pending') {
      return null;
    }
    all[key] = {
      ...all[key],
      claimed_by: consumer || all[key].claimed_by || 'cli',
      claimed_at: new Date().toISOString(),
    };
    this.save(all);
    return all[key];
  }

  /**
   * The build requests a wait should hand over: queued ones (never claimed, or a claim gone stale) for its repo,
   * or every repo when it has no --repo, oldest first. They come from builds.json, so ones asked before the
   * consumer started waiting aren't missed. Each is claimed for the consumer, so another listener doesn't get it too.
   * A story wait (`story`) takes that story's rebuilds and nothing else. A repo or catch-all wait leaves a rebuild
   * to the story's own listener while one that takes build requests is live (`live`: listeners()).
   */
  toHand(
    consumer: string,
    {
      repo = null,
      story = null,
      live = null,
    }: { repo?: string | null; story?: string | null; live?: Listener[] | null } = {},
  ): BuildRequestEntry[] {
    const storyTakers = (live || listeners(this.home)).filter(
      (listener) =>
        listener.live && listener.story && listener.builds && listener.consumer !== consumer,
    );
    const mine = (build: Build) => {
      if (story) {
        return isRebuild(build) && build.story === story;
      }
      if (repo && !sameRepo(build.repo, repo)) {
        return false;
      }
      return !(isRebuild(build) && storyTakers.some((listener) => listener.story === build.story));
    };
    const queued = this.pending()
      .filter((build) => this.stateOf(build) === 'queued' && mine(build))
      .sort((first, second) => Date.parse(first.requested_at) - Date.parse(second.requested_at));
    return queued.map((build) => {
      this.claim(build.id, consumer);
      return {
        type: 'build_request' as const,
        id: build.id,
        at: build.requested_at,
        repo: build.repo,
        number: build.number,
        url: build.url,
        requested_at: build.requested_at,
        ...(isRebuild(build) ? rebuildFields(build) : updateFields(build)),
        text: buildText(build, readerOf(this.home)),
      };
    });
  }

  /**
   * A new request, or the pending one already there for that PR. Throws on a bad repo or number. The URL is always rebuilt from them.
   * An update can carry `retell` (a whole new story instead of a "Since you read it" chapter) and `since` (sinceOf() in reads.ts,
   * plus the story id): where the reviewer's reading stopped. A queued update can still switch between the two.
   */
  request({
    repo,
    number,
    requested_at,
    mode,
    base_sha,
    retell = false,
    since = null,
  }: BuildAsk): Build {
    if (!REPO_RE.test(String(repo || ''))) {
      throw Object.assign(new Error('bad repo'), { status: 400 });
    }
    const prNumber = Number(number);
    if (!Number.isInteger(prNumber) || prNumber < 1) {
      throw Object.assign(new Error('bad number'), { status: 400 });
    }
    const want = `https://github.com/${repo}/pull/${prNumber}`;
    const prUrl = want; // always this PR's own URL, whatever the page sent
    const all = this.all();
    const key = prKey(repo, Number(prNumber));
    const update = mode === 'update' && SHA_RE.test(String(base_sha || ''));
    const old = all[key];
    if (old && old.status === 'pending') {
      // a rebuild asked from the panel stands until it's done
      if (isRebuild(old)) {
        return old;
      }
      // Update (new commits) and Re-tell from scratch: the later click wins while no session has taken it
      if (!(
        update &&
        old.mode === 'update' &&
        !!retell !== !!old.retell &&
        this.stateOf(old) === 'queued'
      )) {
        return old;
      }
      const next = { ...old };
      delete next.retell;
      all[key] = { ...next, ...(retell ? { retell: true } : {}) };
      this.save(all);
      return all[key];
    }
    const requestedAt = Number.isFinite(Date.parse(requested_at as string))
      ? new Date(requested_at as string).toISOString()
      : new Date().toISOString();
    const where =
      update && since
        ? {
            ...(since.since_sha ? { since_sha: since.since_sha, since_source: since.source } : {}),
            reads: (since.read || []).map((read) => ({
              chapter: read.chapter,
              title: read.title,
              sha: read.sha,
              at: read.at,
            })),
            ...(since.story ? { story: since.story } : {}),
          }
        : {};
    const build: Build = {
      id: newId('b'),
      repo,
      number: prNumber,
      url: prUrl,
      requested_at: requestedAt,
      status: 'pending',
      ...(update
        ? { mode: 'update' as const, base_sha, ...(retell ? { retell: true } : {}), ...where }
        : {}),
    };
    all[key] = build;
    this.save(all);
    return build;
  }

  /**
   * A rebuild of a story the bridge serves: {story (its id), meta (its meta.json), mode ('rebuild' or 'rebuild_from'),
   * from_step (rebuild_from: the first chapter to re-tell, 2..chapters; 1 is a whole rebuild), guidance (what should
   * change, optional), chapters (how many it has), story_dir}. Throws on a bad mode or step. A pending request for the
   * story that no session has taken yet gives way to it (the later click wins); one being built stands, and comes back.
   */
  requestRebuild({
    story,
    meta,
    mode,
    from_step,
    guidance,
    chapters,
    story_dir = null,
    requested_at,
  }: RebuildRequest): Build {
    const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
    if (!ID_RE.test(String(story || '')) || !meta) {
      throw bad('bad story');
    }
    if (!REBUILD_MODES.includes(mode)) {
      throw bad(`mode is one of ${REBUILD_MODES.join(', ')}`);
    }
    const from = mode === 'rebuild_from' ? Number(from_step) : 1;
    if (!Number.isInteger(from) || from < 1 || from > Number(chapters)) {
      throw bad(`from_step is a chapter of the story, 1 to ${chapters}`);
    }
    const github = meta.kind === 'github';
    if (github && (!REPO_RE.test(String(meta.repo || '')) || !(Number(meta.number) > 0))) {
      throw bad("the story doesn't say which PR it is");
    }
    const all = this.all();
    const key = github ? prKey(meta.repo as string, Number(meta.number)) : storyKey(story);
    const old = all[key];
    if (old && old.status === 'pending' && this.stateOf(old) !== 'queued') {
      return old;
    }
    const note = typeof guidance === 'string' ? guidance.trim().slice(0, MAX_GUIDANCE) : '';
    const build: Build = {
      id: old && old.status === 'pending' ? old.id : newId('b'),
      repo: github ? meta.repo : meta.repo || null,
      number: github ? Number(meta.number) : null,
      url: github ? `https://github.com/${meta.repo}/pull/${Number(meta.number)}` : null,
      requested_at: Number.isFinite(Date.parse(requested_at as string))
        ? new Date(requested_at as string).toISOString()
        : new Date().toISOString(),
      status: 'pending',
      mode: from > 1 ? 'rebuild_from' : 'rebuild',
      story,
      kind: github ? 'github' : 'local',
      ...(from > 1 ? { from_step: from } : {}),
      ...(note ? { guidance: note } : {}),
      told_from: meta.head_oid || null,
      story_dir,
      ...(github ? {} : { local: { repo_path: meta.repo_path, base: meta.base, head: meta.head } }),
    };
    all[key] = build;
    this.save(all);
    return build;
  }

  /** Mark a request finished, by id or by repo#number (or story:<id>). */
  done(
    idOrKey: string,
    {
      story = null,
      failed = false,
      note = null,
    }: { story?: string | null; failed?: boolean; note?: string | null } = {},
  ): Build | null {
    const all = this.all();
    const key = this.keyOf(all, idOrKey);
    if (!key) {
      return null;
    }
    all[key] = {
      ...all[key],
      status: failed ? 'failed' : 'done',
      done_at: new Date().toISOString(),
      story: story || all[key].story || null,
      note,
    };
    this.save(all);
    return all[key];
  }

  /**
   * A story for the PR turned up (or was published again: `published`): finish its pending request when storyFinishes
   * says so. Returns the request either way. `note` says what a rebuild kept.
   */
  settle(
    repo: string,
    number: number,
    {
      story,
      head = null,
      published = false,
      note = null,
    }: { story: string; head?: string | null; published?: boolean; note?: string | null },
  ): Build | null {
    const build = this.get(repo, number);
    return storyFinishes(build, head, { published }) ? this.done(build.id, { story, note }) : build;
  }
  /** A local story was written again: finish its pending rebuild. */
  settleStory(id: string, { note = null }: { note?: string | null } = {}): Build | null {
    const build = this.all()[storyKey(id)] || null;
    return storyFinishes(build, null, { published: true })
      ? this.done(build.id, { story: id, note })
      : build;
  }
}
