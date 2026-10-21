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
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN, toMillis } from './text.mjs';
import { readRange, finalLineIndex } from './range.mjs';
import { candidateSessions, mainContext, defaultClaudeDir } from './transcripts.mjs';
import { extractSession, defaultSessionStory } from './extractor.mjs';
import { evidenceFromStory } from './evidence.mjs';
import { draftTimeline } from './timeline.mjs';
import {
  keptEvidence,
  agentsOf,
  sessionEntry,
  groupByTurn,
  momentOf,
  filesOf,
} from './moments.mjs';

export { readRange } from './range.mjs';
export { candidateSessions, defaultClaudeDir } from './transcripts.mjs';
export { extractSession, defaultSessionStory } from './extractor.mjs';
export { briefOf } from './timeline.mjs';

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
  const times = range.commits
    .flatMap((commit) => [toMillis(commit.authored), toMillis(commit.at)])
    .filter(Number.isFinite);
  const win = {
    start: opts.since
      ? toMillis(opts.since)
      : (times.length ? Math.min(...times) : Date.now()) - 24 * 60 * MIN,
    end: opts.until
      ? toMillis(opts.until)
      : (times.length ? Math.max(...times) : Date.now()) + 45 * MIN,
  };
  const base = {
    repo: range.top,
    base: range.base,
    head: range.head,
    base_oid: range.baseOid,
    head_oid: range.headOid,
    window: { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() },
    commits: range.commits.map((commit) => ({
      sha: commit.sha,
      short: commit.short,
      at: commit.at,
      subject: commit.subject,
      files: commit.files,
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
    `${cands.length} candidate session(s): ${cands.map((candidate) => candidate.session.slice(0, 8)).join(', ') || 'none'}`,
  );
  const sessions = [];
  const moments = [];
  for (const candidate of cands) {
    let story;
    try {
      story = extractSession({
        sessionStory,
        session: candidate.session,
        cwd: candidate.cwd,
        claudeDir,
        work,
        project: candidate.project,
        transcript: candidate.transcript,
      });
    } catch (e) {
      log(
        `  ${candidate.session.slice(0, 8)}: the extractor failed (${String(e.stderr || e.message)
          .trim()
          .split('\n')
          .pop()})`,
      );
      continue;
    }
    const evidence = evidenceFromStory(story, range, win, index).filter(
      (e) => !exclude.has(e.agent),
    );
    const { kept, doers } = keptEvidence(evidence);
    if (!kept.length) {
      log(`  ${candidate.session.slice(0, 8)}: no edits, commits or checks in range`);
      continue;
    }
    const main = mainContext(candidate.transcript);
    const agents = agentsOf(doers, candidate, main);
    sessions.push(sessionEntry(candidate, story, agents));
    // one moment per (turn, agent): a prompt or a task, and what came of it
    for (const [key, list] of groupByTurn(kept)) {
      const { moment, agent } = momentOf({
        candidate,
        key,
        list,
        story,
        agents,
        main,
        range,
        index,
      });
      moments.push(moment);
      for (const e of list.filter((item) => item.type === 'commit')) {
        const baseCommit = base.commits.find((commit) => commit.sha === e.sha);
        if (baseCommit && !baseCommit.made_in) {
          baseCommit.made_in = {
            session: candidate.session,
            turn: moment.turn,
            agent: agent ? agent.id : null,
            agent_name: agent ? agent.name : null,
            at: e.at,
          };
        }
      }
    }
  }
  moments.sort((first, second) => toMillis(first.at) - toMillis(second.at));
  moments.forEach((moment, i) => {
    moment.id = `m${i + 1}`;
  });
  const files = filesOf(range, moments);
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
