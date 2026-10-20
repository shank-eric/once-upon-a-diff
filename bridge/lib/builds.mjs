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

  /** A new request, or the pending one already there for that PR. Throws on a bad repo or number. The URL is always rebuilt from them. */
  request({ repo, number, requested_at }) {
    if (!REPO_RE.test(String(repo || ''))) throw Object.assign(new Error('bad repo'), { status: 400 });
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('bad number'), { status: 400 });
    const want = `https://github.com/${repo}/pull/${n}`;
    const prUrl = want; // always this PR's own URL, whatever the page sent
    const all = this.all();
    const key = buildKey(repo, n);
    if (all[key] && all[key].status === 'pending') return all[key];
    const at = Number.isFinite(Date.parse(requested_at)) ? new Date(requested_at).toISOString() : new Date().toISOString();
    const b = { id: newId('b'), repo, number: n, url: prUrl, requested_at: at, status: 'pending' };
    all[key] = b;
    this.save(all);
    this.inbox.append({ type: 'build_request', id: b.id, repo, number: n, url: prUrl, requested_at: at, text: `Build a story for ${repo}#${n}: ${prUrl}` });
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
