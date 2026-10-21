/*
 * Turning one session's evidence into moments: one per (turn, agent), with
 * what was asked (a prompt, a task, a message, what the user said by voice or
 * another session sent), what Claude said aloud, the agents' reports, and
 * the edits, commits, checks and lines that came of it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MIN, clip, toMillis } from './text.mjs';
import { rangesFor, mergeRanges } from './range.mjs';
import { agentContext } from './transcripts.mjs';

const did = (e) =>
  e.type === 'edit' || e.type === 'commit' || (e.type === 'shell' && e.rels.length);
const whoOf = (e) => e.agent || 'main';
const byTime = (first, second) => toMillis(first.at) - toMillis(second.at);

/**
 * The evidence that belongs in the story. An agent (or the main session) that only looked at the checkout is not part
 * of it, and a turn of one that did counts only if it did something to the range in that turn.
 */
export function keptEvidence(evidence) {
  const doers = new Set(evidence.filter(did).map(whoOf));
  const kept = evidence.filter((e) => doers.has(whoOf(e)) && e.type !== 'look');
  const doingTurns = new Set(kept.filter(did).map((e) => `${e.turn}:${whoOf(e)}`));
  for (let i = kept.length - 1; i >= 0; i--) {
    if (!doingTurns.has(`${kept[i].turn}:${whoOf(kept[i])}`)) {
      kept.splice(i, 1);
    }
  }
  return { kept, doers };
}

/** The session's agents that did something: their names, descriptions, transcripts' context and spawn calls. */
export function agentsOf(doers, candidate, main) {
  const agentDir = path.join(path.dirname(candidate.transcript), candidate.session, 'subagents');
  const agents = {};
  for (const id of doers) {
    if (id === 'main') {
      continue;
    }
    const file = path.join(agentDir, `agent-${id}.jsonl`);
    const context = existsSync(file)
      ? agentContext(file)
      : { task: null, followups: [], reports: [], meta: {} };
    const spawn = main.spawned.find(
      (spawned) =>
        (context.meta.toolUseId && spawned.id === context.meta.toolUseId) ||
        (context.meta.name && spawned.name === context.meta.name),
    );
    agents[id] = {
      id,
      name: context.meta.name || (spawn && spawn.name) || null,
      description: context.meta.description || (spawn && spawn.description) || '',
      ctx: context,
      spawn,
    };
  }
  return agents;
}

/** The session as the backstory lists it. */
export function sessionEntry(candidate, story, agents) {
  return {
    id: candidate.session,
    cwd: candidate.cwd,
    project: candidate.project,
    title: story.session.ai_title || story.session.title || null,
    started_at: story.session.started_at,
    ended_at: story.session.ended_at,
    transcript: candidate.transcript,
    resume: `claude --resume ${candidate.session}`,
    agents: Object.fromEntries(
      Object.values(agents).map((agent) => [
        agent.id,
        { name: agent.name, description: agent.description },
      ]),
    ),
  };
}

/** The kept evidence by "<turn>:<agent or main>", in the order first seen. */
export function groupByTurn(kept) {
  const groups = new Map();
  for (const e of kept) {
    const key = `${e.turn}:${whoOf(e)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(e);
  }
  return groups;
}

/** What an agent was asked (its task, the main session's messages, what the user said just before) and reported. */
function agentAsks(agent, main, near) {
  const asks = [];
  const reports = [];
  const name = agent.name;
  if (agent.ctx.task && near(agent.ctx.task.at, 20 * MIN, 0)) {
    asks.push({ at: agent.ctx.task.at, via: 'task', text: clip(agent.ctx.task.text, 900) });
  }
  for (const sent of main.sent) {
    if (name && sent.to === name && near(sent.at, 20 * MIN, 15 * MIN)) {
      asks.push({ at: sent.at, via: 'message', text: clip(sent.text, 900) });
    }
  }
  for (const report of agent.ctx.reports) {
    if (near(report.at, 0, 30 * MIN)) {
      reports.push({ at: report.at, text: clip(report.text, 1600) });
    }
  }
  // what the user said just before the main session wrote to this agent
  const sends = asks.map((ask) => toMillis(ask.at));
  const justBefore = (said, window) =>
    sends.some((sentAt) => toMillis(said) <= sentAt && toMillis(said) >= sentAt - window);
  for (const heard of main.heard) {
    if (justBefore(heard.at, 3 * MIN)) {
      asks.push({ at: heard.at, via: 'voice', who: 'user', text: clip(heard.text, 500) });
    }
  }
  for (const prompt of main.prompts) {
    if (justBefore(prompt.at, 5 * MIN)) {
      asks.push({ at: prompt.at, via: 'prompt', who: 'user', text: clip(prompt.text, 500) });
    }
  }
  return { asks, spoke: [], reports };
}

/** What the main session was asked around this moment (voice, prompts, other sessions) and said aloud. */
function mainAsks(main, near, { turn, from, upTo }) {
  const asks = [];
  const spoke = [];
  for (const heard of main.heard) {
    if (near(heard.at, 6 * MIN, MIN / 2)) {
      asks.push({ at: heard.at, via: 'voice', who: 'user', text: clip(heard.text, 500) });
    }
  }
  for (const prompt of main.prompts) {
    if (near(prompt.at, 10 * MIN, 0)) {
      asks.push({ at: prompt.at, via: 'prompt', who: 'user', text: clip(prompt.text, 500) });
    }
  }
  // a message from another session: the one that started this turn, and any that came in during it.
  // Earlier ones started their own turns (often a read-only question), so they aren't this moment's ask.
  const turnAt = turn ? toMillis(turn.at) : from - 10 * MIN;
  for (const peer of main.peers) {
    if (toMillis(peer.at) >= turnAt - 5000 && toMillis(peer.at) <= upTo) {
      asks.push({ at: peer.at, via: 'peer', who: peer.from, text: clip(peer.text, 900) });
    }
  }
  for (const spoken of main.spoke) {
    if (near(spoken.at, 5 * MIN, 2 * MIN)) {
      spoke.push({ at: spoken.at, text: clip(spoken.text, 500) });
    }
  }
  return { asks, spoke, reports: [] };
}

/** Each text once, oldest first. */
const dedupe = (items) =>
  items
    .filter((item, i) => items.findIndex((other) => other.text === item.text) === i)
    .sort(byTime);

/** The line ranges a moment's edits and commits added, merged per file. */
function linesOf(edits, commits, range, index) {
  const lines = {};
  const addLines = (rel, ranges) => {
    if (ranges.length) {
      (lines[rel] ||= []).push(...ranges);
    }
  };
  for (const e of edits) {
    addLines(e.rel, e.lines);
  }
  for (const e of commits) {
    const madeCommit = range.commits.find((commit) => commit.sha === e.sha);
    if (madeCommit) {
      for (const rel of madeCommit.files) {
        addLines(rel, rangesFor(index, rel, madeCommit.added[rel] || []));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(lines).map(([rel, ranges]) => [rel, mergeRanges(ranges)]),
  );
}

/** One moment from one (turn, agent) group of evidence. Returns the moment and the agent it's for (null: main). */
export function momentOf({ candidate, key, list, story, agents, main, range, index }) {
  list.sort(byTime);
  const [turnNo, who] = key.split(':');
  const turn = story.turns.find((candidateTurn) => candidateTurn.index === Number(turnNo));
  const from = toMillis(list[0].at);
  const upTo = toMillis(list[list.length - 1].at);
  const near = (timestamp, before, after) => {
    const millis = toMillis(timestamp);
    return millis >= from - before && millis <= upTo + after;
  };
  const agent = who === 'main' ? null : agents[who];
  const { asks, spoke, reports } = agent
    ? agentAsks(agent, main, near)
    : mainAsks(main, near, { turn, from, upTo });
  const edits = list.filter((e) => e.type === 'edit');
  const commits = list.filter((e) => e.type === 'commit');
  const files = new Set([...edits.map((e) => e.rel), ...list.flatMap((e) => e.rels || [])]);
  for (const e of commits) {
    const madeCommit = range.commits.find((commit) => commit.sha === e.sha) || { files: [] };
    for (const rel of madeCommit.files) {
      files.add(rel);
    }
  }
  const moment = {
    session: candidate.session,
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
    lines: linesOf(edits, commits, range, index),
  };
  return { moment, agent };
}

/** Each file of the diff: the moments that touched it, its commits, and its line ranges by moment. */
export function filesOf(range, moments) {
  const files = {};
  for (const rel of range.final.keys()) {
    files[rel] = {
      moments: [],
      commits: range.commits
        .filter((commit) => commit.files.includes(rel))
        .map((commit) => commit.short),
      lines: [],
    };
  }
  for (const moment of moments) {
    for (const rel of moment.files) {
      if (files[rel] && !files[rel].moments.includes(moment.id)) {
        files[rel].moments.push(moment.id);
      }
    }
    for (const [rel, ranges] of Object.entries(moment.lines)) {
      if (files[rel]) {
        for (const [start, end] of ranges) {
          files[rel].lines.push({ start, end, moment: moment.id });
        }
      }
    }
  }
  return files;
}
