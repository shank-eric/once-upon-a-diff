/**
 * Build requests: "there's no story for this PR yet, please write one".
 *
 * The extension's Build story button posts {repo, number, url, requested_at}.
 * The bridge keeps the request in <home>/builds.json, the one record of it:
 * `diff-story wait` hands queued ones to a Claude session as `build_request`
 * entries, and every tab on that PR shows Queued or Building. A request is
 * finished by its story turning up (`diff-story publish`, or a status call
 * that notices the story), or by `diff-story done <id>`.
 */
import path from 'node:path';
import { newId } from './inbox.mjs';
import { sameRepo, REPO_RE } from '../config/repos.mjs';
import { shortSha } from '../../src/js/shared/util/text.js';
import { readerOf } from '../config/settings.mjs';
import { readJson, writeJson } from '../util/json-file.mjs';

export const CLAIM_FRESH_MS = 30 * 60 * 1000;

export const buildKey = (repo, number) => `${String(repo).toLowerCase()}#${Number(number)}`;

/**
 * What a request asks for, in a line for the inbox and `wait`. An update is an addendum by default: one new
 * "Since you read it" chapter for since_sha..the PR's head, first, with the other chapters kept. retell asks for a
 * whole new story (a rebase, or a big rework).
 */
export function buildText(build, reader = "the reviewer's") {
  const pr = `${build.repo}#${build.number}`;
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
export function updateOf(build, reader = "the reviewer's") {
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
      ? ` (where ${reader} reading stopped; ${reads.length} chapter${reads.length === 1 ? '' : 's'} read)`
      : " (the story's old head; no chapters read)")
  );
}
/** The update fields a request carries to `wait` and `builds --json`. */
const updateFields = (build) =>
  build.mode === 'update'
    ? {
        mode: 'update',
        base_sha: build.base_sha,
        retell: !!build.retell,
        since_sha: build.since_sha || build.base_sha,
        since_source: build.since_source || 'story',
        reads: build.reads || [],
        story: build.story || null,
      }
    : {};

/**
 * Does a story for the PR, told from `head`, finish this request? It does unless the request is an update and the
 * story is still the one told from the commit it was asked to update from.
 */
export const storyFinishes = (build, head) =>
  !!build && build.status === 'pending' && !(build.mode === 'update' && head === build.base_sha);

export class Builds {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'builds.json');
  }

  all() {
    return readJson(this.file, {});
  }
  save(all) {
    writeJson(this.file, all);
  }

  get(repo, number) {
    return this.all()[buildKey(repo, number)] || null;
  }
  pending() {
    return Object.values(this.all()).filter((build) => build.status === 'pending');
  }

  /**
   * A pending request is "queued" until a listener claims it, then "building" while the claim is fresh.
   * `diff-story wait` claims each request it hands over. On a long build, `diff-story builds --start <id>`
   * refreshes the claim. A claim with no refresh for CLAIM_FRESH_MS goes back to queued, and the next wait
   * hands it out again.
   */
  stateOf(build, now = Date.now()) {
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
  view(build) {
    return build ? { ...build, state: this.stateOf(build) } : null;
  }

  claim(idOrKey, consumer) {
    const all = this.all();
    const key = Object.keys(all).find(
      (k) => all[k].id === idOrKey || k === String(idOrKey).toLowerCase(),
    );
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
   */
  toHand(consumer, { repo = null } = {}) {
    const queued = this.pending()
      .filter((build) => this.stateOf(build) === 'queued' && (!repo || sameRepo(build.repo, repo)))
      .sort((first, second) => Date.parse(first.requested_at) - Date.parse(second.requested_at));
    return queued.map((build) => {
      this.claim(build.id, consumer);
      return {
        type: 'build_request',
        id: build.id,
        at: build.requested_at,
        repo: build.repo,
        number: build.number,
        url: build.url,
        requested_at: build.requested_at,
        ...updateFields(build),
        text: buildText(build, readerOf(this.home)),
      };
    });
  }

  /**
   * A new request, or the pending one already there for that PR. Throws on a bad repo or number. The URL is always rebuilt from them.
   * An update can carry `retell` (a whole new story instead of a "Since you read it" chapter) and `since` (sinceOf() in reads.mjs,
   * plus the story id): where the reviewer's reading stopped. A queued update can still switch between the two.
   */
  request({ repo, number, requested_at, mode, base_sha, retell = false, since = null }) {
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
    const key = buildKey(repo, prNumber);
    const update = mode === 'update' && /^[0-9a-f]{7,40}$/.test(String(base_sha || ''));
    const old = all[key];
    if (old && old.status === 'pending') {
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
    const requestedAt = Number.isFinite(Date.parse(requested_at))
      ? new Date(requested_at).toISOString()
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
    const build = {
      id: newId('b'),
      repo,
      number: prNumber,
      url: prUrl,
      requested_at: requestedAt,
      status: 'pending',
      ...(update
        ? { mode: 'update', base_sha, ...(retell ? { retell: true } : {}), ...where }
        : {}),
    };
    all[key] = build;
    this.save(all);
    return build;
  }

  /** Mark a request finished, by id or by repo#number. */
  done(idOrKey, { story = null, failed = false, note = null } = {}) {
    const all = this.all();
    const key = Object.keys(all).find(
      (k) => all[k].id === idOrKey || k === String(idOrKey).toLowerCase(),
    );
    if (!key) {
      return null;
    }
    all[key] = {
      ...all[key],
      status: failed ? 'failed' : 'done',
      done_at: new Date().toISOString(),
      story,
      note,
    };
    this.save(all);
    return all[key];
  }

  /** A story for the PR turned up: finish its pending request when storyFinishes says so. Returns the request either way. */
  settle(repo, number, { story, head = null }) {
    const build = this.get(repo, number);
    return storyFinishes(build, head) ? this.done(build.id, { story }) : build;
  }
}
