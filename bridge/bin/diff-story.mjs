#!/usr/bin/env node
/**
 * diff-story: the Diff Story Mode bridge and its helpers.
 *
 *   diff-story serve   [--port N] [--root DIR]... [--no-scratch]   run the bridge on 127.0.0.1
 *   diff-story setup                                               print the port and token to paste into the extension's options
 *   diff-story token   [--rotate]                                  print (or replace) the token
 *   diff-story list                                                stories the bridge can serve
 *   diff-story local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--no-open]
 *                                                                  story over local commits, served at /local/<id>/
 *   diff-story publish --dir DIR [--id ID]                         copy a pr-story folder into ~/.diff-story/<owner>-<repo>-<N>/
 *   diff-story inbox   [--story ID] [--type question,note,...] [--unread] [--consumer NAME] [--json]
 *   diff-story wait    [--story ID] [--type question] [--consumer NAME] [--timeout SECONDS] [--json]
 *                                                                  block until something new arrives, print it, exit (for a background task);
 *                                                                  a consumer's first wait starts from now
 *   diff-story answer  --question ID (--text T | --file F)          answer a question; the panel shows it
 *   diff-story notes   --story ID [--json]                         fix-before-push notes for a local story
 *
 * DIFF_STORY_HOME moves ~/.diff-story.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, watch } from 'node:fs';
import path from 'node:path';
import { homeDir, loadConfig, saveConfig, newToken } from '../lib/config.mjs';
import { createBridge } from '../lib/server.mjs';
import { StoryStore, readMeta } from '../lib/stories.mjs';
import { createLocalStory, slug } from '../lib/local.mjs';
import { Inbox } from '../lib/inbox.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { root: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (key === 'root') opts.root.push(value);
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
  const server = createBridge({ home, token: cfg.token, roots, scratch: !opts['no-scratch'] });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(`diff-story bridge on http://127.0.0.1:${port} (stories: ${server.stories.list().length}, inbox: ${server.inbox.file})\n`);
      resolve(server);
    });
  });
}

function describe(e) {
  const where = [e.story, e.chapter || (e.step != null ? `step ${e.step}` : ''), e.file].filter(Boolean).join(' · ');
  if (e.type === 'question') return `[${et(e.at)}] question ${e.id} (${where})\n${e.text}`;
  if (e.type === 'answer') return `[${et(e.at)}] answer to ${e.question}\n${e.text}`;
  if (e.type === 'note') return `[${et(e.at)}] note ${e.action} (${e.story}) ${e.note.path}${e.note.line ? `:${e.note.side === 'L' ? 'L' : ''}${e.note.line}` : ''}${e.note.done ? ' [done]' : ''}\n${e.note.body}`;
  if (e.type === 'position') return `[${et(e.at)}] position (${where})`;
  return `[${et(e.at)}] ${e.type} ${JSON.stringify(e)}`;
}

function filterEntries(entries, opts) {
  const types = opts.type ? String(opts.type).split(',') : null;
  return entries.filter(e => (!types || types.includes(e.type)) && (!opts.story || e.story === opts.story));
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
    const made = createLocalStory({ home, repo: path.resolve(opts.repo), base: opts.base, head: opts.head || 'HEAD', chapters: opts.chapters, id: opts.id, title: opts.title });
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
    for (const f of ['chapters.json', 'file-map.json']) if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(dest, f));
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
    const consumer = opts.consumer || 'default';
    const want = { ...opts, type: opts.type || 'question' };
    const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
    if (!existsSync(inbox.file)) writeFileSync(inbox.file, '', { mode: 0o600 });
    // a reader new to the inbox starts from now, not from every old question
    if (!existsSync(inbox.cursorFile(consumer))) inbox.setCursor(consumer, statSync(inbox.file).size);
    for (;;) {
      const entries = filterEntries(inbox.unread(consumer, { advance: true }), want);
      if (entries.length) {
        for (const e of entries) {
          if (opts.json) { out(JSON.stringify(e)); continue; }
          out(describe(e));
          if (e.type === 'question') out(`Answer with: diff-story answer --question ${e.id} --text "…"`);
          out('');
        }
        return;
      }
      if (Date.now() > deadline) { process.exitCode = 2; return; }
      await new Promise(resolve => {
        const w = watch(inbox.file, () => { w.close(); resolve(); });
        setTimeout(() => { w.close(); resolve(); }, 2000);
      });
    }
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
