/**
 * Backstory: how a commit range got the way it is, from the Claude Code
 * sessions that made it.
 *
 * The result story (the journey chapters) stays primary. This only gathers
 * evidence a story writer (Claude, following the pr-story skill) turns into
 * short "How it got here" notes per chapter, per file and per line range.
 *
 * How a session is matched to the range:
 *   1. Candidates: transcripts under ~/.claude/projects (main and subagent
 *      ones) changed since the window opened that mention a checkout of the
 *      repo (the repo or any of its worktrees) or a commit SHA in the range.
 *   2. Each candidate's session is read with session-story's own extractor
 *      (`story.mjs extract --no-chain`, never modified, never imported), which
 *      links each turn to its edits and commands, subagents included.
 *   3. Evidence, kept only inside the time window:
 *        edit    an Edit/Write on a file of the diff, in any checkout of the repo
 *        commit  a `git commit` whose subject (or printed SHA) is a commit in the range
 *        check   a lint/test/build command run in a checkout
 *        shell   a write-ish shell command naming a diff file (sed -i, a script, --fix)
 *      A session or agent with no evidence (it only read or grepped) is dropped.
 *   4. Lines: the added lines of each edit and of each commit are found in the
 *      final diff's new side, so a moment can point at line ranges.
 *   5. Context the extractor doesn't carry is read from the raw transcripts:
 *      what the user said (prompts, and voice through Larmor's listen results),
 *      the task and follow-ups the main session sent each agent, the agents'
 *      hand-back reports, and what Claude said aloud, near the evidence only.
 *
 * Nothing here writes outside the output file and a scratch folder for the
 * extractor's output.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff } from './diff.mjs';

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const HOME = os.homedir();
const MIN = 60 * 1000;
const clip = (s, n) => {
  const t = String(s || '')
    .replace(/\s+\n/g, '\n')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

export const defaultClaudeDir = () => path.join(HOME, '.claude', 'projects');
export const defaultSessionStory = () =>
  process.env.SESSION_STORY_DIR || path.join(HOME, '.claude', 'skills', 'session-story');

/** The commit range: commits, their files and added lines, and the final diff. */
export function readRange(repo, base, head = 'HEAD') {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const baseOid = git(top, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const headOid = git(top, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const roots = new Set([top]);
  try {
    for (const line of git(top, ['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ')) {
        roots.add(line.slice(9));
      }
    }
  } catch {
    /* no worktrees */
  }
  // macOS: /var and /tmp are links into /private, and transcripts keep whichever spelling the session used
  for (const r of [...roots]) {
    if (r.startsWith('/private/')) {
      roots.add(r.slice(8));
    }
  }
  const log = git(top, ['log', '--format=%H%x09%aI%x09%cI%x09%s', `${baseOid}..${headOid}`]).trim();
  const commits = (log ? log.split('\n') : [])
    .map((l) => {
      const [sha, authored, at, subject] = l.split('\t');
      const diff = parseUnifiedDiff(
        git(top, [
          '-c',
          'core.quotePath=false',
          'show',
          '--no-color',
          '--no-ext-diff',
          '--format=',
          '--unified=0',
          sha,
        ]),
      );
      return {
        sha,
        short: sha.slice(0, 11),
        authored,
        at,
        subject,
        files: [...diff.keys()],
        added: addedByFile(diff),
      };
    })
    .reverse();
  const final = parseUnifiedDiff(
    git(top, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      baseOid,
      headOid,
    ]),
  );
  return { top, roots: [...roots], base, head, baseOid, headOid, commits, final };
}

/** rel -> [added line text] for a parsed diff. */
function addedByFile(diff) {
  const out = {};
  for (const [rel, f] of diff) {
    out[rel] = f.hunks.flatMap((h) =>
      h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)),
    );
  }
  return out;
}

/** rel -> Map(trimmed text -> [new-side line numbers]) for the added lines of the final diff. */
function finalLineIndex(final) {
  const idx = {};
  for (const [rel, f] of final) {
    const m = new Map();
    for (const h of f.hunks) {
      let n = h.newStart;
      for (const l of h.lines) {
        if (l.startsWith('+')) {
          const t = l.slice(1).trim();
          if (t && t.length > 2) {
            if (!m.has(t)) {
              m.set(t, []);
            }
            m.get(t).push(n);
          }
          n++;
        } else if (l.startsWith(' ')) {
          n++;
        }
      }
    }
    idx[rel] = m;
  }
  return idx;
}

/** Added line texts -> merged [start, end] ranges on the final diff's new side. */
function rangesFor(index, rel, texts) {
  const m = index[rel];
  if (!m) {
    return [];
  }
  const nums = new Set();
  for (const t of texts) {
    for (const n of m.get(String(t).trim()) || []) {
      nums.add(n);
    }
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n <= last[1] + 2) {
      last[1] = n;
    } else {
      out.push([n, n]);
    }
  }
  return out;
}

// ---------- finding candidate transcripts

function* transcriptFiles(claudeDir, sinceMs) {
  let projects = [];
  try {
    projects = readdirSync(claudeDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const p of projects) {
    const pdir = path.join(claudeDir, p.name);
    let entries = [];
    try {
      entries = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        yield {
          file: path.join(pdir, e.name),
          project: p.name,
          session: e.name.slice(0, -6),
          agent: null,
        };
      }
      if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try {
          subs = readdirSync(sub).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of subs) {
          yield {
            file: path.join(sub, f),
            project: p.name,
            session: e.name,
            agent: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
          };
        }
      }
    }
  }
  void sinceMs;
}

/** Sessions whose transcripts (or their subagents') mention the repo's checkouts or the range's commits. */
export function candidateSessions({ claudeDir, range, sinceMs }) {
  const needles = new Set();
  for (const r of range.roots) {
    needles.add(r);
    if (r.startsWith(HOME)) {
      needles.add('~' + r.slice(HOME.length));
    }
  }
  for (const c of range.commits) {
    needles.add(c.sha.slice(0, 9));
  }
  const out = new Map();
  for (const t of transcriptFiles(claudeDir, sinceMs)) {
    let st;
    try {
      st = statSync(t.file);
    } catch {
      continue;
    }
    if (st.mtimeMs < sinceMs) {
      continue;
    }
    let text;
    try {
      text = readFileSync(t.file, 'utf8');
    } catch {
      continue;
    }
    if (![...needles].some((n) => text.includes(n))) {
      continue;
    }
    const main = path.join(claudeDir, t.project, `${t.session}.jsonl`);
    if (!existsSync(main)) {
      continue;
    }
    const c = out.get(t.session) || {
      session: t.session,
      project: t.project,
      transcript: main,
      agents: [],
    };
    if (t.agent) {
      c.agents.push(t.agent);
    }
    out.set(t.session, c);
  }
  for (const c of out.values()) {
    c.cwd = sessionCwd(c.transcript);
  }
  return [...out.values()].filter((c) => c.cwd);
}

function sessionCwd(file) {
  const fd = readFileSync(file, 'utf8');
  let i = 0;
  for (const line of fd.split('\n')) {
    if (++i > 400) {
      break;
    }
    try {
      const r = JSON.parse(line);
      if (r.cwd) {
        return r.cwd;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// ---------- session-story's extractor, through its CLI

// A message from another Claude Code session (SendMessage across sessions) starts a turn like a
// prompt, but the harness records it as a meta user record, so session-story's extractor skips it.
// A session driven only by such messages would come out with no turns at all.
const isPeer = (r) => r && r.type === 'user' && r.isMeta && r.origin && r.origin.kind === 'peer';
const peerText = (r) =>
  String(r.origin.body || textOf(r.message && r.message.content) || '').trim();

/**
 * The Claude dir to hand the extractor for this candidate. When the main transcript has peer
 * messages, a copy goes in the scratch folder with each one written as a plain prompt (its
 * body), and the session's folder (subagents, tool results) is linked beside it.
 */
function extractorClaudeDir({ claudeDir, project, session, transcript, work }) {
  const lines = readFileSync(transcript, 'utf8').split('\n');
  let peers = 0;
  const out = lines.map((line) => {
    if (!line.includes('"peer"')) {
      return line;
    }
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isPeer(r)) {
      return line;
    }
    peers++;
    const { isMeta, ...rest } = r;
    void isMeta;
    return JSON.stringify({
      ...rest,
      message: { ...(r.message || {}), role: 'user', content: peerText(r) },
    });
  });
  if (!peers) {
    return claudeDir;
  }
  const dir = path.join(work, 'claude', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${session}.jsonl`), out.join('\n'));
  const folder = path.join(claudeDir, project, session);
  const link = path.join(dir, session);
  if (existsSync(folder) && !existsSync(link)) {
    symlinkSync(folder, link);
  }
  return path.join(work, 'claude');
}

export function extractSession({
  sessionStory,
  session,
  cwd,
  claudeDir,
  work,
  project,
  transcript,
}) {
  mkdirSync(work, { recursive: true });
  if (project && transcript) {
    claudeDir = extractorClaudeDir({ claudeDir, project, session, transcript, work });
  }
  const out = path.join(work, `${session}.json`);
  execFileSync(
    'node',
    [
      path.join(sessionStory, 'bin', 'story.mjs'),
      'extract',
      '--session',
      session,
      '--cwd',
      cwd,
      '--claude-dir',
      claudeDir,
      '--no-chain',
      '-o',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], cwd, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(readFileSync(out, 'utf8'));
}

// ---------- raw transcript context the extractor doesn't keep

function records(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line */
    }
  }
  return out;
}
const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
      : '';
const resultText = (b) =>
  typeof b.content === 'string'
    ? b.content
    : Array.isArray(b.content)
      ? b.content.map((x) => x.text || '').join('')
      : '';
const SAID_RE =
  /the user said(?: \(by voice\))?:\s*\\?n?\s*\\?"?([\s\S]*?)\\?"?\s*(?:\\n|\n)\s*This will NOT come through/;
const isNoise = (t) =>
  !t || /^\(silence\)$/i.test(t) || /^MCP tool "larmor\/listen" is still running/.test(t);

/** Main transcript: what the user said, what Claude said aloud, and what the main session sent agents. */
function mainContext(file) {
  const names = new Map(); // tool_use id -> tool name
  const ctx = { heard: [], spoke: [], spawned: [], sent: [], prompts: [], peers: [] };
  for (const r of records(file)) {
    const at = r.timestamp;
    const c = r.message && r.message.content;
    if (isPeer(r)) {
      ctx.peers.push({ at, from: r.origin.name || 'another session', text: peerText(r) });
      continue;
    }
    if (
      r.type === 'user' &&
      !r.isMeta &&
      typeof c === 'string' &&
      !/^<(command|local-command|system-reminder)/.test(c.trim())
    ) {
      ctx.prompts.push({ at, text: c.trim() });
    }
    if (!Array.isArray(c)) {
      continue;
    }
    for (const b of c) {
      if (!b) {
        continue;
      }
      if (b.type === 'text' && r.type === 'user') {
        const m = /\[Larmor\] While you were working, the user said[^:]*:\s*([\s\S]*)/.exec(
          b.text || '',
        );
        if (m) {
          ctx.heard.push({ at, text: m[1].trim().replace(/^"|"$/g, ''), via: 'voice' });
        } else if (
          !/^<(command|local-command|system-reminder)|^\[Request interrupted/.test(
            (b.text || '').trim(),
          ) &&
          !r.isMeta &&
          !r.toolUseResult
        ) {
          ctx.prompts.push({ at, text: (b.text || '').trim() });
        }
      }
      if (b.type === 'tool_use') {
        names.set(b.id, b.name);
        const inp = b.input || {};
        if (/larmor__speak$/.test(b.name)) {
          ctx.spoke.push({ at, text: String(inp.text || inp.message || '') });
        }
        if (b.name === 'Agent' || b.name === 'Task') {
          ctx.spawned.push({
            at,
            id: b.id,
            name: inp.name || null,
            description: inp.description || '',
            text: String(inp.prompt || ''),
          });
        }
        if (b.name === 'SendMessage') {
          ctx.sent.push({ at, to: inp.to, text: String(inp.message || '') });
        }
      }
      if (b.type === 'tool_result') {
        const name = names.get(b.tool_use_id) || '';
        const txt = resultText(b);
        if (/larmor__listen$/.test(name)) {
          let t = txt;
          try {
            t = JSON.parse(txt).result ?? txt;
          } catch {
            /* plain text */
          }
          t = String(t).replace(/^\(you were cut off mid-sentence\)\s*/, '');
          if (!isNoise(t)) {
            ctx.heard.push({ at, text: t, via: 'voice' });
          }
        } else if (/the user said/.test(txt)) {
          const m = SAID_RE.exec(txt);
          if (m) {
            ctx.heard.push({
              at,
              text: m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim(),
              via: 'voice',
            });
          }
        }
      }
    }
  }
  ctx.prompts = ctx.prompts.filter(
    (p) =>
      p.text &&
      p.text.length > 8 &&
      !/^<|^Caveat:/.test(p.text) &&
      !/^(voice (on|off)|call listen|next|yes|ok)\.?$/i.test(p.text.trim()),
  );
  return ctx;
}

/** Subagent transcript: its task, the follow-ups it got and what it handed back. */
function agentContext(file) {
  const ctx = { task: null, followups: [], reports: [], meta: {} };
  try {
    ctx.meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    /* older harness */
  }
  for (const r of records(file)) {
    const at = r.timestamp;
    const c = r.message && r.message.content;
    if (r.type === 'user' && !r.toolUseResult) {
      const t = textOf(c).trim();
      if (t && !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(t)) {
        if (!ctx.task) {
          ctx.task = { at, text: t };
        } else {
          ctx.followups.push({ at, text: t.replace(/<\/?system-reminder[^>]*>/g, '').trim() });
        }
      }
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_use' && b.name === 'SubagentHandback') {
          ctx.reports.push({ at, text: String((b.input || {}).message || '') });
        }
        if (
          b &&
          b.type === 'text' &&
          r.type === 'user' &&
          /The coordinator sent a message/.test(b.text || '')
        ) {
          ctx.followups.push({ at, text: b.text.replace(/<\/?system-reminder[^>]*>/g, '').trim() });
        }
      }
    }
  }
  return ctx;
}

// ---------- evidence from the extractor's story

const COMMIT_RE = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/;
const WRITE_RE =
  /\bsed\s+-i|\bperl\s+-p?i|\bpython3?\b[^|]*<<|\bnode\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print)\s|--fix\b|--write\b|\bgit\s+(apply|checkout|restore)\b/;
// a redirect or tee counts only when it writes to a file of the diff, not to a scratch file or a log
const REDIRECT_RE = /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"';&|<>]+)/g;
const isWrite = (cmd, rels) =>
  WRITE_RE.test(cmd) ||
  [...cmd.matchAll(REDIRECT_RE)].some((m) =>
    rels.some(
      (rel) =>
        m[1] === rel ||
        m[1].endsWith('/' + rel) ||
        (rel.includes('/') && m[1].endsWith(rel.split('/').slice(-2).join('/'))),
    ),
  );

function evidenceFromStory(story, range, win, index) {
  const home = (r) => (r.startsWith(HOME) ? '~' + r.slice(HOME.length) : r);
  // a checkout's path, not a longer sibling's (~/x/repo is not ~/x/repo-worktrees/y)
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = new Map(
    range.roots.map((r) => [r, new RegExp(`(?:${esc(r)}|${esc(home(r))})(?=[\\s/;&|'")]|$)`)]),
  );
  const mentions = (cmd, r) => pathRe.get(r).test(cmd);
  const inRoot = (cmd) => range.roots.some((r) => mentions(cmd, r));
  const finalRels = [...range.final.keys()];
  const relOf = (file) => {
    for (const r of range.roots) {
      if (file.startsWith(r + '/')) {
        return file.slice(r.length + 1);
      }
    }
    return null;
  };
  const when = new Map(
    ((story.trace && story.trace.events) || []).map((e) => [e.id, e.started_at]),
  );
  const inWin = (at) => {
    const t = ms(at);
    return Number.isFinite(t) && t >= win.start && t <= win.end;
  };
  const ev = [];
  // the checkouts this range was made in: where its commits were run and its files edited.
  // Checks and scripts elsewhere (another worktree of the same repo) belong to other work.
  const active = new Set();
  for (const t of story.turns) {
    for (const e of t.edits || []) {
      const r = range.roots.find((x) => (e.file || '').startsWith(x + '/'));
      if (r && range.final.has(relOf(e.file))) {
        active.add(r);
      }
    }
    for (const b of t.bash || []) {
      const cmd = String(b.command || '');
      if (COMMIT_RE.test(cmd) && range.commits.some((c) => cmd.includes(c.subject))) {
        for (const r of range.roots) {
          if (mentions(cmd, r)) {
            active.add(r);
          }
        }
      }
    }
  }
  const inActive = (cmd) => [...(active.size ? active : range.roots)].some((r) => mentions(cmd, r));
  for (const t of story.turns) {
    for (const e of t.edits || []) {
      const rel = relOf(e.file || '');
      if (!rel || !range.final.has(rel)) {
        continue;
      }
      const at = when.get(e.id) || t.at;
      if (!inWin(at)) {
        continue;
      }
      const added = (e.hunks || []).flatMap((h) =>
        h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)),
      );
      const fromStrings = !added.length && e.new_string ? String(e.new_string).split('\n') : [];
      ev.push({
        type: 'edit',
        at,
        turn: t.index,
        agent: e.by_subagent || null,
        rel,
        tool: e.tool,
        stats: e.stats,
        lines: rangesFor(index, rel, added.length ? added : fromStrings),
      });
    }
    for (const b of t.bash || []) {
      const cmd = String(b.command || '');
      if (!inWin(b.at) || !inRoot(cmd)) {
        continue;
      }
      if (!COMMIT_RE.test(cmd) && !inActive(cmd)) {
        continue;
      }
      const agent = b.by_subagent || null;
      const named = finalRels.filter(
        (rel) =>
          cmd.includes(rel) ||
          (rel.includes('/') && cmd.includes(rel.split('/').slice(-2).join('/'))),
      );
      if (COMMIT_RE.test(cmd)) {
        const printed = [
          ...String(b.output_tail || '').matchAll(/\[[^\]\s]+ ([0-9a-f]{7,40})\]/g),
        ].map((m) => m[1]);
        const hits = range.commits.filter(
          (c) => cmd.includes(c.subject) || printed.some((p) => c.sha.startsWith(p)),
        );
        for (const c of hits) {
          ev.push({ type: 'commit', at: b.at, turn: t.index, agent, sha: c.sha, ok: b.ok });
        }
        if (hits.length) {
          continue;
        }
      }
      const bare = cmd
        .replace(/^(cd [^;&]+(&&|;)\s*)+/, '')
        .replace(/^(export [^;&]+(&&|;)\s*|unset [^;&]+(&&|;)\s*)+/, '');
      if (
        ['test', 'lint', 'build'].includes(b.category) &&
        !isWrite(cmd, named) &&
        !/^(git|gh)\b/.test(bare)
      ) {
        ev.push({
          type: 'check',
          at: b.at,
          turn: t.index,
          agent,
          category: b.category,
          ok: b.ok,
          command: clip(cmd.replace(/^cd [^;&]+(&&|;)\s*/, ''), 220),
          rels: named,
        });
        continue;
      }
      if (isWrite(cmd, named) && (named.length || /\.py\b|<<'?PY/.test(cmd))) {
        ev.push({
          type: 'shell',
          at: b.at,
          turn: t.index,
          agent,
          command: clip(cmd.replace(/^cd [^;&]+(&&|;)\s*/, ''), 220),
          rels: named,
          ok: b.ok,
        });
      } else {
        ev.push({ type: 'look', at: b.at, turn: t.index, agent, rels: named });
      }
    }
  }
  return ev;
}

// ---------- putting it together

/**
 * @param {{repo: string, base: string, head?: string, claudeDir?: string, sessionStory?: string, work?: string,
 *   since?: string, until?: string, excludeAgents?: string[], log?: (s: string) => void}} opts
 */
export function findBackstory(opts) {
  const log = opts.log || (() => {});
  const claudeDir = opts.claudeDir || defaultClaudeDir();
  const sessionStory = opts.sessionStory || defaultSessionStory();
  const work = opts.work || path.join(os.tmpdir(), `diff-story-backstory-${process.pid}`);
  const range = readRange(opts.repo, opts.base, opts.head || 'HEAD');
  const exclude = new Set(opts.excludeAgents || []);
  const times = range.commits.flatMap((c) => [ms(c.authored), ms(c.at)]).filter(Number.isFinite);
  const win = {
    start: opts.since
      ? ms(opts.since)
      : (times.length ? Math.min(...times) : Date.now()) - 24 * 60 * MIN,
    end: opts.until ? ms(opts.until) : (times.length ? Math.max(...times) : Date.now()) + 45 * MIN,
  };
  const base = {
    repo: range.top,
    base: range.base,
    head: range.head,
    base_oid: range.baseOid,
    head_oid: range.headOid,
    window: { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() },
    commits: range.commits.map((c) => ({
      sha: c.sha,
      short: c.short,
      at: c.at,
      subject: c.subject,
      files: c.files,
      made_in: null,
    })),
  };
  if (!existsSync(path.join(sessionStory, 'bin', 'story.mjs'))) {
    return {
      ...base,
      found: false,
      reason: `session-story isn't installed at ${sessionStory}`,
      sessions: [],
      moments: [],
      files: {},
      unmatched: [...range.final.keys()],
    };
  }

  const index = finalLineIndex(range.final);
  const cands = candidateSessions({ claudeDir, range, sinceMs: win.start });
  log(
    `${cands.length} candidate session(s): ${cands.map((c) => c.session.slice(0, 8)).join(', ') || 'none'}`,
  );
  const sessions = [];
  const moments = [];
  for (const c of cands) {
    let story;
    try {
      story = extractSession({
        sessionStory,
        session: c.session,
        cwd: c.cwd,
        claudeDir,
        work,
        project: c.project,
        transcript: c.transcript,
      });
    } catch (e) {
      log(
        `  ${c.session.slice(0, 8)}: the extractor failed (${String(e.stderr || e.message)
          .trim()
          .split('\n')
          .pop()})`,
      );
      continue;
    }
    const ev = evidenceFromStory(story, range, win, index).filter((e) => !exclude.has(e.agent));
    // an agent (or the main session) that only looked at the checkout is not part of the story
    const doers = new Set(
      ev
        .filter(
          (e) => e.type === 'edit' || e.type === 'commit' || (e.type === 'shell' && e.rels.length),
        )
        .map((e) => e.agent || 'main'),
    );
    const kept = ev.filter((e) => doers.has(e.agent || 'main') && e.type !== 'look');
    // a turn of a doer counts only if it did something to the range in that turn
    const doingTurns = new Set(
      kept
        .filter(
          (e) => e.type === 'edit' || e.type === 'commit' || (e.type === 'shell' && e.rels.length),
        )
        .map((e) => `${e.turn}:${e.agent || 'main'}`),
    );
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!doingTurns.has(`${kept[i].turn}:${kept[i].agent || 'main'}`)) {
        kept.splice(i, 1);
      }
    }
    if (!kept.length) {
      log(`  ${c.session.slice(0, 8)}: no edits, commits or checks in range`);
      continue;
    }
    const main = mainContext(c.transcript);
    const agentDir = path.join(path.dirname(c.transcript), c.session, 'subagents');
    const agents = {};
    for (const id of doers) {
      if (id === 'main') {
        continue;
      }
      const file = path.join(agentDir, `agent-${id}.jsonl`);
      const actx = existsSync(file)
        ? agentContext(file)
        : { task: null, followups: [], reports: [], meta: {} };
      const spawn = main.spawned.find(
        (s) =>
          (actx.meta.toolUseId && s.id === actx.meta.toolUseId) ||
          (actx.meta.name && s.name === actx.meta.name),
      );
      agents[id] = {
        id,
        name: actx.meta.name || (spawn && spawn.name) || null,
        description: actx.meta.description || (spawn && spawn.description) || '',
        ctx: actx,
        spawn,
      };
    }
    sessions.push({
      id: c.session,
      cwd: c.cwd,
      project: c.project,
      title: story.session.ai_title || story.session.title || null,
      started_at: story.session.started_at,
      ended_at: story.session.ended_at,
      transcript: c.transcript,
      resume: `claude --resume ${c.session}`,
      agents: Object.fromEntries(
        Object.values(agents).map((a) => [a.id, { name: a.name, description: a.description }]),
      ),
    });

    // one moment per (turn, agent): a prompt or a task, and what came of it
    const groups = new Map();
    for (const e of kept) {
      const key = `${e.turn}:${e.agent || 'main'}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(e);
    }
    for (const [key, list] of groups) {
      list.sort((a, b) => ms(a.at) - ms(b.at));
      const [turnNo, who] = key.split(':');
      const turn = story.turns.find((t) => t.index === Number(turnNo));
      const from = ms(list[0].at);
      const to = ms(list[list.length - 1].at);
      const near = (at, before, after) => {
        const t = ms(at);
        return t >= from - before && t <= to + after;
      };
      const agent = who === 'main' ? null : agents[who];
      const asks = [];
      const spoke = [];
      const reports = [];
      if (agent) {
        const name = agent.name;
        if (agent.ctx.task && near(agent.ctx.task.at, 20 * MIN, 0)) {
          asks.push({ at: agent.ctx.task.at, via: 'task', text: clip(agent.ctx.task.text, 900) });
        }
        for (const s of main.sent) {
          if (name && s.to === name && near(s.at, 20 * MIN, 15 * MIN)) {
            asks.push({ at: s.at, via: 'message', text: clip(s.text, 900) });
          }
        }
        for (const r of agent.ctx.reports) {
          if (near(r.at, 0, 30 * MIN)) {
            reports.push({ at: r.at, text: clip(r.text, 1600) });
          }
        }
        // what the user said just before the main session wrote to this agent
        const sends = asks.map((a) => ms(a.at));
        for (const h of main.heard) {
          if (sends.some((t) => ms(h.at) <= t && ms(h.at) >= t - 3 * MIN)) {
            asks.push({ at: h.at, via: 'voice', who: 'user', text: clip(h.text, 500) });
          }
        }
        for (const p of main.prompts) {
          if (sends.some((t) => ms(p.at) <= t && ms(p.at) >= t - 5 * MIN)) {
            asks.push({ at: p.at, via: 'prompt', who: 'user', text: clip(p.text, 500) });
          }
        }
      } else {
        for (const h of main.heard) {
          if (near(h.at, 6 * MIN, MIN / 2)) {
            asks.push({ at: h.at, via: 'voice', who: 'user', text: clip(h.text, 500) });
          }
        }
        for (const p of main.prompts) {
          if (near(p.at, 10 * MIN, 0)) {
            asks.push({ at: p.at, via: 'prompt', who: 'user', text: clip(p.text, 500) });
          }
        }
        // a message from another session: the one that started this turn, and any that came in during it.
        // Earlier ones started their own turns (often a read-only question), so they aren't this moment's ask.
        const turnAt = turn ? ms(turn.at) : from - 10 * MIN;
        for (const p of main.peers) {
          if (ms(p.at) >= turnAt - 5000 && ms(p.at) <= to) {
            asks.push({ at: p.at, via: 'peer', who: p.from, text: clip(p.text, 900) });
          }
        }
        for (const s of main.spoke) {
          if (near(s.at, 5 * MIN, 2 * MIN)) {
            spoke.push({ at: s.at, text: clip(s.text, 500) });
          }
        }
      }
      const dedupe = (arr) =>
        arr
          .filter((x, i) => arr.findIndex((y) => y.text === x.text) === i)
          .sort((a, b) => ms(a.at) - ms(b.at));
      const edits = list.filter((e) => e.type === 'edit');
      const commits = list.filter((e) => e.type === 'commit');
      const lines = {};
      const addLines = (rel, rs) => {
        if (rs.length) {
          (lines[rel] ||= []).push(...rs);
        }
      };
      for (const e of edits) {
        addLines(e.rel, e.lines);
      }
      for (const e of commits) {
        const cm = range.commits.find((x) => x.sha === e.sha);
        if (cm) {
          for (const rel of cm.files) {
            addLines(rel, rangesFor(index, rel, cm.added[rel] || []));
          }
        }
      }
      const files = new Set([...edits.map((e) => e.rel), ...list.flatMap((e) => e.rels || [])]);
      for (const e of commits) {
        for (const rel of (range.commits.find((x) => x.sha === e.sha) || { files: [] }).files) {
          files.add(rel);
        }
      }
      moments.push({
        session: c.session,
        turn: Number(turnNo),
        agent: agent ? agent.id : null,
        agent_name: agent ? agent.name : null,
        at: list[0].at,
        until: list[list.length - 1].at,
        prompt: turn ? clip(turn.prompt, 300) : '',
        task: agent ? clip(agent.description, 120) : null,
        asks: dedupe(asks),
        said: dedupe(spoke).slice(0, 8),
        reports: dedupe(reports).slice(-4),
        edits: edits.map((e) => ({
          at: e.at,
          rel: e.rel,
          tool: e.tool,
          stats: e.stats,
          lines: e.lines,
        })),
        commits: commits.map((e) => e.sha.slice(0, 11)),
        checks: list
          .filter((e) => e.type === 'check')
          .map((e) => ({ at: e.at, category: e.category, ok: e.ok, command: e.command })),
        shell: list
          .filter((e) => e.type === 'shell')
          .map((e) => ({ at: e.at, rels: e.rels, command: e.command })),
        files: [...files].filter((rel) => range.final.has(rel)),
        lines: Object.fromEntries(Object.entries(lines).map(([rel, rs]) => [rel, mergeRanges(rs)])),
      });
      for (const e of commits) {
        const bc = base.commits.find((x) => x.sha === e.sha);
        if (bc && !bc.made_in) {
          bc.made_in = {
            session: c.session,
            turn: Number(turnNo),
            agent: agent ? agent.id : null,
            agent_name: agent ? agent.name : null,
            at: e.at,
          };
        }
      }
    }
  }
  moments.sort((a, b) => ms(a.at) - ms(b.at));
  moments.forEach((m, i) => {
    m.id = `m${i + 1}`;
  });
  const files = {};
  for (const rel of range.final.keys()) {
    files[rel] = {
      moments: [],
      commits: range.commits.filter((c) => c.files.includes(rel)).map((c) => c.short),
      lines: [],
    };
  }
  for (const m of moments) {
    for (const rel of m.files) {
      if (files[rel] && !files[rel].moments.includes(m.id)) {
        files[rel].moments.push(m.id);
      }
    }
    for (const [rel, rs] of Object.entries(m.lines)) {
      if (files[rel]) {
        for (const [s, e] of rs) {
          files[rel].lines.push({ start: s, end: e, moment: m.id });
        }
      }
    }
  }
  const unmatched = Object.keys(files).filter((rel) => !files[rel].moments.length);
  return {
    ...base,
    found: moments.length > 0,
    sessions,
    moments,
    files,
    unmatched,
    timeline: draftTimeline(moments),
  };
}

function mergeRanges(rs) {
  const sorted = rs.map((r) => [...r]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 2) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push(r);
    }
  }
  return out;
}

/** A first draft of the chronological view, one entry per moment. The story writer rewrites the text. */
function draftTimeline(moments) {
  return moments.map((m) => {
    const ask = m.asks.find((a) => a.who === 'user') || m.asks[0];
    const did = [
      m.edits.length ? `${m.edits.length} edit${m.edits.length === 1 ? '' : 's'}` : '',
      m.shell.length ? `${m.shell.length} scripted change${m.shell.length === 1 ? '' : 's'}` : '',
      m.commits.length ? `commit${m.commits.length === 1 ? '' : 's'} ${m.commits.join(', ')}` : '',
      m.checks.length
        ? `${m.checks.length} check${m.checks.length === 1 ? '' : 's'} (${m.checks.filter((c) => c.ok === false).length} failed)`
        : '',
    ]
      .filter(Boolean)
      .join(', ');
    return {
      at: m.at,
      title: m.task || clip(m.prompt, 60) || 'Work in this session',
      asked: ask ? clip(ask.text, 280) : '',
      text: did ? `${did[0].toUpperCase()}${did.slice(1)}.` : '',
      files: m.files,
      session: m.session,
      turn: m.turn,
      agent: m.agent_name || m.agent,
      moment: m.id,
    };
  });
}

/** What Claude reads to write the backstory: the evidence, without the line indexes. */
export function briefOf(b) {
  return {
    found: b.found,
    reason: b.reason || null,
    window: b.window,
    commits: b.commits.map((c) => ({
      short: c.short,
      at: c.at,
      subject: c.subject,
      files: c.files.length,
      made_in: c.made_in,
    })),
    sessions: b.sessions.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, agents: s.agents })),
    moments: b.moments.map((m) => ({
      id: m.id,
      at: m.at,
      until: m.until,
      session: m.session.slice(0, 8),
      turn: m.turn,
      agent: m.agent_name || m.agent,
      task: m.task,
      asks: m.asks.map((a) => `[${a.at.slice(11, 16)}Z ${a.via}] ${a.text}`),
      said: m.said.map((s) => `[${s.at.slice(11, 16)}Z] ${s.text}`),
      reports: m.reports.map((r) => `[${r.at.slice(11, 16)}Z] ${r.text}`),
      edits: m.edits.map(
        (e) =>
          `${e.rel} ${e.tool} +${e.stats ? e.stats.added : 0}/-${e.stats ? e.stats.removed : 0}${e.lines.length ? ` lines ${e.lines.map((r) => r.join('-')).join(',')}` : ''}`,
      ),
      commits: m.commits,
      checks: m.checks.map((c) => `${c.ok === false ? 'FAIL' : 'ok'} ${c.category}: ${c.command}`),
      shell: m.shell.length,
      files: m.files.length,
    })),
    unmatched: b.unmatched,
  };
}
