/**
 * Build requests: "there's no story for this PR yet, please write one".
 *
 * The extension's Build story button posts {repo, number, url, requested_at}.
 * The bridge appends a `build_request` line to the inbox (so `diff-story
 * wait` hands it to a Claude session, the same way as a question) and keeps a
 * pending marker in <home>/builds.json, so every tab on that PR shows
 * Building. A request is finished by `diff-story done <id>`, or by the story
 * turning up (the status call notices and marks it done).
 *
 * autoBuild (off unless config.json says otherwise) runs a command for each
 * new request. The command is an argv array and is never run through a
 * shell. {url}, {repo} and {number} in its arguments are replaced, and the
 * same values are in the environment as DIFF_STORY_URL, DIFF_STORY_REPO and
 * DIFF_STORY_NUMBER:
 *   "autoBuild": {"enabled": true, "command": ["claude", "-p", "/pr-story {url}"], "cwd": "~/Development"}
 */
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { newId } from './inbox.mjs';
import { sameRepo } from './repos.mjs';

export const CLAIM_FRESH_MS = 30 * 60 * 1000;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const buildKey = (repo, number) => `${String(repo).toLowerCase()}#${Number(number)}`;
const sha7 = x => String(x || '').slice(0, 7);

/**
 * What a request asks for, in a line for the inbox and `wait`. An update is an addendum by default: one new
 * "Since you read it" chapter for since_sha..the PR's head, first, with the other chapters kept. retell asks for a
 * whole new story (a rebase, or a big rework).
 */
export function buildText(b) {
  const pr = `${b.repo}#${b.number}`;
  if (b.mode !== 'update') return `Build a story for ${pr}: ${b.url}`;
  if (b.retell) return `Re-tell the story for ${pr} from scratch at the PR's latest commit (it was told from ${sha7(b.base_sha)}): ${b.url}`;
  const since = b.since_sha || b.base_sha;
  const why = b.since_source === 'read' ? `, where Eric's reading stopped` : '';
  return `Update the story for ${pr} (told from ${sha7(b.base_sha)}): put a "Since you read it" chapter first for ${sha7(since)}..the PR's head${why}, and keep the other chapters: ${b.url}`;
}
/** One line on an update: an addendum from where, or a re-tell. */
export function updateOf(b) {
  if (b.mode !== 'update') return '';
  if (b.retell) return `re-tell from scratch (the story was told from ${sha7(b.base_sha)})`;
  const reads = b.reads || [];
  const since = b.since_sha || b.base_sha;
  return `update: "Since you read it" from ${sha7(since)}`
    + (b.since_source === 'read' ? ` (where his reading stopped; ${reads.length} chapter${reads.length === 1 ? '' : 's'} read)` : ' (the story\'s old head; no chapters read)');
}
/** The update fields a request carries to `wait` and `builds --json`. */
const updateFields = b => (b.mode === 'update' ? {
  mode: 'update', base_sha: b.base_sha, retell: !!b.retell, since_sha: b.since_sha || b.base_sha, since_source: b.since_source || 'story', reads: b.reads || [], story: b.story || null,
} : {});

export class Builds {
  constructor(home, inbox, { autoBuild } = {}) {
    this.home = home;
    this.inbox = inbox;
    this.autoBuild = autoBuild && autoBuild.enabled ? autoBuild : null;
    this.file = path.join(home, 'builds.json');
  }

  all() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  save(all) { writeFileSync(this.file, JSON.stringify(all, null, 2)); }

  get(repo, number) { return this.all()[buildKey(repo, number)] || null; }
  pending() { return Object.values(this.all()).filter(b => b.status === 'pending'); }

  /**
   * A pending request is "queued" until a listener claims it, then "building" while the claim is fresh.
   * `diff-story wait` claims each request it hands over, and `diff-story builds --start <id>` (which the
   * diff-story-listen skill runs as it starts each build) claims or refreshes it. A claim with no refresh for
   * CLAIM_FRESH_MS goes back to queued, and the next wait hands it out again.
   */
  stateOf(b, now = Date.now()) {
    if (!b) return 'none';
    if (b.status !== 'pending') return b.status;
    const t = Math.max(Date.parse(b.claimed_at || '') || 0, Date.parse(b.started_at || '') || 0);
    return t && now - t < CLAIM_FRESH_MS ? 'building' : 'queued';
  }
  /** The request with its state, for the pages. */
  view(b) { return b ? { ...b, state: this.stateOf(b) } : null; }

  claim(idOrKey, consumer, { start = false } = {}) {
    const all = this.all();
    const key = Object.keys(all).find(k => all[k].id === idOrKey || k === String(idOrKey).toLowerCase());
    if (!key || all[key].status !== 'pending') return null;
    const now = new Date().toISOString();
    all[key] = { ...all[key], claimed_by: consumer || all[key].claimed_by || 'cli', claimed_at: now, ...(start ? { started_at: now } : {}) };
    this.save(all);
    return all[key];
  }

  /**
   * The build requests a wait should hand over: queued ones (never claimed, or a claim gone stale) for its repo,
   * or every repo when it has no --repo, oldest first. They come from builds.json, so ones asked before the
   * consumer started waiting aren't missed. Each is claimed for the consumer, so another listener doesn't get it too.
   */
  toHand(consumer, { repo = null } = {}) {
    const queued = this.pending().filter(b => this.stateOf(b) === 'queued' && (!repo || sameRepo(b.repo, repo)))
      .sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at));
    return queued.map(b => {
      this.claim(b.id, consumer);
      return {
        type: 'build_request', id: b.id, at: b.requested_at, repo: b.repo, number: b.number, url: b.url, requested_at: b.requested_at,
        ...updateFields(b), text: buildText(b),
      };
    });
  }

  /**
   * A new request, or the pending one already there for that PR. Throws on a bad repo or number. The URL is always rebuilt from them.
   * An update can carry `retell` (a whole new story instead of a "Since you read it" chapter) and `since` (sinceOf() in reads.mjs,
   * plus the story id): where Eric's reading stopped. A queued update can still switch between the two.
   */
  request({ repo, number, requested_at, mode, base_sha, retell = false, since = null }) {
    if (!REPO_RE.test(String(repo || ''))) throw Object.assign(new Error('bad repo'), { status: 400 });
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('bad number'), { status: 400 });
    const want = `https://github.com/${repo}/pull/${n}`;
    const prUrl = want; // always this PR's own URL, whatever the page sent
    const all = this.all();
    const key = buildKey(repo, n);
    const update = mode === 'update' && /^[0-9a-f]{7,40}$/.test(String(base_sha || ''));
    const old = all[key];
    if (old && old.status === 'pending') {
      // Update (new commits) and Re-tell from scratch: the later click wins while no session has taken it
      if (!(update && old.mode === 'update' && !!retell !== !!old.retell && this.stateOf(old) === 'queued')) return old;
      const next = { ...old };
      delete next.retell;
      all[key] = { ...next, ...(retell ? { retell: true } : {}) };
      this.save(all);
      this.inbox.append({ type: 'build_request', id: old.id, repo, number: n, url: prUrl, requested_at: old.requested_at, ...updateFields(all[key]), text: buildText(all[key]) });
      return all[key];
    }
    const at = Number.isFinite(Date.parse(requested_at)) ? new Date(requested_at).toISOString() : new Date().toISOString();
    const where = update && since ? {
      ...(since.since_sha ? { since_sha: since.since_sha, since_source: since.source } : {}),
      reads: (since.read || []).map(r => ({ chapter: r.chapter, title: r.title, sha: r.sha, at: r.at })),
      ...(since.story ? { story: since.story } : {}),
    } : {};
    const b = { id: newId('b'), repo, number: n, url: prUrl, requested_at: at, status: 'pending', ...(update ? { mode: 'update', base_sha, ...(retell ? { retell: true } : {}), ...where } : {}) };
    all[key] = b;
    this.save(all);
    this.inbox.append({ type: 'build_request', id: b.id, repo, number: n, url: prUrl, requested_at: at, ...updateFields(b), text: buildText(b) });
    if (this.autoBuild) this.run(b);
    return b;
  }

  /** Mark a request finished, by id or by repo#number. */
  done(idOrKey, { story = null, failed = false, note = null } = {}) {
    const all = this.all();
    const key = Object.keys(all).find(k => all[k].id === idOrKey || k === String(idOrKey).toLowerCase());
    if (!key) return null;
    all[key] = { ...all[key], status: failed ? 'failed' : 'done', done_at: new Date().toISOString(), story, note };
    this.save(all);
    this.inbox.append({ type: 'build_done', id: newId('d'), build: all[key].id, repo: all[key].repo, number: all[key].number, status: all[key].status, story, note });
    return all[key];
  }

  /** autoBuild: run the configured command for one request, detached, output in <home>/builds/<id>.log. */
  run(b) {
    const cmd = this.autoBuild.command;
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every(a => typeof a === 'string')) {
      process.stderr.write('diff-story: autoBuild.command must be an array of strings; not running it\n');
      return;
    }
    const fill = a => a.replace(/\{url\}/g, b.url).replace(/\{repo\}/g, b.repo).replace(/\{number\}/g, String(b.number));
    const dir = path.join(this.home, 'builds');
    mkdirSync(dir, { recursive: true });
    const log = openSync(path.join(dir, `${b.id}.log`), 'a');
    const cwd = this.autoBuild.cwd ? this.autoBuild.cwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
    try {
      const child = spawn(cmd[0], cmd.slice(1).map(fill), {
        cwd: existsSync(cwd) ? cwd : os.homedir(), detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, DIFF_STORY_URL: b.url, DIFF_STORY_REPO: b.repo, DIFF_STORY_NUMBER: String(b.number), DIFF_STORY_BUILD: b.id },
      });
      child.on('error', err => { this.done(b.id, { failed: true, note: `autoBuild could not start: ${err.message}` }); });
      child.on('exit', code => { if (code && this.get(b.repo, b.number)?.status === 'pending') this.done(b.id, { failed: true, note: `autoBuild exited ${code}` }); });
      child.unref();
    } finally {
      closeSync(log);
    }
  }
}
