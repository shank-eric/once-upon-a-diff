/**
 * The bridge: a small HTTP server on 127.0.0.1 that serves stories to the
 * extension and the local page, and writes what the panel sends (questions,
 * position, viewed files, notes) to the inbox and the story's state folder.
 *
 * Guard rails:
 *   - binds 127.0.0.1 only, and answers only when the Host header is
 *     127.0.0.1:<port> or localhost:<port> (no DNS rebinding)
 *   - every /api call needs the token (Authorization: Bearer <token>)
 *   - writes must be application/json, and a request with an Origin must come
 *     from the extension or from the bridge's own pages
 *   - no CORS headers, so other web pages can't read anything it says
 */
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore, readMeta, refreshLocal, storyVersion, localVersion } from './stories.mjs';
import { readPrefs, writePrefs } from './config.mjs';
import { storyRepo, seenCheckout, REPO_RE } from './repos.mjs';
import { Inbox, newId } from './inbox.mjs';
import { Builds } from './builds.mjs';
import { addComment } from './comments.mjs';
import { freshness, currentHead, changesSince, newerCount } from './freshness.mjs';
import { stateKeyOf, readMarks, mark, draftStatus, githubComments, forgetComments, addedMark, noteAdded } from './drafts.mjs';
import { addToPendingReview } from './review.mjs';
import { statusOf, listeningOf, answerContext, runAutoAnswer } from './health.mjs';
import { readReads, noteRead, sinceOf, readSha, changedSinceRead, SHA_RE } from './reads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const OVERLAY = path.resolve(HERE, '../../src/js/shared/overlay.js');
export const VERSION = JSON.parse(readFileSync(path.resolve(HERE, '../../package.json'), 'utf8')).version;

const ASSETS = {
  '/assets/overlay.js': [OVERLAY, 'text/javascript; charset=utf-8'],
  '/assets/local.js': [path.join(PUBLIC, 'local.js'), 'text/javascript; charset=utf-8'],
  '/assets/split.js': [path.join(PUBLIC, 'split.js'), 'text/javascript; charset=utf-8'],
  '/assets/syntax.js': [path.join(PUBLIC, 'syntax.js'), 'text/javascript; charset=utf-8'],
  '/assets/highlight.mjs': [path.join(PUBLIC, 'vendor/highlight.mjs'), 'text/javascript; charset=utf-8'],
  '/assets/local.css': [path.join(PUBLIC, 'local.css'), 'text/css; charset=utf-8'],
};

const MAX_BODY = 256 * 1024;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sameToken(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not JSON')); }
    });
    req.on('error', reject);
  });
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const int = v => (Number.isFinite(+v) ? Math.trunc(+v) : null);

/**
 * @param {{home: string, token: string, roots?: string[], scratch?: boolean|string[]}} opts
 * @returns {http.Server} call .listen(port, '127.0.0.1')
 */
export function createBridge({ home, token, roots, scratch = true, autoBuild = null, autoAnswer = null, log = (line) => process.stderr.write(`diff-story bridge: ${line}\n`) }) {
  if (!token) throw new Error('the bridge needs a token');
  const stories = new StoryStore({ home, roots, scratch });
  const inbox = new Inbox(home);
  const builds = new Builds(home, inbox, { autoBuild });
  let statusCache = null; // PR-list lookups, kept 5s
  // the last time the extension talked to us, for `diff-story doctor` and the status light
  let extensionSeen = null;
  let extensionWritten = 0;
  const seeExtension = (origin) => {
    extensionSeen = { at: new Date().toISOString(), origin };
    if (Date.now() - extensionWritten > 30000) {
      extensionWritten = Date.now();
      try { writeFileSync(path.join(home, 'extension-seen.json'), JSON.stringify(extensionSeen)); } catch { /* not worth failing a request over */ }
    }
  };
  const lastPosition = new Map();
  /** How much of a story he's read, for the PR-list tag: {read, total, next} (next: the first unread step, or null). */
  const readSummary = (id) => {
    const reads = readReads(home, stateKeyOf(id, readMeta(stories.dirOf(id))));
    const done = stories.load(id).chapters.map(c => !!reads[c.key]);
    const next = done.indexOf(false);
    return { read: done.filter(Boolean).length, total: done.length, next: next < 0 ? null : next + 1 };
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const port = server.address().port;
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'wrong host');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname;
      const origin = req.headers.origin;
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, 'origin not allowed');
      }

      if (req.method === 'GET' && ASSETS[p]) {
        const [file, type] = ASSETS[p];
        return send(200, readFileSync(file), type);
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(200, indexPage(stories.list()), 'text/html; charset=utf-8', pageHeaders());
      const lp = /^\/local\/([^/]+)\/?$/.exec(p);
      if (req.method === 'GET' && lp) {
        const dir = stories.dirOf(decodeURIComponent(lp[1]));
        if (!dir || readMeta(dir).kind !== 'local') throw new HttpError(404, 'no local story with that id');
        return send(200, localPage(decodeURIComponent(lp[1]), readMeta(dir), token), 'text/html; charset=utf-8', pageHeaders());
      }

      if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-diff-story-token'];
      if (!sameToken(auth, token)) throw new HttpError(401, 'missing or wrong token');
      if (origin && origin.startsWith('chrome-extension://')) seeExtension(origin);
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'send application/json');
        body = await readBody(req);
      } else if (req.method !== 'GET') throw new HttpError(405, 'GET or POST only');

      if (p === '/api/health') return send(200, { ok: true, name: 'diff-story-bridge', version: VERSION });
      if (p === '/api/status' && req.method === 'GET') {
        // the panel's status light: bridge, story, a Claude session listening, autoBuild and autoAnswer
        // listeners are per repo, so this also works out the page's repo: the story's, or ?repo=
        const sid = url.searchParams.get('story');
        const qrepo = REPO_RE.test(url.searchParams.get('repo') || '') ? url.searchParams.get('repo') : null;
        let story;
        let repo = qrepo;
        if (sid) {
          story = stories.dirOf(sid) ? sid : null;
          if (story) repo = storyRepo(readMeta(stories.dirOf(sid))) || qrepo;
        } else if (qrepo && url.searchParams.get('number')) { const hit = stories.find(qrepo, url.searchParams.get('number')); story = hit ? hit.id : null; }
        return send(200, statusOf({ home, version: VERSION, story, repo, autoBuild, autoAnswer, extensionSeen }));
      }
      // page settings kept across stories and restarts (the local page's Hide whitespace)
      if (p === '/api/prefs') {
        if (req.method === 'GET') return send(200, readPrefs(home));
        return send(200, writePrefs(body, home));
      }
      if (p === '/api/stories' && req.method === 'GET') return send(200, { stories: stories.list().map(({ dir, ...s }) => s) });
      if (p === '/api/stories/find' && req.method === 'GET') {
        const hit = stories.find(url.searchParams.get('repo') || '', url.searchParams.get('number'));
        if (!hit) throw new HttpError(404, 'no story for that PR');
        return send(200, { id: hit.id, version: hit.version, title: hit.title });
      }
      // build requests: the page's "Build story" button, and the state it shows (ready, building or none)
      if (p === '/api/builds' && req.method === 'GET') return send(200, { pending: builds.pending().map(b => builds.view(b)) });
      if (p === '/api/builds' && req.method === 'POST') {
        statusCache = null;
        // an update starts where his reading stopped (read.json), so the story can add one "Since you read it" chapter
        const hit = body.mode === 'update' ? stories.find(String(body.repo || ''), body.number) : null;
        let since = null;
        if (hit) {
          const hdir = stories.dirOf(hit.id);
          const hmeta = readMeta(hdir);
          const told = SHA_RE.test(String(body.base_sha || '')) ? body.base_sha : hmeta.head_oid || null;
          since = { ...sinceOf(readReads(home, stateKeyOf(hit.id, hmeta)), stories.load(hit.id).chapters, told), story: hit.id };
        }
        const b = builds.view(builds.request({ ...body, retell: body.retell === true, since }));
        return send(200, { state: b.state, request: b });
      }
      if (p === '/api/stories/status-many' && req.method === 'POST') {
        // PR lists: ready / building / none for many PRs in one call
        const prs = Array.isArray(body.prs) ? body.prs.slice(0, 200) : [];
        if (!statusCache || Date.now() - statusCache.at > 5000) statusCache = { at: Date.now(), list: stories.list(), builds: builds.all() };
        const results = prs.map(x => {
          const repo = String(x.repo || '');
          const number = Number(x.number);
          const hits = statusCache.list.filter(s => s.kind === 'github' && String(s.repo).toLowerCase() === repo.toLowerCase() && Number(s.number) === number);
          const b = builds.view(statusCache.builds[`${repo.toLowerCase()}#${number}`] || null);
          const pending = !!(b && b.status === 'pending');
          if (hits.length) {
            const id = hits.sort((a, c) => Number(c.version) - Number(a.version))[0].id;
            return { repo, number, state: 'ready', story: id, story_head: readMeta(stories.dirOf(id)).head_oid || null, updating: pending && b.mode === 'update', update_state: pending && b.mode === 'update' ? b.state : null, reads: readSummary(id) };
          }
          return { repo, number, state: pending ? b.state : 'none', request: b };
        });
        // is each story up to date? (the PR's head, read-only gh, cached 60s; only for PRs that have a story)
        await Promise.all(results.filter(r => r.state === 'ready' && r.story_head).map(async r => {
          try { const head = await currentHead(r.repo, r.number); r.current_head = head; r.stale = head !== r.story_head; } catch { r.stale = null; }
          // read, and new commits since: how many, for "Read · 3 new commits · Update"
          if (r.stale && r.reads && r.reads.read) { try { r.newer = await newerCount(r.repo, r.story_head, r.current_head); } catch { r.newer = null; } }
        }));
        // is anyone listening for each repo on the page? (the list's "No session listening for owner/name" notice)
        const repos = [...new Map(results.map(r => [r.repo.toLowerCase(), r.repo])).values()];
        const listening = Object.fromEntries(repos.map(r => [r, listeningOf(home, { repo: r })]));
        return send(200, { results, listening });
      }
      if (p === '/api/builds/status' && req.method === 'GET') {
        const repo = url.searchParams.get('repo') || '';
        const number = url.searchParams.get('number');
        const hit = stories.find(repo, number);
        let b = builds.get(repo, number);
        // the story turned up (for an update: its head moved off the one it was asked to update from)
        if (hit && b && b.status === 'pending' && !(b.mode === 'update' && readMeta(stories.dirOf(hit.id)).head_oid === b.base_sha)) b = builds.done(b.id, { story: hit.id });
        b = builds.view(b);
        const pending = !!(b && b.status === 'pending');
        if (hit) return send(200, { state: 'ready', story: hit.id, version: hit.version, title: hit.title, request: b, updating: pending && b.mode === 'update', update_state: pending && b.mode === 'update' ? b.state : null });
        if (pending) return send(200, { state: b.state, request: b }); // queued (no session has it yet) or building
        return send(200, { state: 'none', request: b });
      }
      if (p === '/api/answers' && req.method === 'POST') {
        const q = inbox.questions().find(x => x.id === body.question);
        if (!q) throw new HttpError(404, 'no such question');
        const text = str(body.text, 20000);
        if (!text) throw new HttpError(400, 'text is required');
        return send(200, inbox.append({ type: 'answer', id: newId('a'), question: q.id, story: q.story, text }));
      }

      const m = /^\/api\/stories\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(p);
      if (!m) throw new HttpError(404, 'not found');
      const id = decodeURIComponent(m[1]);
      const dir = stories.dirOf(id);
      if (!dir) throw new HttpError(404, 'no story with that id');
      const meta = readMeta(dir);
      const what = m[2] || '';
      const ctx = { story: id, kind: meta.kind, title: meta.title, repo: storyRepo(meta) }; // the repo, for `wait --repo`

      if (!what && req.method === 'GET') {
        if (meta.kind === 'local' && ctx.repo) seenCheckout(home, ctx.repo, meta.repo_path); // where to tell a listener to work from
        return send(200, stories.load(id));
      }
      if (what === 'version' && req.method === 'GET') {
        if (meta.kind === 'local') {
          refreshLocal(dir, JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')));
          return send(200, { version: localVersion(dir, readPrefs(home)) });
        }
        return send(200, { version: storyVersion(dir) });
      }
      if (what === 'ui') {
        if (req.method === 'GET') return send(200, stories.readState(id, 'ui.json', {}));
        const ui = {
          n: int(body.n) ?? 0, bn: int(body.bn) ?? 0, view: body.view === 'backstory' ? 'backstory' : 'story',
          all: !!body.all, collapsed: !!body.collapsed, width: int(body.width), hidden: !!body.hidden, filesOpen: !!body.filesOpen, at: new Date().toISOString(),
        };
        stories.writeState(id, 'ui.json', ui);
        return send(200, ui);
      }
      if (what === 'questions') {
        if (req.method === 'GET') return send(200, { questions: inbox.questions(id) });
        const text = str(body.text, 8000);
        if (!text || !text.trim()) throw new HttpError(400, 'text is required');
        const q = inbox.append({ type: 'question', id: newId('q'), ...ctx, step: int(body.step), chapter: str(body.chapter, 300), file: str(body.file, 1000), text: text.trim(), url: str(body.url, 2000) });
        if (autoAnswer && autoAnswer.enabled) {
          runAutoAnswer({
            home, autoAnswer, question: q, context: answerContext(stories.load(id), dir, q),
            onAnswer: (answer) => inbox.append({ type: 'answer', id: newId('a'), question: q.id, story: id, text: answer, by: 'autoAnswer' }),
            onFail: (why) => log(`autoAnswer for ${q.id}: ${why}`),
          });
        }
        return send(200, q);
      }
      if (what === 'freshness' && req.method === 'GET') return send(200, await freshness(meta, stories.load(id).chapters));
      if (what === 'drafts') {
        // what's become of each drafted comment: posted, in his pending review, dismissed, or still a draft.
        // Read-only on GitHub, except action 'review', which adds the draft to his pending review (never submitted).
        const key = stateKeyOf(id, meta);
        const data = stories.load(id);
        let added = null;
        if (req.method === 'POST') {
          const c = data.chapters[int(body.chapter) - 1] && data.chapters[int(body.chapter) - 1].comments[int(body.index)];
          if (!c) throw new HttpError(404, 'no such draft');
          if (body.action === 'review') {
            if (meta.kind !== 'github' || !meta.repo || !meta.number) throw new HttpError(400, 'only PR stories have a GitHub review');
            // once is enough: a second click (or another tab) would put a second copy in the review
            if (addedMark(readMarks(home, key), c)) throw new HttpError(409, 'it\'s already in your pending review');
            try { added = await addToPendingReview(meta.repo, meta.number, c); } catch (e) { throw new HttpError(e.status || 502, `couldn't add it to your review: ${e.message}`); }
            noteAdded(home, key, c, added); // the panel shows it as added until the page or gh shows it
            forgetComments(meta.repo, meta.number);
            inbox.append({ type: 'review_comment', id: newId('r'), ...ctx, chapter: int(body.chapter), path: c.path, line: c.line, url: added.url, started: added.started });
          } else {
            mark(home, key, String(body.action || ''), c);
          }
        }
        let ghc = null;
        let error = null;
        if (meta.kind === 'github' && meta.repo && meta.number) {
          try { ghc = await githubComments(meta.repo, meta.number); } catch (e) { error = `couldn't read the PR's comments with gh: ${e.message}`; }
        }
        return send(200, { drafts: draftStatus(data.chapters, readMarks(home, key), ghc), login: ghc ? ghc.login : null, checked_at: new Date().toISOString(), error, added });
      }
      if (what === 'comments' && req.method === 'POST') {
        // a comment drafted in Q&A lands in the chapter's Draft comments (never posted anywhere)
        let raw = {};
        try { raw = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { raw = {}; }
        const r = addComment(dir, raw, body);
        if (r.added) inbox.append({ type: 'comment', id: newId('c'), ...ctx, chapter: r.chapter, comment: r.comment });
        return send(200, r);
      }
      if (what === 'position' && req.method === 'POST') {
        const pos = { step: int(body.step), chapter: str(body.chapter, 300), file: str(body.file, 1000), url: str(body.url, 2000) };
        const key = JSON.stringify([pos.step, pos.file]);
        stories.writeState(id, 'position.json', { ...pos, at: new Date().toISOString() });
        if (lastPosition.get(id) === key) return send(200, { ok: true, logged: false });
        lastPosition.set(id, key);
        inbox.append({ type: 'position', id: newId('p'), ...ctx, ...pos });
        return send(200, { ok: true, logged: true });
      }
      if (what === 'read') {
        // what Eric has read, per chapter, with the commit current at the time (reads.mjs)
        const key = stateKeyOf(id, meta);
        const data = stories.load(id);
        const now = meta.kind === 'local' ? readMeta(dir) : meta; // load() follows a local story's branch
        if (req.method === 'POST') {
          const chapter = str(body.chapter, 200);
          const ch = data.chapters.find(c => c.key === chapter);
          if (!ch) throw new HttpError(404, 'no chapter with that key');
          // the PR's head: the panel says what it saw, else ask gh (read-only, cached 60s); a local story's is its head commit
          let head = SHA_RE.test(String(body.head_sha || '')) ? body.head_sha : null;
          if (!head && now.kind === 'github' && now.repo && now.number) { try { head = await currentHead(now.repo, now.number); } catch { head = null; } }
          if (!head) head = now.head_oid || null;
          const rec = noteRead(home, key, chapter, { head_sha: head, story_head: now.head_oid || head, reason: body.reason, title: ch.title, step: int(body.step), seconds: body.seconds });
          inbox.append({ type: 'read', id: newId('rd'), ...ctx, chapter, step: rec.step, title: rec.title, head_sha: rec.head_sha, story_head: rec.story_head, reason: rec.reason });
          return send(200, { chapter, ...rec });
        }
        const reads = readReads(home, key);
        // what changed after he read each chapter: one compare per commit he read at (gh, cached; or git for a local story)
        const changes = new Map();
        let error = null;
        for (const sha of new Set(Object.values(reads).map(readSha).filter(Boolean))) {
          try { changes.set(sha, await changesSince(now, sha)); } catch (e) { error = `couldn't compare ${sha.slice(0, 7)} with the story's head: ${e.message}`; }
        }
        return send(200, { reads, since: sinceOf(reads, data.chapters, now.head_oid || null), story_head: now.head_oid || null, ...changedSinceRead(data.chapters, reads, changes, now.head_oid || null), error });
      }
      if (what === 'viewed' && req.method === 'POST') {
        if (meta.kind !== 'local') throw new HttpError(400, 'viewed files are kept by GitHub for PR stories');
        const data = stories.load(id);
        const f = data.local.files.find(x => x.rel === body.path);
        if (!f) throw new HttpError(404, 'that file is not in the diff');
        const viewed = stories.readState(id, 'viewed.json', {});
        if (body.viewed) viewed[f.rel] = { hash: f.hash, at: new Date().toISOString() };
        else delete viewed[f.rel];
        stories.writeState(id, 'viewed.json', viewed);
        return send(200, { path: f.rel, viewed: !!body.viewed });
      }
      if (what === 'notes' && req.method === 'POST') {
        if (meta.kind !== 'local') throw new HttpError(400, 'fix-before-push notes are for local stories; on GitHub, draft a review comment');
        const notes = stories.readState(id, 'notes.json', []);
        if (m[3]) {
          const i = notes.findIndex(n => n.id === m[3]);
          if (i < 0) throw new HttpError(404, 'no such note');
          if (body.delete) {
            const [gone] = notes.splice(i, 1);
            stories.writeState(id, 'notes.json', notes);
            inbox.append({ type: 'note', ...ctx, action: 'deleted', note: gone });
            return send(200, { deleted: gone.id });
          }
          if ('done' in body) notes[i].done = !!body.done;
          if (typeof body.body === 'string' && body.body.trim()) notes[i].body = str(body.body.trim(), 8000);
          notes[i].updated_at = new Date().toISOString();
          stories.writeState(id, 'notes.json', notes);
          inbox.append({ type: 'note', ...ctx, action: 'updated', note: notes[i] });
          return send(200, notes[i]);
        }
        const text = str(body.body, 8000);
        if (!text || !text.trim()) throw new HttpError(400, 'body is required');
        const note = { id: newId('n'), at: new Date().toISOString(), path: str(body.path, 1000), side: body.side === 'L' ? 'L' : 'R', line: int(body.line), body: text.trim(), done: false };
        notes.push(note);
        stories.writeState(id, 'notes.json', notes);
        inbox.append({ type: 'note', ...ctx, action: 'added', note });
        return send(200, note);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log(err.stack || String(err));
      if (!res.headersSent) send(status, { error: err.message || String(err) });
    }
  });
  server.stories = stories;
  server.inbox = inbox;
  server.builds = builds;
  return server;
}

const pageHeaders = () => ({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

function indexPage(list) {
  const rows = list.map(s => {
    const href = s.kind === 'local' ? `/local/${encodeURIComponent(s.id)}/` : s.url ? `${s.url}/changes` : null;
    const where = s.kind === 'local' ? 'local commits' : s.repo ? `${s.repo}#${s.number}` : '';
    return `<li>${href ? `<a href="${esc(href)}"${s.kind === 'local' ? '' : ' target="_blank" rel="noopener noreferrer"'}>${esc(s.title)}</a>` : esc(s.title)} <span class="ds-muted">${esc(where)} · ${esc(s.id)}</span></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diff Story Mode</title><link rel="stylesheet" href="/assets/local.css"></head>
<body class="ds-index"><main><h1>Diff Story Mode</h1><p class="ds-muted">Stories the bridge can serve. PR stories open on GitHub, where the extension shows the panel. Local stories open here.</p>
<ul class="ds-stories">${rows || '<li class="ds-muted">No stories yet.</li>'}</ul></main></body></html>`;
}

function localPage(id, meta, token) {
  const boot = JSON.stringify({ story: id, token }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title><link rel="stylesheet" href="/assets/local.css">
<script type="application/json" id="ds-boot">${boot}</script>
<script type="module" src="/assets/local.js"></script></head>
<body class="ds-local"><div id="ds-app"><p class="ds-muted ds-loading">Loading the story…</p></div></body></html>`;
}

