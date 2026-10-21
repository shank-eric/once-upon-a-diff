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
        ...(b.mode === 'update' ? { mode: 'update', base_sha: b.base_sha } : {}),
        text: b.mode === 'update' ? `Update the story for ${b.repo}#${b.number} (told from ${String(b.base_sha).slice(0, 7)}) to the PR's latest commit: ${b.url}` : `Build a story for ${b.repo}#${b.number}: ${b.url}`,
      };
    });
  }

  /** A new request, or the pending one already there for that PR. Throws on a bad repo or number. The URL is always rebuilt from them. */
  request({ repo, number, requested_at, mode, base_sha }) {
    if (!REPO_RE.test(String(repo || ''))) throw Object.assign(new Error('bad repo'), { status: 400 });
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('bad number'), { status: 400 });
    const want = `https://github.com/${repo}/pull/${n}`;
    const prUrl = want; // always this PR's own URL, whatever the page sent
    const all = this.all();
    const key = buildKey(repo, n);
    if (all[key] && all[key].status === 'pending') return all[key];
    const at = Number.isFinite(Date.parse(requested_at)) ? new Date(requested_at).toISOString() : new Date().toISOString();
    const update = mode === 'update' && /^[0-9a-f]{7,40}$/.test(String(base_sha || ''));
    const b = { id: newId('b'), repo, number: n, url: prUrl, requested_at: at, status: 'pending', ...(update ? { mode: 'update', base_sha } : {}) };
    all[key] = b;
    this.save(all);
    this.inbox.append({ type: 'build_request', id: b.id, repo, number: n, url: prUrl, requested_at: at, ...(update ? { mode: 'update', base_sha, text: `Update the story for ${repo}#${n} (told from ${base_sha.slice(0, 7)}) to the PR's latest commit: ${prUrl}` } : { text: `Build a story for ${repo}#${n}: ${prUrl}` }) });
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
