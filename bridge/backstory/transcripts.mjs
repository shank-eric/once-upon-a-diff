/*
 * Claude Code transcripts: finding the sessions (and subagents) that mention
 * the range, and reading the context session-story's extractor doesn't keep:
 * what the user said (prompts, and voice through Larmor), the tasks and
 * follow-ups the main session sent each agent, the agents' hand-back
 * reports, what Claude said aloud, and messages from other sessions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './text.mjs';

export const defaultClaudeDir = () => path.join(HOME, '.claude', 'projects');

function* transcriptFiles(claudeDir, sinceMs) {
  let projects = [];
  try {
    projects = readdirSync(claudeDir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
  } catch {
    return;
  }
  for (const project of projects) {
    const pdir = path.join(claudeDir, project.name);
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
          project: project.name,
          session: e.name.slice(0, -6),
          agent: null,
        };
      }
      if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try {
          subs = readdirSync(sub).filter((name) => name.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const name of subs) {
          yield {
            file: path.join(sub, name),
            project: project.name,
            session: e.name,
            agent: name.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
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
  for (const root of range.roots) {
    needles.add(root);
    if (root.startsWith(HOME)) {
      needles.add('~' + root.slice(HOME.length));
    }
  }
  for (const commit of range.commits) {
    needles.add(commit.sha.slice(0, 9));
  }
  const out = new Map();
  for (const transcript of transcriptFiles(claudeDir, sinceMs)) {
    let stats;
    try {
      stats = statSync(transcript.file);
    } catch {
      continue;
    }
    if (stats.mtimeMs < sinceMs) {
      continue;
    }
    let text;
    try {
      text = readFileSync(transcript.file, 'utf8');
    } catch {
      continue;
    }
    if (![...needles].some((needle) => text.includes(needle))) {
      continue;
    }
    const main = path.join(claudeDir, transcript.project, `${transcript.session}.jsonl`);
    if (!existsSync(main)) {
      continue;
    }
    const candidate = out.get(transcript.session) || {
      session: transcript.session,
      project: transcript.project,
      transcript: main,
      agents: [],
    };
    if (transcript.agent) {
      candidate.agents.push(transcript.agent);
    }
    out.set(transcript.session, candidate);
  }
  for (const candidate of out.values()) {
    candidate.cwd = sessionCwd(candidate.transcript);
  }
  return [...out.values()].filter((candidate) => candidate.cwd);
}

function sessionCwd(file) {
  const text = readFileSync(file, 'utf8');
  let i = 0;
  for (const line of text.split('\n')) {
    if (++i > 400) {
      break;
    }
    try {
      const record = JSON.parse(line);
      if (record.cwd) {
        return record.cwd;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// A message from another Claude Code session (SendMessage across sessions) starts a turn like a
// prompt, but the harness records it as a meta user record, so session-story's extractor skips it.
// A session driven only by such messages would come out with no turns at all.
export const isPeer = (record) =>
  record &&
  record.type === 'user' &&
  record.isMeta &&
  record.origin &&
  record.origin.kind === 'peer';
export const peerText = (record) =>
  String(record.origin.body || textOf(record.message && record.message.content) || '').trim();

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
/** A message's text: the string itself, or its text blocks joined. */
export function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('');
}
/** A tool result's text, from a string or text parts. */
function resultText(block) {
  if (typeof block.content === 'string') {
    return block.content;
  }
  if (!Array.isArray(block.content)) {
    return '';
  }
  return block.content.map((part) => part.text || '').join('');
}
const SAID_RE =
  /the user said(?: \(by voice\))?:\s*\\?n?\s*\\?"?([\s\S]*?)\\?"?\s*(?:\\n|\n)\s*This will NOT come through/;
const isNoise = (text) =>
  !text || /^\(silence\)$/i.test(text) || /^MCP tool "larmor\/listen" is still running/.test(text);

/** Main transcript: what the user said, what Claude said aloud, and what the main session sent agents. */
export function mainContext(file) {
  const names = new Map(); // tool_use id -> tool name
  const ctx = { heard: [], spoke: [], spawned: [], sent: [], prompts: [], peers: [] };
  for (const record of records(file)) {
    const recordedAt = record.timestamp;
    const content = record.message && record.message.content;
    if (isPeer(record)) {
      ctx.peers.push({
        at: recordedAt,
        from: record.origin.name || 'another session',
        text: peerText(record),
      });
      continue;
    }
    if (
      record.type === 'user' &&
      !record.isMeta &&
      typeof content === 'string' &&
      !/^<(command|local-command|system-reminder)/.test(content.trim())
    ) {
      ctx.prompts.push({ at: recordedAt, text: content.trim() });
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block) {
        continue;
      }
      if (block.type === 'text' && record.type === 'user') {
        const match = /\[Larmor\] While you were working, the user said[^:]*:\s*([\s\S]*)/.exec(
          block.text || '',
        );
        if (match) {
          ctx.heard.push({
            at: recordedAt,
            text: match[1].trim().replace(/^"|"$/g, ''),
            via: 'voice',
          });
        } else if (
          !/^<(command|local-command|system-reminder)|^\[Request interrupted/.test(
            (block.text || '').trim(),
          ) &&
          !record.isMeta &&
          !record.toolUseResult
        ) {
          ctx.prompts.push({ at: recordedAt, text: (block.text || '').trim() });
        }
      }
      if (block.type === 'tool_use') {
        names.set(block.id, block.name);
        const inp = block.input || {};
        if (/larmor__speak$/.test(block.name)) {
          ctx.spoke.push({ at: recordedAt, text: String(inp.text || inp.message || '') });
        }
        if (block.name === 'Agent' || block.name === 'Task') {
          ctx.spawned.push({
            at: recordedAt,
            id: block.id,
            name: inp.name || null,
            description: inp.description || '',
            text: String(inp.prompt || ''),
          });
        }
        if (block.name === 'SendMessage') {
          ctx.sent.push({ at: recordedAt, to: inp.to, text: String(inp.message || '') });
        }
      }
      if (block.type === 'tool_result') {
        const name = names.get(block.tool_use_id) || '';
        const txt = resultText(block);
        if (/larmor__listen$/.test(name)) {
          let heardText = txt;
          try {
            heardText = JSON.parse(txt).result ?? txt;
          } catch {
            /* plain text */
          }
          heardText = String(heardText).replace(/^\(you were cut off mid-sentence\)\s*/, '');
          if (!isNoise(heardText)) {
            ctx.heard.push({ at: recordedAt, text: heardText, via: 'voice' });
          }
        } else if (/the user said/.test(txt)) {
          const match = SAID_RE.exec(txt);
          if (match) {
            ctx.heard.push({
              at: recordedAt,
              text: match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim(),
              via: 'voice',
            });
          }
        }
      }
    }
  }
  ctx.prompts = ctx.prompts.filter(
    (prompt) =>
      prompt.text &&
      prompt.text.length > 8 &&
      !/^<|^Caveat:/.test(prompt.text) &&
      !/^(voice (on|off)|call listen|next|yes|ok)\.?$/i.test(prompt.text.trim()),
  );
  return ctx;
}

/** Subagent transcript: its task, the follow-ups it got and what it handed back. */
export function agentContext(file) {
  const ctx = { task: null, followups: [], reports: [], meta: {} };
  try {
    ctx.meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    /* older harness */
  }
  for (const record of records(file)) {
    const recordedAt = record.timestamp;
    const content = record.message && record.message.content;
    if (record.type === 'user' && !record.toolUseResult) {
      const text = textOf(content).trim();
      if (text && !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text)) {
        if (!ctx.task) {
          ctx.task = { at: recordedAt, text: text };
        } else {
          ctx.followups.push({
            at: recordedAt,
            text: text.replace(/<\/?system-reminder[^>]*>/g, '').trim(),
          });
        }
      }
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name === 'SubagentHandback') {
          ctx.reports.push({ at: recordedAt, text: String((block.input || {}).message || '') });
        }
        if (
          block &&
          block.type === 'text' &&
          record.type === 'user' &&
          /The coordinator sent a message/.test(block.text || '')
        ) {
          ctx.followups.push({
            at: recordedAt,
            text: block.text.replace(/<\/?system-reminder[^>]*>/g, '').trim(),
          });
        }
      }
    }
  }
  return ctx;
}
