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
import { StoryStore, readMeta, refreshLocal, storyVersion } from './stories.mjs';
import { Inbox, newId } from './inbox.mjs';
import { Builds } from './builds.mjs';
import { addComment } from './comments.mjs';
import { statusOf, answerContext, runAutoAnswer } from './health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const OVERLAY = path.resolve(HERE, '../../src/js/shared/overlay.js');
export const VERSION = JSON.parse(readFileSync(path.resolve(HERE, '../../package.json'), 'utf8')).version;

const ASSETS = {
  '/assets/overlay.js': [OVERLAY, 'text/javascript; charset=utf-8'],
  '/assets/local.js': [path.join(PUBLIC, 'local.js'), 'text/javascript; charset=utf-8'],
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
        const sid = url.searchParams.get('story');
        let story;
        if (sid) story = stories.dirOf(sid) ? sid : null;
        else if (url.searchParams.get('repo')) { const hit = stories.find(url.searchParams.get('repo'), url.searchParams.get('number')); story = hit ? hit.id : null; }
        return send(200, statusOf({ home, version: VERSION, story, autoBuild, autoAnswer, extensionSeen }));
      }
      if (p === '/api/stories' && req.method === 'GET') return send(200, { stories: stories.list().map(({ dir, ...s }) => s) });
      if (p === '/api/stories/find' && req.method === 'GET') {
        const hit = stories.find(url.searchParams.get('repo') || '', url.searchParams.get('number'));
        if (!hit) throw new HttpError(404, 'no story for that PR');
        return send(200, { id: hit.id, version: hit.version, title: hit.title });
      }
      // build requests: the page's "Build story" button, and the state it shows (ready, building or none)
      if (p === '/api/builds' && req.method === 'GET') return send(200, { pending: builds.pending() });
      if (p === '/api/builds' && req.method === 'POST') return send(200, { state: 'building', request: builds.request(body) });
      if (p === '/api/builds/status' && req.method === 'GET') {
        const repo = url.searchParams.get('repo') || '';
        const number = url.searchParams.get('number');
        const hit = stories.find(repo, number);
        let b = builds.get(repo, number);
        if (hit && b && b.status === 'pending') b = builds.done(b.id, { story: hit.id }); // the story turned up
        if (hit) return send(200, { state: 'ready', story: hit.id, version: hit.version, title: hit.title, request: b });
        if (b && b.status === 'pending') return send(200, { state: 'building', request: b });
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
      const ctx = { story: id, kind: meta.kind, title: meta.title };

      if (!what && req.method === 'GET') return send(200, stories.load(id));
      if (what === 'version' && req.method === 'GET') {
        if (meta.kind === 'local') refreshLocal(dir, JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')));
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

