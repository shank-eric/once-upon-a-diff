#!/usr/bin/env node
/**
 * diff-story: the Diff Story Mode bridge and its helpers.
 *
 *   diff-story serve   [--port N] [--root DIR]... [--no-scratch]   run the bridge on 127.0.0.1
 *   diff-story setup                                               print the port and token to paste into the extension's options
 *   diff-story token   [--rotate]                                  print (or replace) the token
 *   diff-story list                                                stories the bridge can serve
 *   diff-story local   --repo DIR --base REF [--head REF] [--chapters FILE] [--backstory FILE] [--id ID] [--title T] [--no-open]
 *                                                                  story over local commits, served at /local/<id>/
 *   diff-story publish --dir DIR [--id ID]                         copy a pr-story folder into ~/.diff-story/<owner>-<repo>-<N>/
 *   diff-story inbox   [--story ID] [--type question,note,...] [--unread] [--consumer NAME] [--json]
 *   diff-story wait    [--repo OWNER/NAME | --story ID] [--type question,build_request] [--consumer NAME] [--timeout SECONDS] [--json]
 *                                                                  block until a question or build request arrives, print it, exit (for a background task);
 *                                                                  --repo takes both for that repo's stories and PRs; a consumer's first wait starts from now,
 *                                                                  but queued build requests are handed over whenever they were asked
 *   diff-story comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)
 *                                                                  add a drafted comment to a chapter's Draft comments (never posted)
 *   diff-story drafts  --story ID [--json]                         each drafted comment: draft, posted, in your pending review, or dismissed
 *   diff-story doctor  [--port N]                                  is everything connected? a pass/fail list with fixes
 *   diff-story builds  [--start ID]                                pending "Build story" requests, queued or building; --start claims one as it's built
 *   diff-story done    <build id | owner/repo#N> [--failed] [--note TEXT]   finish one (a story turning up finishes it too)
 *   diff-story answer  --question ID (--text T | --file F)          answer a question; the panel shows it
 *   diff-story notes   --story ID [--json]                         fix-before-push notes for a local story
 *   diff-story backstory --repo DIR --base REF [--head REF] [-o FILE] [--brief] [--since ISO] [--until ISO] [--exclude-agent ID]...
 *                                                                  find the Claude Code sessions that made these commits (session-story's
 *                                                                  extractor) and write the evidence for a story's "How it got here" notes
 *
 * DIFF_STORY_HOME moves ~/.diff-story.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, watch } from 'node:fs';
import path from 'node:path';
import { homeDir, loadConfig, saveConfig, newToken } from '../lib/config.mjs';
import { createBridge } from '../lib/server.mjs';
import { StoryStore, readMeta } from '../lib/stories.mjs';
import { createLocalStory, slug } from '../lib/local.mjs';
import { Inbox } from '../lib/inbox.mjs';
import { Builds } from '../lib/builds.mjs';
import { addComment } from '../lib/comments.mjs';
import { stateKeyOf, readMarks, draftStatus, githubComments } from '../lib/drafts.mjs';
import { beat } from '../lib/health.mjs';
import { REPO_RE, sameRepo, repoOfCheckout, seenCheckout } from '../lib/repos.mjs';
import { topLevel } from '../lib/git.mjs';
import { doctor } from '../lib/doctor.mjs';
import { findBackstory, briefOf } from '../lib/backstory.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { root: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o') { opts.o = rest[++i]; continue; }
    if (!a.startsWith('--')) { (opts._ ||= []).push(a); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (key === 'root') opts.root.push(value);
    else if (key === 'exclude-agent') (opts.excludeAgents ||= []).push(value);
    else opts[key] = value;
  }
  return { command, opts };
}

const out = s => process.stdout.write(s + '\n');
const et = iso => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '');

async function probe(port, token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? (await r.json()).name === 'diff-story-bridge' : false;
  } catch { return false; }
}

function serve(home, cfg, opts) {
  const port = Number(opts.port || cfg.port);
  const roots = opts.root.length ? opts.root.map(r => path.resolve(r)) : cfg.roots && cfg.roots.length ? cfg.roots : undefined;
  // the bridge keeps its own log in <home>/bridge.log, for `diff-story doctor`
  const logFile = path.join(home, 'bridge.log');
  const log = line => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`diff-story bridge: ${line}\n`);
    try { appendFileSync(logFile, text, { mode: 0o600 }); } catch { /* the log is a convenience */ }
  };
  const server = createBridge({ home, token: cfg.token, roots, scratch: !opts['no-scratch'], autoBuild: cfg.autoBuild || null, autoAnswer: cfg.autoAnswer || null, log });
  if (cfg.autoBuild && cfg.autoBuild.enabled) log(`autoBuild is on: ${JSON.stringify(cfg.autoBuild.command)}`);
  if (cfg.autoAnswer && cfg.autoAnswer.enabled) log(`autoAnswer is on: ${JSON.stringify(cfg.autoAnswer.command)}`);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`listening on http://127.0.0.1:${port}, pid ${process.pid} (stories: ${server.stories.list().length}, inbox: ${server.inbox.file})`);
      resolve(server);
    });
  });
}

function describe(e) {
  const where = [e.story, e.chapter || (e.step != null ? `step ${e.step}` : ''), e.file].filter(Boolean).join(' · ');
  if (e.type === 'question') return `[${et(e.at)}] question ${e.id} (${where})\n${e.text}`;
  if (e.type === 'build_request') return `[${et(e.at)}] build request ${e.id}: ${e.repo}#${e.number} ${e.url}`;
  if (e.type === 'build_done') return `[${et(e.at)}] build ${e.build} ${e.status} (${e.repo}#${e.number})${e.story ? ` story ${e.story}` : ''}${e.note ? `: ${e.note}` : ''}`;
  if (e.type === 'answer') return `[${et(e.at)}] answer to ${e.question}\n${e.text}`;
  if (e.type === 'note') return `[${et(e.at)}] note ${e.action} (${e.story}) ${e.note.path}${e.note.line ? `:${e.note.side === 'L' ? 'L' : ''}${e.note.line}` : ''}${e.note.done ? ' [done]' : ''}\n${e.note.body}`;
  if (e.type === 'position') return `[${et(e.at)}] position (${where})`;
  return `[${et(e.at)}] ${e.type} ${JSON.stringify(e)}`;
}

function filterEntries(entries, opts) {
  const types = opts.type ? String(opts.type).split(',') : null;
  return entries.filter(e => (!types || types.includes(e.type)) && (!opts.story || e.story === opts.story) && (!opts.repo || sameRepo(e.repo, opts.repo)));
}

const COMMANDS = {
  async serve(home, cfg, opts) {
    await serve(home, cfg, opts);
  },

  setup(home, cfg) {
    out(`Bridge port:  ${cfg.port}`);
    out(`Bridge token: ${cfg.token}`);
    out('');
    out('Paste both into the extension: chrome://extensions → Diff Story Mode → Details → Extension options.');
    out(`Then run: ${path.relative(process.cwd(), process.argv[1]) || 'diff-story'} serve`);
  },

  token(home, cfg, opts) {
    if (opts.rotate) { cfg.token = newToken(); saveConfig(cfg, home); out('New token (paste it into the extension options, then restart the bridge):'); }
    out(cfg.token);
  },

  list(home, cfg, opts) {
    const store = new StoryStore({ home, roots: opts.root.length ? opts.root : cfg.roots, scratch: !opts['no-scratch'] });
    for (const s of store.list()) out(`${s.id}\t${s.kind}\t${s.repo ? `${s.repo}#${s.number}` : ''}\t${s.title}\t${s.dir}`);
  },

  async local(home, cfg, opts) {
    if (!opts.repo || !opts.base) throw new Error('usage: diff-story local --repo DIR --base REF [--head REF] [--chapters FILE]');
    const made = createLocalStory({ home, repo: path.resolve(opts.repo), base: opts.base, head: opts.head || 'HEAD', chapters: opts.chapters, backstory: opts.backstory, id: opts.id, title: opts.title });
    process.stderr.write(`Story ${made.id}: ${made.files} files, ${made.chapters} chapters (${made.dir})\n`);
    if (made.unplaced.length) process.stderr.write(`  ${made.unplaced.length} files aren't in a chapter; they show in a last "Not in a chapter yet" step\n`);
    if (made.unknown.length) process.stderr.write(`  ${made.unknown.length} chapter files aren't in the diff and are skipped: ${made.unknown.join(', ')}\n`);
    const port = Number(opts.port || cfg.port);
    const url = `http://127.0.0.1:${port}/local/${encodeURIComponent(made.id)}/`;
    const running = await probe(port, cfg.token);
    if (!running && !opts['no-serve']) await serve(home, cfg, { ...opts, port });
    else if (!running) process.stderr.write(`No bridge on port ${port}. Start one with: diff-story serve\n`);
    out(url);
    if (!opts['no-open']) execFile('open', [url], () => {});
  },

  publish(home, cfg, opts) {
    if (!opts.dir) throw new Error('usage: diff-story publish --dir <pr-story folder>');
    const src = path.resolve(opts.dir);
    const meta = readMeta(src);
    if (!meta.repo || !meta.number) throw new Error(`${src} doesn't say which PR it is (no pr.json or file-map.json)`);
    const id = opts.id || slug(`${meta.repo.replace('/', '-')}-${meta.number}`);
    const dest = path.join(home, id);
    mkdirSync(dest, { recursive: true });
    for (const f of ['chapters.json', 'file-map.json', 'backstory.json']) if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(dest, f));
    writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({ kind: 'github', repo: meta.repo, number: meta.number, url: meta.url, pr_title: meta.pr_title || null, source: src, published_at: new Date().toISOString() }, null, 2));
    out(dest);
  },

  inbox(home, cfg, opts) {
    const inbox = new Inbox(home);
    const entries = filterEntries(opts.unread ? inbox.unread(opts.consumer || 'default', { advance: true }) : inbox.all(), opts);
    for (const e of entries) out(opts.json ? JSON.stringify(e) : describe(e) + '\n');
  },

  async wait(home, cfg, opts) {
    const inbox = new Inbox(home);
    if (opts.repo && !REPO_RE.test(String(opts.repo))) throw new Error('usage: diff-story wait --repo owner/name');
    // one listener per repo: its own cursor and heartbeat unless --consumer says otherwise
    const consumer = opts.consumer || (opts.repo ? `repo-${String(opts.repo).toLowerCase().replace('/', '-')}` : 'default');
    if (opts.repo) {
      // a wait run from the repo's checkout tells the bridge where that checkout is, for the next prompt
      try { const top = topLevel(process.cwd()); if (sameRepo(repoOfCheckout(top), opts.repo)) seenCheckout(home, opts.repo, top); } catch { /* not in a checkout */ }
    }
    const scope = { ...(opts.repo ? { repo: String(opts.repo) } : {}), ...(opts.story ? { story: String(opts.story) } : {}) };
    const want = { ...opts, type: opts.type || 'question,build_request' };
    const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
    if (!existsSync(inbox.file)) writeFileSync(inbox.file, '', { mode: 0o600 });
    // a reader new to the inbox starts from now, not from every old question
    if (!existsSync(inbox.cursorFile(consumer))) inbox.setCursor(consumer, statSync(inbox.file).size);
    // the heartbeat the panel's "Claude listening" light reads
    beat(home, consumer, 'waiting', scope);
    const hb = setInterval(() => beat(home, consumer, 'waiting', scope), 5000);
    try { await waitLoop(); } finally { clearInterval(hb); } // an error mustn't leave the heartbeat running
    async function waitLoop() {
    // build requests come from builds.json (queued ones, claimed as they're handed over), so none are missed or given twice
    const builds = !opts.story && want.type.split(',').includes('build_request') ? new Builds(home, inbox) : null;
    for (;;) {
      let entries = filterEntries(inbox.unread(consumer, { advance: true }), want).filter(e => e.type !== 'build_request');
      if (builds) entries = [...entries, ...builds.toHand(consumer, { repo: opts.repo || null })];
      if (entries.length) {
        clearInterval(hb);
        beat(home, consumer, 'handling', { ...scope, question: entries[0].id });
        for (const e of entries) {
          if (opts.json) { out(JSON.stringify(e)); continue; }
          out(describe(e));
          if (e.type === 'question') out(`Answer with: diff-story answer --question ${e.id} --text "…"`);
          if (e.type === 'build_request') out(`Run diff-story builds --start ${e.id}, write the story (pr-story renders and publishes it), then: diff-story done ${e.id}`);
          out('');
        }
        return;
      }
      if (Date.now() > deadline) { clearInterval(hb); process.exitCode = 2; return; }
      await new Promise(resolve => {
        const w = watch(inbox.file, () => { w.close(); resolve(); });
        setTimeout(() => { w.close(); resolve(); }, 2000);
      });
    }
    }
  },

  comment(home, cfg, opts) {
    const body = opts['body-file'] ? readFileSync(opts['body-file'], 'utf8') : typeof opts.body === 'string' ? opts.body : '';
    if (!opts.story || !opts.chapter || !body.trim()) throw new Error('usage: diff-story comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)');
    const store = new StoryStore({ home, roots: opts.root.length ? opts.root : cfg.roots, scratch: true });
    const dir = store.dirOf(opts.story);
    if (!dir) throw new Error(`no story ${opts.story} (see: diff-story list)`);
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { meta = {}; }
    const r = addComment(dir, meta, { chapter: opts.chapter, path: typeof opts.path === 'string' ? opts.path : '', line: opts.line, body });
    if (r.added) new Inbox(home).append({ type: 'comment', story: opts.story, chapter: r.chapter, comment: r.comment });
    out(`${r.added ? 'Added to' : 'Already in'} chapter ${r.chapter}'s draft comments (${r.files.join(', ')}). The panel shows it within a few seconds.`);
  },

  async drafts(home, cfg, opts) {
    if (!opts.story) throw new Error('usage: diff-story drafts --story ID [--json]');
    const store = new StoryStore({ home, roots: opts.root.length ? opts.root : cfg.roots, scratch: true });
    const dir = store.dirOf(opts.story);
    if (!dir) throw new Error(`no story ${opts.story}`);
    const meta = readMeta(dir);
    const data = store.load(opts.story);
    let ghc = null;
    if (meta.kind === 'github') { try { ghc = await githubComments(meta.repo, meta.number); } catch (e) { process.stderr.write(`gh: ${e.message}\n`); } }
    const rows = draftStatus(data.chapters, readMarks(home, stateKeyOf(opts.story, meta)), ghc);
    if (opts.json) return out(JSON.stringify(rows, null, 2));
    for (const r of rows) {
      const c = data.chapters[r.chapter - 1].comments[r.index];
      out(`ch ${r.chapter} #${r.index + 1}  ${r.dismissed ? 'dismissed' : r.status}${r.source === 'manual' ? ' (marked)' : ''}  ${c.path}${c.line ? `:${c.line}` : ''}  ${c.body.replace(/\s+/g, ' ').slice(0, 70)}${r.url ? `  ${r.url}` : ''}`);
    }
  },

  async doctor(home, cfg, opts) {
    const ok = await doctor(home, cfg, { port: opts.port, out });
    if (!ok) process.exitCode = 1;
  },

  builds(home, cfg, opts) {
    const builds = new Builds(home, new Inbox(home));
    if (opts.start) {
      // the session says it's building this one now: the badges move from Queued to Building
      const b = builds.claim(String(opts.start), opts.consumer || 'cli', { start: true });
      if (!b) throw new Error(`no pending build request ${opts.start}`);
      return out(`${b.id} building (${b.repo}#${b.number})`);
    }
    const pending = builds.pending();
    if (!pending.length) return out('No pending build requests.');
    for (const b of pending) out(`${b.id}\t${builds.stateOf(b)}\t${b.repo}#${b.number}\t${et(b.requested_at)}\t${b.url}`);
  },

  done(home, cfg, opts) {
    const id = (opts._ || [])[0] || opts.id;
    if (!id) throw new Error('usage: diff-story done <build id | owner/repo#N> [--failed] [--note TEXT]');
    const b = new Builds(home, new Inbox(home)).done(id, { failed: !!opts.failed, note: typeof opts.note === 'string' ? opts.note : null });
    if (!b) throw new Error(`no build request ${id}`);
    out(`${b.id} ${b.status} (${b.repo}#${b.number})`);
  },

  answer(home, cfg, opts) {
    const inbox = new Inbox(home);
    const text = opts.file ? readFileSync(opts.file, 'utf8') : opts.text;
    if (!opts.question || !text || text === true) throw new Error('usage: diff-story answer --question ID (--text T | --file F)');
    const q = inbox.questions().find(x => x.id === opts.question);
    if (!q) throw new Error(`no question ${opts.question}`);
    const a = inbox.append({ type: 'answer', question: q.id, story: q.story, text: String(text).trim() });
    out(a.id);
  },

  backstory(home, cfg, opts) {
    if (!opts.repo || !opts.base) throw new Error('usage: diff-story backstory --repo DIR --base REF [--head REF] [-o FILE] [--brief]');
    const b = findBackstory({
      repo: path.resolve(opts.repo), base: opts.base, head: opts.head || 'HEAD', since: opts.since, until: opts.until,
      excludeAgents: opts.excludeAgents, work: opts.work, log: s => process.stderr.write(s + '\n'),
    });
    const file = opts.o || opts.out;
    if (file) writeFileSync(path.resolve(file), JSON.stringify(b, null, 2));
    process.stderr.write(b.found
      ? `Backstory: ${b.moments.length} moments in ${b.sessions.length} session(s); ${Object.keys(b.files).length - b.unmatched.length} of ${Object.keys(b.files).length} files matched, `
        + `${b.commits.filter(c => c.made_in).length} of ${b.commits.length} commits${file ? ` (${file})` : ''}\n`
      : `No backstory: ${b.reason || 'no Claude Code session made these changes'}\n`);
    if (opts.brief || !file) out(JSON.stringify(opts.brief ? briefOf(b) : b, null, 2));
  },

  notes(home, cfg, opts) {
    if (!opts.story) throw new Error('usage: diff-story notes --story ID');
    const store = new StoryStore({ home, roots: cfg.roots, scratch: false });
    const notes = store.readState(opts.story, 'notes.json', []);
    if (opts.json) return out(JSON.stringify(notes, null, 2));
    if (!notes.length) return out('No fix-before-push notes.');
    for (const n of notes) out(`- [${n.done ? 'x' : ' '}] ${n.path}${n.line ? `:${n.side === 'L' ? 'L' : ''}${n.line}` : ''}: ${n.body.replace(/\n/g, ' ')}`);
  },
};

const { command, opts } = parseArgs(process.argv.slice(2));
const run = COMMANDS[command];
if (!run) {
  process.stderr.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '') + '\n');
  process.exitCode = 1;
} else {
  const home = homeDir();
  Promise.resolve()
    .then(() => run(home, loadConfig(home), opts))
    .catch(err => { process.stderr.write(`diff-story: ${err.message}\n`); process.exitCode = 1; });
}
