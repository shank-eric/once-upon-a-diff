/*
 * session-story's extractor, through its CLI (`story.mjs extract --no-chain`,
 * never modified, never imported), which links each turn of a session to its
 * edits and commands, subagents included.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './text.mjs';
import { isPeer, peerText } from './transcripts.mjs';

export const defaultSessionStory = () =>
  process.env.SESSION_STORY_DIR || path.join(HOME, '.claude', 'skills', 'session-story');

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
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isPeer(record)) {
      return line;
    }
    peers++;
    const { isMeta, ...rest } = record;
    void isMeta;
    return JSON.stringify({
      ...rest,
      message: { ...(record.message || {}), role: 'user', content: peerText(record) },
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
